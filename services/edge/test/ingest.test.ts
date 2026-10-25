/**
 * The D1 indexer, against a local D1 (Miniflare) and the in-memory chain the Postgres indexer's tests use:
 * backfill, idempotence, reorgs, confirmations, CRE vs fallback provenance, live-update rows, the cursor guard
 * for concurrent writers, and bounded batches.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToHex as hex } from 'viem';
import { compile, dec, EXAMPLE_PRODUCTS, evmCoreLength, instantiateProduct, parseBpmn } from '@sn/core';
import { bytesToHex, noteView, type NoteState } from '@sn/sdk';
import { FakeChain, type FakeEvent } from '../../indexer/test/fake-chain';
import { Store } from '../src/d1';
import { D1Ingestor } from '../src/ingest';
import { loadDef, loadNote } from '../src/project';
import { localD1 } from './d1';

const ENGINE = '0x00000000000000000000000000000000000000e1' as const;
const ISSUER = '0x00000000000000000000000000000000000000b1';
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000a2';
const FALLBACK = '0x00000000000000000000000000000000000000f9';
const FORWARDER = '0x00000000000000000000000000000000000000f0';
const ZERO = '0x0000000000000000000000000000000000000000';

const prod = instantiateProduct(EXAMPLE_PRODUCTS.phoenix);
const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
const coreLen = evmCoreLength(c.bytes);
const defId = bytesToHex(c.hash);
const field = (n: string) => c.def.fields.findIndex((f) => f.name === n);
const NOTE = 'local:' + ENGINE + ':1';

const registered: FakeEvent = {
  eventName: 'DefinitionRegistered',
  args: { id: defId, creator: ISSUER, pointer: ZERO, meta: hex(c.bytes.subarray(coreLen)) },
};
const started = (pid = 1n): FakeEvent => ({
  eventName: 'ProcessStarted',
  args: {
    pid,
    definition: defId,
    creator: ISSUER,
    ref: pid,
    roles: [ISSUER, ISSUER, ZERO],
    assetTokens: [ZERO, '0x00000000000000000000000000000000000000c1'],
  },
});
const num = (f: string, v: bigint, pid = 1n): FakeEvent => ({
  eventName: 'FieldSet',
  args: { pid, field: field(f), tag: 1, value: `0x${BigInt.asUintN(256, v).toString(16).padStart(64, '0')}` },
});
const hold = (owner: string, asset: number, units: number, pid = 1n): FakeEvent => ({
  eventName: 'HoldingChanged',
  args: { pid, asset, owner, balance: dec(units) },
});
const tokens = (t: number[], status = 0, pid = 1n): FakeEvent => ({
  eventName: 'TokensUpdated',
  args: { pid, status, stepsRun: 1, tokens: t },
});

let d1: Awaited<ReturnType<typeof localD1>>;
let store: Store;
let chain: FakeChain;
let ing: D1Ingestor;
const cfg = { key: 'local', family: 'evm' as const, chainId: 998, rpc: '', engine: ENGINE, startBlock: 1 };

beforeEach(async () => {
  d1 = await localD1();
  store = new Store(d1.db);
  chain = new FakeChain();
  chain.cores.set(defId, hex(c.bytes.subarray(0, coreLen)));
  ing = new D1Ingestor(store, cfg, chain);
  await ing.init();
}, 30_000);
afterEach(async () => {
  await d1.dispose();
});

function issueAndSubscribe() {
  chain.mine([registered]); // 1
  chain.mine([started(), num('notional', dec(1000)), hold(ISSUER, 0, 1000), tokens([c.stepIndex.Task_Subscribe])]); // 2
  chain.mine([hold(ISSUER, 0, 400), hold(ALICE, 0, 600)]); // 3
}

const state = async () => (await loadNote(store, NOTE)) as NoteState;
const count = async (sql: string) => Number((await store.first<{ n: number }>(sql))!.n);

describe('D1 indexer', () => {
  it('backfills from the start block into the read model and decodes the definition', async () => {
    issueAndSubscribe();
    await ing.catchUp();
    const s = await state();
    expect(s.holdings).toEqual([
      { asset: 0, owner: ALICE, balance: dec(600).toString() },
      { asset: 0, owner: ISSUER, balance: dec(400).toString() },
    ]);
    const def = await loadDef(store, 'local', defId);
    expect(def?.name).toBe(c.def.name);
    expect(noteView(def!, s, 0).sold).toBe(600);
    const row = await store.first<{ product_type: string; underlyings: string; window_open: number; last_seq: number }>(
      'SELECT product_type, underlyings, window_open, last_seq FROM notes WHERE id = ?1',
      [NOTE],
    );
    expect({ ...row, underlyings: JSON.parse(row!.underlyings) }).toMatchObject({
      product_type: 'phoenix',
      underlyings: ['ETH'],
      window_open: 1,
    });
    expect(row!.last_seq).toBe(await count(`SELECT max(seq) AS n FROM events WHERE note_id = '${NOTE}'`));
    expect(await store.all('SELECT symbol FROM note_underlyings WHERE note_id = ?1', [NOTE])).toEqual([
      { symbol: 'ETH' },
    ]);
    expect((await store.first<{ owner: string }>('SELECT owner FROM holdings WHERE owner = ?1', [ALICE]))!.owner).toBe(
      ALICE,
    );
  });

  it('is idempotent: re-ingesting the same blocks changes nothing', async () => {
    issueAndSubscribe();
    await ing.catchUp();
    const before = { s: await state(), n: await count('SELECT count(*) AS n FROM events') };
    await store.run("UPDATE chains SET cursor = 0 WHERE chain = 'local'");
    await store.run("DELETE FROM blocks WHERE chain = 'local'");
    await ing.catchUp();
    expect(await state()).toEqual(before.s);
    expect(await count('SELECT count(*) AS n FROM events')).toBe(before.n);
  });

  it('undoes a reorg: orphaned events are removed and the note is rebuilt from the new chain', async () => {
    issueAndSubscribe();
    await ing.catchUp();
    expect((await state()).holdings.find((h) => h.owner === ALICE)).toBeTruthy();
    chain.reorg(3n, [[], [hold(ISSUER, 0, 750), hold(BOB, 0, 250)]]);
    const r = await ing.step();
    expect(r.reorgedTo).toBe(2);
    await ing.catchUp();
    expect((await state()).holdings).toEqual([
      { asset: 0, owner: BOB, balance: dec(250).toString() },
      { asset: 0, owner: ISSUER, balance: dec(750).toString() },
    ]);
    expect(await store.all('SELECT owner FROM holdings WHERE owner = ?1', [ALICE])).toEqual([]);
    expect(
      (await store.all<{ block: number }>('SELECT DISTINCT block FROM events ORDER BY block')).map((b) => b.block),
    ).toEqual([1, 2, 4]);
  });

  it('undoes a reorg that removes the note itself', async () => {
    issueAndSubscribe();
    await ing.catchUp();
    chain.reorg(2n, [[], [], []]);
    await ing.catchUp();
    expect(await loadNote(store, NOTE)).toBeNull();
    expect(await count('SELECT count(*) AS n FROM note_underlyings')).toBe(0);
  });

  it('stays `confirmations` blocks behind the head', async () => {
    const deep = new D1Ingestor(store, { ...cfg, key: 'deep', confirmations: 2 }, chain);
    await deep.init();
    issueAndSubscribe();
    await deep.catchUp();
    expect(
      Number((await store.first<{ cursor: number }>("SELECT cursor FROM chains WHERE chain = 'deep'"))!.cursor),
    ).toBe(1);
  });

  it('tells CRE reports from fallback ones, by the fallback reporter in force at the time', async () => {
    issueAndSubscribe();
    const report = (reporter: string): FakeEvent => ({
      eventName: 'ReportProcessed',
      args: { pid: 1n, step: c.stepIndex.Task_FixStrike, values: [dec(2500)], reporter },
    });
    chain.mine([report(FORWARDER)]);
    chain.mine([{ eventName: 'FallbackReporterUpdated', args: { previous: ZERO, next: FALLBACK } }, report(FALLBACK)]);
    await ing.catchUp();
    expect((await state()).reports).toEqual({ cre: 1, fallback: 1, last: 'fallback' });
    expect(
      (await store.first<{ fallback_reporter: string }>("SELECT fallback_reporter FROM chains WHERE chain = 'local'"))!
        .fallback_reporter,
    ).toBe(FALLBACK);
  });

  it('records the notes that changed for live updates', async () => {
    issueAndSubscribe();
    await ing.catchUp();
    const rows = await store.all<{ chain: string; note_id: string }>('SELECT chain, note_id FROM changes ORDER BY seq');
    expect(rows).toContainEqual({ chain: 'local', note_id: NOTE });
  });

  it('refuses a definition whose bytes do not hash to its id, and commits nothing', async () => {
    chain.cores.set(defId, '0x00');
    chain.mine([registered]);
    await expect(ing.step()).rejects.toThrow(/does not hash/);
    expect(await count('SELECT count(*) AS n FROM events')).toBe(0);
    expect(
      Number((await store.first<{ cursor: number }>("SELECT cursor FROM chains WHERE chain = 'local'"))!.cursor),
    ).toBe(0);
  });

  it('a second writer whose cursor moved commits nothing (the batch guard rolls it back)', async () => {
    issueAndSubscribe();
    // Simulate a concurrent cron that already ingested: move the cursor under this step after it has read it.
    const real = store.batch.bind(store);
    store.batch = async (stmts) => {
      await d1.db.prepare("UPDATE chains SET cursor = 2 WHERE chain = 'local'").run();
      return real(stmts);
    };
    const r = await ing.step();
    store.batch = real;
    expect(r.raced).toBe(true);
    expect(await count('SELECT count(*) AS n FROM events')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM notes')).toBe(0);
  });

  it('bounds a batch by events and notes, stopping at a block boundary', async () => {
    chain.mine([registered]);
    // 40 notes, one block each: with maxNotes 10 the first step takes 10 blocks' worth (plus the definition).
    for (let p = 1n; p <= 40n; p++) chain.mine([started(p), num('notional', dec(100), p), hold(ISSUER, 0, 100, p)]);
    const small = new D1Ingestor(store, { ...cfg, key: 'small' }, chain, { maxEvents: 1000, maxNotes: 10 });
    await small.init();
    const first = await small.step();
    expect(first.notes.length).toBeLessThanOrEqual(10);
    expect(first.to).toBeLessThan(41);
    await small.catchUp();
    expect(await count("SELECT count(*) AS n FROM notes WHERE chain = 'small'")).toBe(40);
  });

  it('writes a book of 62 holders within the 100-parameter limit', async () => {
    chain.mine([registered]);
    const evs: FakeEvent[] = [started(), num('notional', dec(6200))];
    for (let i = 0; i < 62; i++) evs.push(hold(`0x${(0xa000 + i).toString(16).padStart(40, '0')}`, 0, 100));
    chain.mine(evs);
    await ing.catchUp();
    expect(await count(`SELECT count(*) AS n FROM holdings WHERE note_id = '${NOTE}'`)).toBe(62);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToHex as hex } from 'viem';
import { compile, dec, EXAMPLE_PRODUCTS, evmCoreLength, instantiateProduct, parseBpmn } from '@sn/core';
import { bytesToHex, noteView, type NoteState } from '@sn/sdk';
import { migrate, pgliteDb, type Db } from '../src';
import { Ingestor, NOTIFY_CHANNEL } from '../src/ingest';
import { loadDef, loadNote } from '../src/project';
import { FakeChain, type FakeEvent } from './fake-chain';

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
const started: FakeEvent = {
  eventName: 'ProcessStarted',
  args: {
    pid: 1n,
    definition: defId,
    creator: ISSUER,
    ref: 1n,
    roles: [ISSUER, ISSUER, ZERO],
    assetTokens: [ZERO, '0x00000000000000000000000000000000000000c1'],
  },
};
const num = (f: string, v: bigint): FakeEvent => ({
  eventName: 'FieldSet',
  args: { pid: 1n, field: field(f), tag: 1, value: `0x${BigInt.asUintN(256, v).toString(16).padStart(64, '0')}` },
});
const hold = (owner: string, asset: number, units: number): FakeEvent => ({
  eventName: 'HoldingChanged',
  args: { pid: 1n, asset, owner, balance: dec(units) },
});
const tokens = (t: number[], status = 0): FakeEvent => ({
  eventName: 'TokensUpdated',
  args: { pid: 1n, status, stepsRun: 1, tokens: t },
});

let db: Db;
let chain: FakeChain;
let ing: Ingestor;
const cfg = { key: 'local', family: 'evm' as const, chainId: 998, rpc: '', engine: ENGINE, startBlock: 1 };

beforeEach(async () => {
  db = await pgliteDb();
  await migrate(db);
  chain = new FakeChain();
  chain.cores.set(defId, hex(c.bytes.subarray(0, coreLen)));
  ing = new Ingestor(db, cfg, chain);
  await ing.init();
});
afterEach(async () => {
  await db.close();
});

function issueAndSubscribe() {
  chain.mine([registered]); // 1
  chain.mine([started, num('notional', dec(1000)), hold(ISSUER, 0, 1000), tokens([c.stepIndex.Task_Subscribe])]); // 2
  chain.mine([hold(ISSUER, 0, 400), hold(ALICE, 0, 600)]); // 3
}

const state = async () => (await loadNote(db, NOTE)) as NoteState;

describe('indexer', () => {
  it('backfills from the start block into the read model and decodes the definition', async () => {
    issueAndSubscribe();
    await ing.catchUp();
    const s = await state();
    expect(s.holdings).toEqual([
      { asset: 0, owner: ALICE, balance: dec(600).toString() },
      { asset: 0, owner: ISSUER, balance: dec(400).toString() },
    ]);
    const def = await loadDef(db, 'local', defId);
    expect(def?.name).toBe(c.def.name);
    const v = noteView(def!, s, 0);
    expect(v.sold).toBe(600);
    const [row] = await db.query<{ product_type: string; underlyings: string[]; window_open: boolean }>(
      'SELECT product_type, underlyings, window_open FROM notes WHERE id = $1',
      [NOTE],
    );
    expect(row).toEqual({ product_type: 'phoenix', underlyings: ['ETH'], window_open: true });
    const [h] = await db.query<{ owner: string }>('SELECT owner FROM holdings WHERE owner = $1', [ALICE]);
    expect(h.owner).toBe(ALICE);
  });

  it('is idempotent: re-ingesting the same blocks changes nothing', async () => {
    issueAndSubscribe();
    await ing.catchUp();
    const before = { s: await state(), n: (await db.query('SELECT count(*)::int AS n FROM events'))[0] };
    await db.query("UPDATE chains SET cursor = 0 WHERE chain = 'local'");
    await db.query("DELETE FROM blocks WHERE chain = 'local'");
    await ing.catchUp();
    expect(await state()).toEqual(before.s);
    expect((await db.query('SELECT count(*)::int AS n FROM events'))[0]).toEqual(before.n);
  });

  it('undoes a reorg: orphaned events are removed and the note is rebuilt from the new chain', async () => {
    issueAndSubscribe();
    await ing.catchUp();
    expect((await state()).holdings.find((h) => h.owner === ALICE)).toBeTruthy();
    // Block 3 (Alice's subscription) is replaced: Bob subscribed 250 instead, one block later.
    chain.reorg(3n, [[], [hold(ISSUER, 0, 750), hold(BOB, 0, 250)]]);
    const r = await ing.step();
    expect(r.reorgedTo).toBe(2n);
    await ing.catchUp();
    const s = await state();
    expect(s.holdings).toEqual([
      { asset: 0, owner: BOB, balance: dec(250).toString() },
      { asset: 0, owner: ISSUER, balance: dec(750).toString() },
    ]);
    expect(await db.query('SELECT owner FROM holdings WHERE owner = $1', [ALICE])).toEqual([]);
    const blocks = await db.query<{ block: string }>('SELECT DISTINCT block FROM events ORDER BY block');
    expect(blocks.map((b) => Number(b.block))).toEqual([1, 2, 4]);
  });

  it('undoes a reorg that removes the note itself', async () => {
    issueAndSubscribe();
    await ing.catchUp();
    chain.reorg(2n, [[], [], []]);
    await ing.catchUp();
    expect(await loadNote(db, NOTE)).toBeNull();
  });

  it('stays `confirmations` blocks behind the head', async () => {
    const deep = new Ingestor(db, { ...cfg, key: 'deep', confirmations: 2 }, chain);
    await deep.init();
    issueAndSubscribe();
    await deep.catchUp();
    const [row] = await db.query<{ cursor: string }>("SELECT cursor FROM chains WHERE chain = 'deep'");
    expect(Number(row.cursor)).toBe(1); // head 3, two confirmations
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
  });

  it('notifies listeners with the notes that changed', async () => {
    const got: string[] = [];
    const stop = await db.listen(NOTIFY_CHANNEL, (p) => got.push(p));
    issueAndSubscribe();
    await ing.catchUp();
    await new Promise((r) => setTimeout(r, 50));
    await stop();
    expect(got.map((g) => JSON.parse(g))).toContainEqual({ chain: 'local', notes: [NOTE] });
  });

  it('refuses a definition whose bytes do not hash to its id', async () => {
    chain.cores.set(defId, '0x00');
    chain.mine([registered]);
    await expect(ing.step()).rejects.toThrow(/does not hash/);
  });
});

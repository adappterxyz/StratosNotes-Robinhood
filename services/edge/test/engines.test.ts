/**
 * Two engines on one chain (FlowEngine v4 next to the v3 engine whose notes stay on it): each (chain, engine)
 * pair has its own cursor row, note ids keep the real chain key, an existing v3 row indexed under the chain key
 * is adopted (cursor, block hashes and events kept) and a reorg on one engine leaves the other's events alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToHex as hex, keccak256, toHex } from 'viem';
import { compile, dec, EXAMPLE_PRODUCTS, evmCoreLength, instantiateProduct, parseBpmn } from '@sn/core';
import { bytesToHex, noteId, type NoteState } from '@sn/sdk';
import type { ChainSource, RawLog } from '@sn/indexer/src/source';
import { encodeLog, FakeChain, type FakeEvent } from '../../indexer/test/fake-chain';
import { ApiConfig, indexerChains, parseEdgeConfig } from '../src/config';
import { Store } from '../src/d1';
import { D1Ingestor, type ChainConfig } from '../src/ingest';
import { loadNote } from '../src/project';
import { runCron } from '../src/scheduled';
import { createEdgeApp } from '../src/api';
import { localD1, MIGRATIONS } from './d1';
import { applyMigrations } from '../src/d1';

const V3 = '0x00000000000000000000000000000000000000e3' as const;
const V4 = '0x00000000000000000000000000000000000000e4' as const;
const ISSUER = '0x00000000000000000000000000000000000000b1';
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000a2';
const ZERO = '0x0000000000000000000000000000000000000000';

const prod = instantiateProduct(EXAMPLE_PRODUCTS.phoenix);
const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
const coreLen = evmCoreLength(c.bytes);
const defId = bytesToHex(c.hash);
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
const hold = (owner: string, asset: number, units: number, pid = 1n): FakeEvent => ({
  eventName: 'HoldingChanged',
  args: { pid, asset, owner, balance: dec(units) },
});

/** One chain, two engines: every block carries both engines' logs, with chain-wide log indexes. */
class SharedChain extends FakeChain {
  private owner = new WeakMap<FakeEvent, string>();
  mineBoth(evs: Partial<Record<string, FakeEvent[]>>, salt?: string) {
    const all: FakeEvent[] = [];
    for (const [engine, list] of Object.entries(evs))
      for (const e of list ?? []) {
        const copy = { ...e };
        this.owner.set(copy, engine);
        all.push(copy);
      }
    return this.mine(all, salt);
  }
  reorgBoth(from: bigint, blocks: Array<Partial<Record<string, FakeEvent[]>>>) {
    this.blocks = this.blocks.slice(0, Number(from));
    for (const b of blocks) this.mineBoth(b, 'b');
  }
  view(engine: string): ChainSource {
    return {
      head: () => this.head(),
      finalized: () => this.finalized(),
      block: (n) => this.block(n),
      definitionCore: (id) => this.definitionCore(id),
      fallbackReporterAt: () => this.fallbackReporterAt(),
      logs: async (from, to) => {
        const out: RawLog[] = [];
        for (const b of this.blocks.slice(Number(from), Number(to) + 1)) {
          b.events.forEach((e, i) => {
            if (this.owner.get(e) !== engine) return;
            out.push({
              block: b.number,
              blockHash: b.hash,
              logIndex: i,
              tx: keccak256(toHex(`${b.hash}:tx`)),
              ...encodeLog(e),
            });
          });
        }
        return out;
      },
    };
  }
}

const base = { key: 'local', family: 'evm' as const, chainId: 998, rpc: 'http://127.0.0.1:1', startBlock: 1 };
const v3Id = (pid: bigint | number) => noteId('local', V3, BigInt(pid));
const v4Id = (pid: bigint | number) => noteId('local', V4, BigInt(pid));
const apiCfg = ApiConfig.parse({
  allowedOrigins: [],
  chains: [
    {
      key: 'local',
      rpc: 'http://127.0.0.1:1',
      engine: V4,
      lens: '0x00000000000000000000000000000000000000d4',
      fromBlock: 1,
      stablecoin: { symbol: 'USDG', address: '0x00000000000000000000000000000000000000c1', decimals: 6 },
      legacyEngines: [{ engine: V3, lens: '0x00000000000000000000000000000000000000d3', fromBlock: 1, version: 3 }],
    },
  ],
});
const edgeCfg = parseEdgeConfig({
  api: apiCfg,
  indexer: { chains: [{ ...base, engine: V4, legacyEngines: [{ engine: V3, startBlock: 1, version: 3 }] }] },
});

let d1: Awaited<ReturnType<typeof localD1>>;
let store: Store;
let chain: SharedChain;
const source = (cfg: ChainConfig) => chain.view(cfg.engine.toLowerCase());
const count = async (sql: string, p: unknown[] = []) => Number((await store.first<{ n: number }>(sql, p))!.n);
const rows = () =>
  store.all<{ chain: string; engine: string; cursor: number }>(
    'SELECT chain, engine, cursor FROM chains ORDER BY chain',
  );
async function catchUpAll(cfgs: ChainConfig[]) {
  for (const cfg of cfgs) {
    const i = new D1Ingestor(store, cfg, source(cfg));
    await i.init();
    await i.catchUp();
  }
}

beforeEach(async () => {
  d1 = await localD1();
  store = new Store(d1.db);
  chain = new SharedChain();
  chain.cores.set(defId, hex(c.bytes.subarray(0, coreLen)));
}, 30_000);
afterEach(async () => {
  await d1.dispose();
});

/** The v3 book (pid 1, Alice 600) and a v4 note with the same pid (Bob 250), in the same blocks. */
function bothBooks() {
  chain.mineBoth({ [V3]: [registered], [V4]: [registered] }); // 1
  chain.mineBoth({ [V3]: [started(), hold(ISSUER, 0, 1000)], [V4]: [started(), hold(ISSUER, 0, 500)] }); // 2
  chain.mineBoth({
    [V3]: [hold(ISSUER, 0, 400), hold(ALICE, 0, 600)],
    [V4]: [hold(ISSUER, 0, 250), hold(BOB, 0, 250)],
  }); // 3
}

describe('indexer config with earlier engines', () => {
  it('expands a chain into its earlier engines first (own row keys), then the current one', () => {
    const cfgs = indexerChains(edgeCfg);
    expect(
      cfgs.map((x) => ({ key: x.key, indexKey: x.indexKey, engine: x.engine.toLowerCase(), adoptFrom: x.adoptFrom })),
    ).toEqual([
      { key: 'local', indexKey: 'local-v3', engine: V3, adoptFrom: 'local' },
      { key: 'local', indexKey: 'local', engine: V4, adoptFrom: undefined },
    ]);
  });

  it('a chain without earlier engines is unchanged', () => {
    const cfgs = indexerChains(parseEdgeConfig({ api: apiCfg, indexer: { chains: [{ ...base, engine: V4 }] } }));
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0]).toMatchObject({ key: 'local', indexKey: 'local', engine: V4 });
  });
});

describe('two engines on one chain', () => {
  it('indexes both from scratch: one row each, note ids with the real chain key and each engine', async () => {
    bothBooks();
    await catchUpAll(indexerChains(edgeCfg));
    expect(await rows()).toEqual([
      { chain: 'local', engine: V4, cursor: 3 },
      { chain: 'local-v3', engine: V3, cursor: 3 },
    ]);
    const a = (await loadNote(store, v3Id(1))) as NoteState;
    const b = (await loadNote(store, v4Id(1))) as NoteState;
    expect(a).toMatchObject({ chain: 'local', engine: V3, pid: '1' });
    expect(b).toMatchObject({ chain: 'local', engine: V4, pid: '1' });
    expect(a.holdings.find((h) => h.owner === ALICE)?.balance).toBe(dec(600).toString());
    expect(b.holdings.find((h) => h.owner === BOB)?.balance).toBe(dec(250).toString());
    expect(await count("SELECT count(*) AS n FROM notes WHERE chain = 'local'")).toBe(2);
    // Every event knows its engine; the definition both engines registered is stored once.
    expect(await count('SELECT count(*) AS n FROM events WHERE engine IS NULL')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM events WHERE engine = ?1', [V3])).toBe(5);
    expect(await count('SELECT count(*) AS n FROM definitions')).toBe(1);
  });

  it('adopts a v3 row indexed under the chain key (before v4): same cursor, same note ids, no re-index', async () => {
    // The live D1 today: v3 indexed as `local`, by the previous build.
    chain.mineBoth({ [V3]: [registered] });
    chain.mineBoth({ [V3]: [started(), hold(ISSUER, 0, 1000)] });
    chain.mineBoth({ [V3]: [hold(ISSUER, 0, 400), hold(ALICE, 0, 600)] });
    const old = new D1Ingestor(store, { ...base, engine: V3 }, chain.view(V3));
    await old.init();
    await old.catchUp();
    const before = await loadNote(store, v3Id(1));
    const seqs = await store.all('SELECT seq, note_id FROM events ORDER BY seq');
    // Events the previous build wrote after migration 0004 have no engine.
    await store.run('UPDATE events SET engine = NULL');
    expect(await rows()).toEqual([{ chain: 'local', engine: V3, cursor: 3 }]);

    // v4 arrives: more blocks on both engines, then the new config.
    chain.mineBoth({
      [V4]: [registered, started(), hold(ISSUER, 0, 500)],
      [V3]: [hold(ALICE, 0, 550), hold(BOB, 0, 50)],
    }); // 4
    const r = await runCron({ store, config: edgeCfg, source, sender: null });
    expect(r.chains.map((x) => ({ chain: x.chain, error: x.error }))).toEqual([
      { chain: 'local-v3', error: undefined },
      { chain: 'local', error: undefined },
    ]);
    expect(await rows()).toEqual([
      { chain: 'local', engine: V4, cursor: 4 },
      { chain: 'local-v3', engine: V3, cursor: 4 },
    ]);
    // v3 history kept as it was (same seqs, same ids), the new block appended; the engine filled in.
    expect(await store.all('SELECT seq, note_id FROM events WHERE seq <= ?1 ORDER BY seq', [seqs.length])).toEqual(
      seqs,
    );
    expect(await count('SELECT count(*) AS n FROM events WHERE engine IS NULL')).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM blocks WHERE chain = ?1 AND number <= 3', ['local-v3']),
    ).toBeGreaterThan(0);
    const after = (await loadNote(store, v3Id(1))) as NoteState;
    expect(after.id).toBe(before!.id);
    expect(after.holdings.find((h) => h.owner === BOB)?.balance).toBe(dec(50).toString());
    expect((await loadNote(store, v4Id(1)))?.engine).toBe(V4);

    // Running again changes nothing (the adoption is done; no row moves).
    await runCron({ store, config: edgeCfg, source, sender: null });
    expect(await rows()).toEqual([
      { chain: 'local', engine: V4, cursor: 4 },
      { chain: 'local-v3', engine: V3, cursor: 4 },
    ]);
  });

  it('without the earlier engine in the config, the chain key still refuses a different engine', async () => {
    const old = new D1Ingestor(store, { ...base, engine: V3 }, chain.view(V3));
    await old.init();
    await expect(new D1Ingestor(store, { ...base, engine: V4 }, chain.view(V4)).init()).rejects.toThrow(
      /indexed for engine/,
    );
  });

  it("a reorg seen by one engine undoes only that engine's events", async () => {
    bothBooks();
    const cfgs = indexerChains(edgeCfg);
    const [legacy, current] = cfgs;
    const i3 = new D1Ingestor(store, legacy, source(legacy));
    const i4 = new D1Ingestor(store, current, source(current));
    await i3.init();
    await i4.init();
    await i3.catchUp();
    await i4.catchUp();
    // Block 3 is replaced: v3's events in it are re-mined the same, v4's change. Only v4 steps here.
    chain.reorgBoth(3n, [
      { [V3]: [hold(ISSUER, 0, 400), hold(ALICE, 0, 600)], [V4]: [hold(ISSUER, 0, 100), hold(BOB, 0, 400)] },
    ]);
    const r = await i4.step();
    expect(r.reorgedTo).toBe(2);
    // v3's block-3 events are still there (its own cursor will notice the new hash and redo them itself).
    expect(await count('SELECT count(*) AS n FROM events WHERE engine = ?1 AND block = 3', [V3])).toBe(2);
    expect((await loadNote(store, v3Id(1)))!.holdings.find((h) => h.owner === ALICE)).toBeTruthy();
    await i4.catchUp();
    expect((await loadNote(store, v4Id(1)))!.holdings.find((h) => h.owner === BOB)?.balance).toBe(dec(400).toString());
    await i3.catchUp();
    expect((await loadNote(store, v3Id(1)))!.holdings.find((h) => h.owner === ALICE)?.balance).toBe(
      dec(600).toString(),
    );
    expect(await count('SELECT count(*) AS n FROM definitions')).toBe(1);
  });

  it("the API serves both engines' notes and lists the earlier engine in /api/config", async () => {
    bothBooks();
    await catchUpAll(indexerChains(edgeCfg));
    const app = createEdgeApp({ store: () => store, config: apiCfg, ai: false });
    const list = (await (await app.request('/api/notes?chain=local&status=all')).json()) as {
      notes: Array<{ id: string }>;
    };
    expect(list.notes.map((n) => n.id).sort()).toEqual([v3Id(1), v4Id(1)].sort());
    const one = await app.request(`/api/notes/${encodeURIComponent(v3Id(1))}`);
    expect(one.status).toBe(200);
    const cfg = (await (await app.request('/api/config')).json()) as {
      chains: Array<{ engine: string; legacyEngines: Array<{ engine: string; lens: string; version: number }> }>;
    };
    expect(cfg.chains[0].engine).toBe(V4);
    expect(cfg.chains[0].legacyEngines).toEqual([
      {
        engine: V3,
        lens: '0x00000000000000000000000000000000000000d3',
        fromBlock: 1,
        version: 3,
        tokens: {},
        crossChain: null,
      },
    ]);
    const pf = (await (await app.request(`/api/portfolio/${ALICE}`)).json()) as { positions: Array<{ id: string }> };
    expect(pf.positions.map((p) => p.id)).toEqual([v3Id(1)]);
  });
});

describe('migration 0004', () => {
  it('gives every existing event the engine of its chain row, on a database written before it', async () => {
    const old = await localD1(MIGRATIONS.filter((m) => m.name < '0004'));
    try {
      const s = new Store(old.db);
      await s.run(
        "INSERT INTO chains (chain, family, chain_id, engine, start_block, cursor) VALUES ('arbitrum-sepolia', 'evm', 421614, ?1, 1, 9)",
        [V3],
      );
      await s.run(
        "INSERT INTO events (chain, block, block_hash, log_index, tx, ts, name, note_id, data) VALUES ('arbitrum-sepolia', 5, '0x01', 0, '0x02', 1, 'ProcessStarted', ?1, '{}')",
        [noteId('arbitrum-sepolia', V3, 2n)],
      );
      await applyMigrations(old.db, MIGRATIONS);
      expect(await s.all('SELECT engine, note_id FROM events')).toEqual([
        { engine: V3, note_id: 'arbitrum-sepolia:' + V3 + ':2' },
      ]);
      expect(await s.all("SELECT name FROM d1_migrations WHERE name LIKE '0004%'")).toEqual([
        { name: '0004_engines.sql' },
      ]);
    } finally {
      await old.dispose();
    }
  });
});

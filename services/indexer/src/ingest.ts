/**
 * Ingest one chain's engine events into the read model, safely:
 *
 *  - Depth: only blocks at least `confirmations` behind the head are read, or only finalized blocks when
 *    `finality: 'finalized'` (where the chain has a finalized tag).
 *  - Reorgs: before each batch the stored hash of the cursor block is compared with the chain. On a mismatch
 *    the indexer walks back through its stored block hashes to the last block both agree on, deletes every
 *    event after it, rebuilds the notes those events touched from the remaining log, and carries on from
 *    there. Within a batch, every block that produced events is re-read and must have the hash its logs
 *    reported, or the batch is dropped and retried.
 *  - Idempotence: events are keyed by (chain, block, log_index) and inserted if new; projections apply only
 *    the rows actually inserted. Re-ingesting a range, or two indexers racing, changes nothing.
 *  - Single writer per chain: each batch locks its chain row (SELECT … FOR UPDATE) and commits only if the
 *    cursor is still where the batch started.
 *  - Backfill: a new chain row starts at `startBlock - 1`, so the first batches replay history.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, decodeEngineLog, hexToBytes, hasPid, noteId, type EngineEvent } from '@sn/sdk';
import type { Db, Queryable } from './db';
import { applyNew, rebuildNote, type StoredEvent } from './project';
import type { ChainSource } from './source';

export interface ChainConfig {
  key: string;
  family: 'evm';
  chainId: number;
  rpc: string;
  engine: `0x${string}`;
  lens?: `0x${string}`;
  /** First block to index (the engine's deployment block). */
  startBlock: number;
  /** Blocks behind the head treated as settled (ignored with finality 'finalized'). */
  confirmations?: number;
  finality?: 'confirmations' | 'finalized';
  /** Most blocks per eth_getLogs call. */
  maxRange?: number;
  pollMs?: number;
}

export const NOTIFY_CHANNEL = 'sn_notes';
const ZERO = '0x0000000000000000000000000000000000000000';
/** Block hashes kept per chain for reorg checks (older ones are pruned). */
const KEEP_BLOCKS = 2048n;

export interface StepResult {
  from: bigint;
  to: bigint;
  events: number;
  notes: string[];
  reorgedTo?: bigint;
  idle?: boolean;
}

export class Ingestor {
  constructor(
    readonly db: Db,
    readonly cfg: ChainConfig,
    readonly src: ChainSource,
  ) {}

  private get chain() {
    return this.cfg.key;
  }
  private get engine() {
    return this.cfg.engine.toLowerCase();
  }

  /** Create the chain row on first run (cursor just before the start block). */
  async init() {
    const rows = await this.db.query<{ engine: string }>('SELECT engine FROM chains WHERE chain = $1', [this.chain]);
    if (rows.length) {
      if (rows[0].engine !== this.engine)
        throw new Error(
          `chain ${this.chain} is indexed for engine ${rows[0].engine}, not ${this.engine}: use a new chain key or reset it`,
        );
      return;
    }
    const start = BigInt(this.cfg.startBlock);
    const fallback = await this.src.fallbackReporterAt(start - 1n);
    await this.db.query(
      'INSERT INTO chains (chain, family, chain_id, engine, start_block, cursor, fallback_reporter) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (chain) DO NOTHING',
      [this.chain, this.cfg.family, this.cfg.chainId, this.engine, start.toString(), (start - 1n).toString(), fallback],
    );
  }

  private async cursor(): Promise<{ cursor: bigint; fallback: string; start: bigint }> {
    const [r] = await this.db.query<{ cursor: string; fallback_reporter: string; start_block: string }>(
      'SELECT cursor, fallback_reporter, start_block FROM chains WHERE chain = $1',
      [this.chain],
    );
    return { cursor: BigInt(r.cursor), fallback: r.fallback_reporter, start: BigInt(r.start_block) };
  }

  /** The highest block treated as settled. */
  private async safeHead(): Promise<bigint> {
    if (this.cfg.finality === 'finalized') {
      const f = await this.src.finalized();
      if (f !== null) return f;
    }
    return (await this.src.head()) - BigInt(this.cfg.confirmations ?? 0);
  }

  /** Ingest the next batch (or undo a reorg). */
  async step(): Promise<StepResult> {
    const { cursor, start } = await this.cursor();
    // Reorg check: does the chain still have the block we last ingested?
    if (cursor >= start) {
      const [stored] = await this.db.query<{ hash: string }>(
        'SELECT hash FROM blocks WHERE chain = $1 AND number = $2',
        [this.chain, cursor.toString()],
      );
      if (stored) {
        const now = await this.src.block(cursor);
        if (!now || now.hash !== stored.hash) return this.rewind(cursor);
      }
    }
    const safe = await this.safeHead();
    if (safe <= cursor) return { from: cursor + 1n, to: cursor, events: 0, notes: [], idle: true };
    const to = safe < cursor + BigInt(this.cfg.maxRange ?? 2000) ? safe : cursor + BigInt(this.cfg.maxRange ?? 2000);
    const from = cursor + 1n;
    const logs = await this.src.logs(from, to);

    // Each block with events must still have the hash its logs carry; the batch end's hash is recorded too.
    const blocks = new Map<bigint, { hash: string; ts: number }>();
    for (const n of new Set([...logs.map((l) => l.block), to])) {
      const b = await this.src.block(n);
      if (!b) throw new Error(`block ${n} not available on ${this.chain}`);
      blocks.set(n, b);
    }
    for (const l of logs) {
      if (blocks.get(l.block)!.hash !== l.blockHash)
        throw new Error(`reorg during batch at block ${l.block} on ${this.chain}; retrying`);
    }

    // Definitions registered in this batch: fetch their CORE now (outside the transaction).
    const cores = new Map<string, string>();
    const decoded: Array<{ l: (typeof logs)[number]; e: EngineEvent }> = [];
    let fallback = (await this.cursor()).fallback;
    for (const l of logs) {
      const e = decodeEngineLog(l, (r) => r === fallback && fallback !== ZERO);
      if (!e) continue;
      if (e.name === 'FallbackReporterUpdated') fallback = e.next;
      if (e.name === 'DefinitionRegistered' && !cores.has(e.id)) cores.set(e.id, await this.src.definitionCore(e.id));
      decoded.push({ l, e });
    }

    const notes = await this.db.tx(async (q) => {
      const [row] = await q.query<{ cursor: string }>('SELECT cursor FROM chains WHERE chain = $1 FOR UPDATE', [
        this.chain,
      ]);
      if (BigInt(row.cursor) !== cursor) return null; // another writer moved on: drop this batch
      const inserted: StoredEvent[] = [];
      for (const { l, e } of decoded) {
        const nid = hasPid(e) ? noteId(this.chain, this.engine, e.pid) : null;
        const ts = blocks.get(l.block)!.ts;
        const r = await q.query<{ seq: string }>(
          `INSERT INTO events (chain, block, block_hash, log_index, tx, ts, name, note_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (chain, block, log_index) DO NOTHING RETURNING seq`,
          [this.chain, l.block.toString(), l.blockHash, l.logIndex, l.tx, ts, e.name, nid, JSON.stringify(e)],
        );
        if (r.length && hasPid(e)) inserted.push({ seq: Number(r[0].seq), noteId: nid, ts, data: e });
        if (r.length && e.name === 'DefinitionRegistered') await this.storeDefinition(q, e, cores.get(e.id)!, l.block);
      }
      const changed = await applyNew(q, this.chain, this.engine, inserted);
      for (const [n, b] of blocks) {
        await q.query(
          'INSERT INTO blocks (chain, number, hash, ts) VALUES ($1,$2,$3,$4) ON CONFLICT (chain, number) DO UPDATE SET hash = EXCLUDED.hash, ts = EXCLUDED.ts',
          [this.chain, n.toString(), b.hash, b.ts],
        );
      }
      await q.query('DELETE FROM blocks WHERE chain = $1 AND number < $2', [this.chain, (to - KEEP_BLOCKS).toString()]);
      await q.query(
        'UPDATE chains SET cursor = $2, head = $3, fallback_reporter = $4, updated_at = now() WHERE chain = $1',
        [this.chain, to.toString(), safe.toString(), fallback],
      );
      if (changed.length || inserted.length) await this.notify(q, changed);
      return changed;
    });
    if (notes === null) return { from, to: cursor, events: 0, notes: [] };
    return { from, to, events: decoded.length, notes };
  }

  private async storeDefinition(
    q: Queryable,
    e: Extract<EngineEvent, { name: 'DefinitionRegistered' }>,
    core: string,
    block: bigint,
  ) {
    const bytes = new Uint8Array([...hexToBytes(core), ...hexToBytes(e.meta)]);
    if (bytesToHex(sha256(bytes)) !== e.id) throw new Error(`definition ${e.id} does not hash to its id`);
    let name = '';
    try {
      name = (JSON.parse(new TextDecoder().decode(hexToBytes(e.meta))) as { name?: string }).name ?? '';
    } catch {
      /* unnamed */
    }
    await q.query(
      'INSERT INTO definitions (chain, id, creator, bytes, name, block) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (chain, id) DO NOTHING',
      [this.chain, e.id, e.creator, bytes, name, block.toString()],
    );
  }

  /** The chain no longer has block `at` as we saw it: find the last common block and undo everything after. */
  private async rewind(at: bigint): Promise<StepResult> {
    const stored = await this.db.query<{ number: string; hash: string }>(
      'SELECT number, hash FROM blocks WHERE chain = $1 AND number <= $2 ORDER BY number DESC',
      [this.chain, at.toString()],
    );
    const { start } = await this.cursor();
    let ancestor = start - 1n; // nothing in common within the kept window: rebuild from the start
    for (const b of stored) {
      const now = await this.src.block(BigInt(b.number));
      if (now && now.hash === b.hash) {
        ancestor = BigInt(b.number);
        break;
      }
    }
    const changed = await this.db.tx(async (q) => {
      await q.query('SELECT cursor FROM chains WHERE chain = $1 FOR UPDATE', [this.chain]);
      const gone = await q.query<{ note_id: string | null }>(
        'DELETE FROM events WHERE chain = $1 AND block > $2 RETURNING note_id',
        [this.chain, ancestor.toString()],
      );
      await q.query('DELETE FROM definitions WHERE chain = $1 AND block > $2', [this.chain, ancestor.toString()]);
      await q.query('DELETE FROM blocks WHERE chain = $1 AND number > $2', [this.chain, ancestor.toString()]);
      const notes = [...new Set(gone.map((g) => g.note_id).filter((x): x is string => !!x))];
      for (const id of notes) await rebuildNote(q, this.chain, this.engine, id);
      // The fallback reporter in force at the ancestor: the last update left in the log, else as of the start.
      const [last] = await q.query<{ data: { next: string } | string }>(
        "SELECT data FROM events WHERE chain = $1 AND name = 'FallbackReporterUpdated' ORDER BY block DESC, log_index DESC LIMIT 1",
        [this.chain],
      );
      const fallback = last
        ? typeof last.data === 'string'
          ? JSON.parse(last.data).next
          : last.data.next
        : await this.src.fallbackReporterAt(start - 1n);
      await q.query('UPDATE chains SET cursor = $2, fallback_reporter = $3, updated_at = now() WHERE chain = $1', [
        this.chain,
        ancestor.toString(),
        fallback,
      ]);
      await this.notify(q, notes);
      return notes;
    });
    return { from: ancestor + 1n, to: ancestor, events: 0, notes: changed, reorgedTo: ancestor };
  }

  private async notify(q: Queryable, notes: string[]) {
    // NOTIFY payloads are capped at 8000 bytes: name the notes when few, else say "everything on this chain".
    const payload = JSON.stringify(
      notes.length <= 40 ? { chain: this.chain, notes } : { chain: this.chain, all: true },
    );
    await q.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, payload]);
  }

  /** Ingest until caught up. */
  async catchUp(maxSteps = 1000): Promise<StepResult[]> {
    const out: StepResult[] = [];
    for (let i = 0; i < maxSteps; i++) {
      const r = await this.step();
      out.push(r);
      if (r.idle) break;
    }
    return out;
  }
}

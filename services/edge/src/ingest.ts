/**
 * The indexer on D1: ingest one chain's engine events into the read model, run from the Worker's cron.
 *
 * Same guarantees as the Postgres indexer (services/indexer/src/ingest.ts), rebuilt for D1's model:
 *
 *  - Depth: only blocks at least `confirmations` behind the head, or only finalized blocks with
 *    `finality: 'finalized'`.
 *  - Atomicity: everything a batch changes (events, definitions, note projections, holdings, block hashes, the
 *    cursor, the live-update rows) is written by ONE `batch()`, which D1 runs as a transaction.
 *  - Single writer: the batch starts with a guard that the chain's cursor is still where this step read it. If a
 *    second cron invocation got there first, the guard fails and the whole batch rolls back: nothing changes.
 *  - Reorgs: before each batch the stored hash of the cursor block is compared with the chain; on a mismatch the
 *    indexer walks back through its stored hashes to the last block both agree on, and one guarded batch deletes
 *    everything after it and rewrites the affected notes, rebuilt in memory from the remaining events. Within a
 *    batch, every block with events is re-read and must still have the hash its logs carried.
 *  - Idempotence: events are inserted OR IGNORE on (chain, block, log_index); with the cursor guard, a range is
 *    never applied twice.
 *  - Bounded work: a step stops at a block boundary once it holds `maxEvents` events or touches `maxNotes`
 *    notes, so one batch stays well inside D1's per-invocation query budget and the 100-parameter limit.
 *  - Backfill: a new chain row starts at `startBlock - 1`.
 *  - Several engines per chain: each (chain, engine) pair has its own row in `chains`, under `indexKey` (the
 *    chain key for the current engine, e.g. `arbitrum-sepolia-v3` for an earlier one), with its own cursor,
 *    block hashes and fallback reporter. Note ids and every other table keep the real chain key, so a note's id
 *    is `<chain>:<engine>:<pid>` whichever engine runs it. `adoptFrom` moves an earlier engine's existing row
 *    (indexed under the chain key before the current engine arrived) to its own key, keeping its cursor and
 *    history.
 */
import { sha256 } from '@noble/hashes/sha256';
import {
  applyEvent,
  bytesToHex,
  decodeEngineLog,
  hasPid,
  hexToBytes,
  noteId,
  type EngineEvent,
  type NoteState,
} from '@sn/sdk';
import type { WorkflowDef } from '@sn/core';
import type { ChainSource, RawLog } from '@sn/indexer/src/source';
import { guard, insertRows, isGuardFailure, type D1PreparedStatement, type Store } from './d1';
import { loadDef, loadStates, noteStatements, parseState } from './project';

export interface ChainConfig {
  key: string;
  family: 'evm';
  chainId: number;
  rpc: string;
  engine: `0x${string}`;
  startBlock: number;
  confirmations?: number;
  finality?: 'confirmations' | 'finalized';
  maxRange?: number;
  /** The `chains` row this engine is indexed under (default: `key`). */
  indexKey?: string;
  /** The engine's version (3: an earlier engine whose notes stay on it; 4: current). Informational. */
  version?: number;
  /**
   * An earlier engine first indexed under another row key (the chain key): adopt that row, if it is still there
   * with this engine, instead of re-indexing from `startBlock`.
   */
  adoptFrom?: string;
}

export interface StepLimits {
  /** Events per batch (stops at a block boundary after this many). */
  maxEvents: number;
  /** Distinct notes per batch. */
  maxNotes: number;
}
export const DEFAULT_LIMITS: StepLimits = { maxEvents: 150, maxNotes: 25 };

const ZERO = '0x0000000000000000000000000000000000000000';
/** Block hashes kept per chain for reorg checks. */
const KEEP_BLOCKS = 2048;

export interface StepResult {
  from: number;
  to: number;
  events: number;
  notes: string[];
  reorgedTo?: number;
  idle?: boolean;
  raced?: boolean;
}

export class D1Ingestor {
  constructor(
    readonly store: Store,
    readonly cfg: ChainConfig,
    readonly src: ChainSource,
    readonly limits: StepLimits = DEFAULT_LIMITS,
  ) {}

  /** The real chain key: note ids, events, definitions and live-update rows. */
  private get chain() {
    return this.cfg.key;
  }
  /** The `chains` and `blocks` row key of this (chain, engine) pair. */
  private get rowKey() {
    return this.cfg.indexKey ?? this.cfg.key;
  }
  private get engine() {
    return this.cfg.engine.toLowerCase();
  }

  /** Create the chain row on first run (cursor just before the start block), or adopt the engine's earlier row. */
  async init() {
    const row = await this.store.first<{ engine: string }>('SELECT engine FROM chains WHERE chain = ?1', [this.rowKey]);
    if (row) {
      if (row.engine !== this.engine)
        throw new Error(
          `chain ${this.rowKey} is indexed for engine ${row.engine}, not ${this.engine}: use a new chain key or reset it`,
        );
      return;
    }
    if (this.cfg.adoptFrom && this.cfg.adoptFrom !== this.rowKey && (await this.adopt(this.cfg.adoptFrom))) return;
    const start = this.cfg.startBlock;
    const fallback = await this.src.fallbackReporterAt(BigInt(start - 1));
    await this.store.run(
      'INSERT INTO chains (chain, family, chain_id, engine, start_block, cursor, fallback_reporter) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (chain) DO NOTHING',
      [this.rowKey, this.cfg.family, this.cfg.chainId, this.engine, start, start - 1, fallback],
    );
  }

  /**
   * Move this engine's row from `from` (where it was indexed before another engine took that key) to its own key,
   * with its block hashes, in one guarded batch: only while `from` still names this engine, so a second cron
   * invocation (or one after the current engine created its row under `from`) changes nothing. Its events get
   * their engine (rows the previous build inserted after migration 0004). False when there is nothing to adopt.
   */
  private async adopt(from: string): Promise<boolean> {
    const old = await this.store.first<{ engine: string }>('SELECT engine FROM chains WHERE chain = ?1', [from]);
    if (!old || old.engine !== this.engine) return false;
    try {
      await this.store.batch([
        guard(this.store, 'SELECT engine FROM chains WHERE chain = ?1', [from], this.engine, 'adopted already'),
        this.store.stmt('UPDATE chains SET chain = ?2 WHERE chain = ?1 AND engine = ?3', [
          from,
          this.rowKey,
          this.engine,
        ]),
        this.store.stmt('UPDATE blocks SET chain = ?2 WHERE chain = ?1', [from, this.rowKey]),
        this.store.stmt('UPDATE events SET engine = ?2 WHERE chain = ?1 AND engine IS NULL', [this.chain, this.engine]),
      ]);
    } catch (e) {
      if (!isGuardFailure(e)) throw e;
    }
    return !!(await this.store.first('SELECT 1 AS ok FROM chains WHERE chain = ?1', [this.rowKey]));
  }

  private async row() {
    const r = await this.store.first<{ cursor: number; fallback_reporter: string; start_block: number }>(
      'SELECT cursor, fallback_reporter, start_block FROM chains WHERE chain = ?1',
      [this.rowKey],
    );
    if (!r) throw new Error(`chain ${this.rowKey} not initialised`);
    return { cursor: Number(r.cursor), fallback: r.fallback_reporter, start: Number(r.start_block) };
  }

  private async safeHead(): Promise<number> {
    if (this.cfg.finality === 'finalized') {
      const f = await this.src.finalized();
      if (f !== null) return Number(f);
    }
    return Number(await this.src.head()) - (this.cfg.confirmations ?? 0);
  }

  private cursorGuard(cursor: number) {
    return guard(this.store, 'SELECT cursor FROM chains WHERE chain = ?1', [this.rowKey], cursor, 'cursor moved');
  }

  /** Ingest the next batch (or undo a reorg). */
  async step(): Promise<StepResult> {
    const { cursor, start } = await this.row();
    if (cursor >= start) {
      const stored = await this.store.first<{ hash: string }>(
        'SELECT hash FROM blocks WHERE chain = ?1 AND number = ?2',
        [this.rowKey, cursor],
      );
      if (stored) {
        const now = await this.src.block(BigInt(cursor));
        // A load-balanced RPC can answer from a node that doesn't have the block yet: that is "try again later", not
        // a reorg. Only a different hash rewinds.
        if (!now) return { from: cursor + 1, to: cursor, events: 0, notes: [], idle: true };
        if (now.hash !== stored.hash) return this.rewind(cursor);
      }
    }
    const safe = await this.safeHead();
    if (safe <= cursor) return { from: cursor + 1, to: cursor, events: 0, notes: [], idle: true };
    const from = cursor + 1;
    let to = Math.min(safe, cursor + (this.cfg.maxRange ?? 2000));
    let logs = await this.src.logs(BigInt(from), BigInt(to));

    // Bound the batch: stop at the end of the block where the event or note budget runs out.
    const cut = this.cutPoint(logs);
    if (cut !== null && cut < to) {
      to = cut;
      logs = logs.filter((l) => Number(l.block) <= cut);
    }

    const blocks = new Map<number, { hash: string; ts: number }>();
    for (const n of new Set([...logs.map((l) => Number(l.block)), to])) {
      const b = await this.src.block(BigInt(n));
      if (!b) throw new Error(`block ${n} not available on ${this.chain}`);
      blocks.set(n, b);
    }
    for (const l of logs) {
      if (blocks.get(Number(l.block))!.hash !== l.blockHash)
        throw new Error(`reorg during batch at block ${l.block} on ${this.chain}; retrying`);
    }

    // Decode, tracking the fallback reporter so each report is tagged CRE or fallback as of its block.
    let fallback = (await this.row()).fallback;
    const decoded: Array<{ l: RawLog; e: EngineEvent }> = [];
    const freshDefs = new Map<string, string>(); // id -> CORE ‖ META hex
    const defRows: unknown[][] = [];
    for (const l of logs) {
      const e = decodeEngineLog(l, (r) => r === fallback && fallback !== ZERO);
      if (!e) continue;
      if (e.name === 'FallbackReporterUpdated') fallback = e.next;
      if (e.name === 'DefinitionRegistered' && !freshDefs.has(e.id)) {
        const core = await this.src.definitionCore(e.id);
        const bytes = new Uint8Array([...hexToBytes(core), ...hexToBytes(e.meta)]);
        if (bytesToHex(sha256(bytes)) !== e.id) throw new Error(`definition ${e.id} does not hash to its id`);
        let name = '';
        try {
          name = (JSON.parse(new TextDecoder().decode(hexToBytes(e.meta))) as { name?: string }).name ?? '';
        } catch {
          /* unnamed */
        }
        const hex = bytesToHex(bytes);
        freshDefs.set(e.id, hex);
        defRows.push([this.chain, e.id, e.creator, hex, name, Number(l.block)]);
      }
      decoded.push({ l, e });
    }

    // Events already stored (a replayed range, e.g. after an operator reset the cursor) are skipped by the
    // projection, so folding stays idempotent: only events new to the log change a note.
    const known = new Set(
      (decoded.length
        ? await this.store.all<{ block: number; log_index: number }>(
            'SELECT block, log_index FROM events WHERE chain = ?1 AND block BETWEEN ?2 AND ?3',
            [this.chain, from, to],
          )
        : []
      ).map((r) => `${r.block}:${r.log_index}`),
    );

    // Fold the new events into the notes they touch, in memory.
    const byNote = new Map<string, Array<{ l: RawLog; e: EngineEvent }>>();
    for (const d of decoded) {
      if (!hasPid(d.e) || known.has(`${Number(d.l.block)}:${d.l.logIndex}`)) continue;
      const id = noteId(this.chain, this.engine, d.e.pid);
      byNote.set(id, [...(byNote.get(id) ?? []), d]);
    }
    const states = await loadStates(this.store, [...byNote.keys()]);
    const stmts: D1PreparedStatement[] = [this.cursorGuard(cursor)];
    stmts.push(
      ...insertRows(
        this.store,
        'INSERT OR IGNORE INTO events (chain, block, block_hash, log_index, tx, ts, name, note_id, data, engine)',
        decoded.map(({ l, e }) => [
          this.chain,
          Number(l.block),
          l.blockHash,
          l.logIndex,
          l.tx,
          blocks.get(Number(l.block))!.ts,
          e.name,
          hasPid(e) ? noteId(this.chain, this.engine, e.pid) : null,
          JSON.stringify(e),
          this.engine,
        ]),
      ),
    );
    stmts.push(
      ...insertRows(this.store, 'INSERT OR IGNORE INTO definitions (chain, id, creator, bytes, name, block)', defRows),
    );
    for (const [id, evs] of byNote) {
      let s: NoteState | null = states.get(id) ?? null;
      for (const { l, e } of evs)
        s = applyEvent(s, e as never, { chain: this.chain, engine: this.engine, at: blocks.get(Number(l.block))!.ts });
      const def = s ? await loadDef(this.store, this.chain, s.definition, freshDefs) : null;
      stmts.push(...noteStatements(this.store, id, s, def, 'from-events'));
    }
    stmts.push(
      ...insertRows(
        this.store,
        'INSERT INTO blocks (chain, number, hash, ts)',
        [...blocks].map(([n, b]) => [this.rowKey, n, b.hash, b.ts]),
        'ON CONFLICT (chain, number) DO UPDATE SET hash = excluded.hash, ts = excluded.ts',
      ),
    );
    stmts.push(this.store.stmt('DELETE FROM blocks WHERE chain = ?1 AND number < ?2', [this.rowKey, to - KEEP_BLOCKS]));
    stmts.push(
      this.store.stmt(
        "UPDATE chains SET cursor = ?2, head = ?3, fallback_reporter = ?4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE chain = ?1",
        [this.rowKey, to, safe, fallback],
      ),
    );
    const changed = [...byNote.keys()];
    const at = Math.floor(Date.now() / 1000);
    stmts.push(
      ...insertRows(
        this.store,
        'INSERT INTO changes (chain, note_id, at)',
        changed.map((id) => [this.chain, id, at]),
      ),
    );

    try {
      await this.store.batch(stmts);
    } catch (e) {
      if (isGuardFailure(e)) return { from, to: cursor, events: 0, notes: [], raced: true };
      throw e;
    }
    return { from, to, events: decoded.length, notes: changed };
  }

  /** The last block to include so the batch stays within `limits` (null: everything fits). */
  private cutPoint(logs: RawLog[]): number | null {
    const notes = new Set<string>();
    let events = 0;
    let lastFull: number | null = null;
    for (let i = 0; i < logs.length; i++) {
      const b = Number(logs[i].block);
      events++;
      const pid = logs[i].topics[1];
      if (pid) notes.add(pid);
      const blockEnds = i === logs.length - 1 || Number(logs[i + 1].block) !== b;
      if (blockEnds) {
        if (events > this.limits.maxEvents || notes.size > this.limits.maxNotes) return lastFull ?? b; // at least one block
        lastFull = b;
      }
    }
    return null;
  }

  /** The chain no longer has block `at` as we saw it: find the last common block and undo everything after. */
  private async rewind(at: number): Promise<StepResult> {
    const stored = await this.store.all<{ number: number; hash: string }>(
      'SELECT number, hash FROM blocks WHERE chain = ?1 AND number <= ?2 ORDER BY number DESC LIMIT 256',
      [this.rowKey, at],
    );
    const { start, cursor } = await this.row();
    let ancestor = start - 1; // nothing in common within the kept window: rebuild from the start
    for (const b of stored) {
      const now = await this.src.block(BigInt(b.number));
      if (now && now.hash === b.hash) {
        ancestor = Number(b.number);
        break;
      }
    }
    // Only this engine's events: another engine on the same chain has its own cursor (and its own reorg check).
    const gone = await this.store.all<{ note_id: string }>(
      'SELECT DISTINCT note_id FROM events WHERE chain = ?1 AND engine = ?3 AND block > ?2 AND note_id IS NOT NULL',
      [this.chain, ancestor, this.engine],
    );
    const notes = gone.map((g) => g.note_id);

    const stmts: D1PreparedStatement[] = [this.cursorGuard(cursor)];
    stmts.push(
      this.store.stmt('DELETE FROM events WHERE chain = ?1 AND engine = ?3 AND block > ?2', [
        this.chain,
        ancestor,
        this.engine,
      ]),
    );
    // Definitions are content-addressed and shared by the chain's engines: drop one only if no engine still has
    // its registration (runs after the delete above, in the same transaction).
    stmts.push(
      this.store.stmt(
        "DELETE FROM definitions WHERE chain = ?1 AND block > ?2 AND id NOT IN (SELECT json_extract(data, '$.id') FROM events WHERE chain = ?1 AND name = 'DefinitionRegistered')",
        [this.chain, ancestor],
      ),
    );
    stmts.push(this.store.stmt('DELETE FROM blocks WHERE chain = ?1 AND number > ?2', [this.rowKey, ancestor]));
    for (const id of notes) {
      // Rebuild from the events that remain (block <= ancestor).
      const rows = await this.store.all<{ seq: number; ts: number; data: string }>(
        'SELECT seq, ts, data FROM events WHERE note_id = ?1 AND block <= ?2 ORDER BY block, log_index',
        [id, ancestor],
      );
      let s: NoteState | null = null;
      for (const r of rows)
        s = applyEvent(s, JSON.parse(r.data), { chain: this.chain, engine: this.engine, at: Number(r.ts) });
      let def: WorkflowDef | null = null;
      if (s) {
        const kept = await this.store.first<{ block: number }>(
          'SELECT block FROM definitions WHERE chain = ?1 AND id = ?2',
          [this.chain, s.definition],
        );
        def = kept && Number(kept.block) <= ancestor ? await loadDef(this.store, this.chain, s.definition) : null;
      }
      stmts.push(...noteStatements(this.store, id, s, def, rows.length ? Number(rows[rows.length - 1].seq) : 0));
    }
    const last = await this.store.first<{ data: string }>(
      "SELECT data FROM events WHERE chain = ?1 AND engine = ?3 AND name = 'FallbackReporterUpdated' AND block <= ?2 ORDER BY block DESC, log_index DESC LIMIT 1",
      [this.chain, ancestor, this.engine],
    );
    const fallback = last
      ? (JSON.parse(last.data) as { next: string }).next
      : await this.src.fallbackReporterAt(BigInt(start - 1));
    stmts.push(
      this.store.stmt(
        "UPDATE chains SET cursor = ?2, fallback_reporter = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE chain = ?1",
        [this.rowKey, ancestor, fallback],
      ),
    );
    const at2 = Math.floor(Date.now() / 1000);
    stmts.push(
      ...insertRows(
        this.store,
        'INSERT INTO changes (chain, note_id, at)',
        notes.map((id) => [this.chain, id, at2]),
      ),
    );
    try {
      await this.store.batch(stmts);
    } catch (e) {
      if (isGuardFailure(e)) return { from: cursor + 1, to: cursor, events: 0, notes: [], raced: true };
      throw e;
    }
    return { from: ancestor + 1, to: ancestor, events: 0, notes, reorgedTo: ancestor };
  }

  /** Ingest until caught up (tests; the cron uses `runChain` with a budget). */
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

export { parseState };

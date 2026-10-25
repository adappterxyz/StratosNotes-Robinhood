/**
 * Projections: fold stored events into `notes` and `holdings`. Incremental for new events; a full rebuild from
 * the event log for a note whose events were undone by a reorg.
 */
import { decodeEvmDef, type WorkflowDef } from '@sn/core';
import { applyEvent, noteView, termsOf, windowOpen, type NoteEvent, type NoteState } from '@sn/sdk';
import type { Queryable } from './db';

const defCache = new Map<string, WorkflowDef>();

export async function loadDef(q: Queryable, chain: string, id: string): Promise<WorkflowDef | null> {
  const key = `${chain}:${id}`;
  const hit = defCache.get(key);
  if (hit) return hit;
  const rows = await q.query<{ bytes: Uint8Array | Buffer }>(
    'SELECT bytes FROM definitions WHERE chain = $1 AND id = $2',
    [chain, id],
  );
  if (!rows.length) return null;
  const def = decodeEvmDef(new Uint8Array(rows[0].bytes));
  defCache.set(key, def);
  return def;
}

export async function saveNote(q: Queryable, s: NoteState, lastSeq: number) {
  const def = await loadDef(q, s.chain, s.definition);
  const terms = def ? termsOf(def) : null;
  const view = def ? noteView(def, s) : null;
  await q.query(
    `INSERT INTO notes (id, chain, engine, pid, definition, state, status, window_open, strike_date, product_type, underlyings,
                        name, label, issuer, created_at, updated_at, last_seq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, status = EXCLUDED.status, window_open = EXCLUDED.window_open,
       strike_date = EXCLUDED.strike_date, product_type = EXCLUDED.product_type, underlyings = EXCLUDED.underlyings,
       name = EXCLUDED.name, label = EXCLUDED.label, issuer = EXCLUDED.issuer, updated_at = EXCLUDED.updated_at,
       last_seq = EXCLUDED.last_seq`,
    [
      s.id,
      s.chain,
      s.engine,
      s.pid,
      s.definition,
      JSON.stringify(s),
      s.status,
      def ? windowOpen(def, s) : false,
      view?.strikeDate || null,
      terms?.hasTerms ? terms.params.productType : null,
      terms?.hasTerms ? terms.params.underlyings.map((u) => u.symbol) : [],
      view?.name ?? 'Unknown workflow',
      view?.label ?? 'Workflow',
      view?.issuer ?? s.creator,
      s.createdAt,
      s.updatedAt,
      lastSeq,
    ],
  );
  await q.query('DELETE FROM holdings WHERE note_id = $1', [s.id]);
  for (const h of s.holdings) {
    await q.query('INSERT INTO holdings (note_id, asset, owner, balance) VALUES ($1, $2, $3, $4)', [
      s.id,
      h.asset,
      h.owner,
      h.balance,
    ]);
  }
}

export async function loadNote(q: Queryable, id: string): Promise<NoteState | null> {
  const rows = await q.query<{ state: NoteState | string }>('SELECT state FROM notes WHERE id = $1', [id]);
  if (!rows.length) return null;
  const st = rows[0].state;
  return typeof st === 'string' ? (JSON.parse(st) as NoteState) : st;
}

export interface StoredEvent {
  seq: number;
  noteId: string | null;
  ts: number;
  data: NoteEvent;
}

/** Apply newly stored events (chain order) to their notes. Returns the notes changed. */
export async function applyNew(q: Queryable, chain: string, engine: string, events: StoredEvent[]): Promise<string[]> {
  const byNote = new Map<string, StoredEvent[]>();
  for (const e of events) if (e.noteId) byNote.set(e.noteId, [...(byNote.get(e.noteId) ?? []), e]);
  for (const [id, evs] of byNote) {
    let s = await loadNote(q, id);
    for (const e of evs) s = applyEvent(s, e.data, { chain, engine, at: e.ts });
    if (s) await saveNote(q, s, evs[evs.length - 1].seq);
  }
  return [...byNote.keys()];
}

/** Rebuild a note from its stored events (or remove it when its start was undone). */
export async function rebuildNote(q: Queryable, chain: string, engine: string, id: string) {
  await q.query('DELETE FROM holdings WHERE note_id = $1', [id]);
  await q.query('DELETE FROM notes WHERE id = $1', [id]);
  const rows = await q.query<{ seq: string; ts: string; data: NoteEvent | string }>(
    'SELECT seq, ts, data FROM events WHERE note_id = $1 ORDER BY block, log_index',
    [id],
  );
  let s: NoteState | null = null;
  for (const r of rows)
    s = applyEvent(s, typeof r.data === 'string' ? JSON.parse(r.data) : r.data, { chain, engine, at: Number(r.ts) });
  if (s) await saveNote(q, s, Number(rows[rows.length - 1].seq));
}

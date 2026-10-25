/**
 * Projections on D1: a note's row, holdings and underlyings, built from its NoteState as batch statements.
 *
 * On Postgres the indexer read a note, applied events and wrote it back inside one transaction. D1 has no
 * interactive transactions, so the ingest reads what it needs first, folds the events in memory, and writes the
 * results in one guarded batch (ingest.ts). These helpers build that batch's statements.
 */
import { decodeEvmDef, type WorkflowDef } from '@sn/core';
import { hexToBytes, noteView, termsOf, windowOpen, type NoteState } from '@sn/sdk';
import { chunks, insertRows, placeholders, type D1PreparedStatement, type Store } from './d1';

const defCache = new Map<string, WorkflowDef>();

/** A definition by id: from the per-isolate cache, from `fresh` (registered in the batch being built), or D1. */
export async function loadDef(
  store: Store,
  chain: string,
  id: string,
  fresh?: Map<string, string>,
): Promise<WorkflowDef | null> {
  const key = `${chain}:${id}`;
  const hit = defCache.get(key);
  if (hit) return hit;
  const hex =
    fresh?.get(id) ??
    (await store.first<{ bytes: string }>('SELECT bytes FROM definitions WHERE chain = ?1 AND id = ?2', [chain, id]))
      ?.bytes;
  if (!hex) return null;
  const def = decodeEvmDef(hexToBytes(hex));
  defCache.set(key, def);
  return def;
}

export const parseState = (s: NoteState | string): NoteState =>
  typeof s === 'string' ? (JSON.parse(s) as NoteState) : s;

/** Current states of `ids` (missing ones are absent from the map). */
export async function loadStates(store: Store, ids: string[]): Promise<Map<string, NoteState>> {
  const out = new Map<string, NoteState>();
  for (const part of chunks(ids)) {
    const rows = await store.all<{ id: string; state: string }>(
      `SELECT id, state FROM notes WHERE id IN (${placeholders(part.length)})`,
      part,
    );
    for (const r of rows) out.set(r.id, parseState(r.state));
  }
  return out;
}

export async function loadNote(store: Store, id: string): Promise<NoteState | null> {
  const r = await store.first<{ state: string }>('SELECT state FROM notes WHERE id = ?1', [id]);
  return r ? parseState(r.state) : null;
}

/**
 * Statements that replace a note's projection with `s` (or remove it when `s` is null). `lastSeq` is a number,
 * or SQL evaluated in the batch (after the batch's event inserts) when the sequence is not known yet.
 */
export function noteStatements(
  store: Store,
  id: string,
  s: NoteState | null,
  def: WorkflowDef | null,
  lastSeq: number | 'from-events',
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [
    store.stmt('DELETE FROM holdings WHERE note_id = ?1', [id]),
    store.stmt('DELETE FROM note_underlyings WHERE note_id = ?1', [id]),
  ];
  if (!s) {
    out.push(store.stmt('DELETE FROM notes WHERE id = ?1', [id]));
    return out;
  }
  const terms = def ? termsOf(def) : null;
  const view = def ? noteView(def, s) : null;
  const unds = terms?.hasTerms ? terms.params.underlyings.map((u) => u.symbol.toUpperCase()) : [];
  const seq = lastSeq === 'from-events' ? '(SELECT coalesce(max(seq), 0) FROM events WHERE note_id = ?1)' : '?17';
  out.push(
    store.stmt(
      `INSERT INTO notes (id, chain, engine, pid, definition, state, status, window_open, strike_date, product_type, underlyings,
                        name, label, issuer, created_at, updated_at, last_seq)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ${seq})
     ON CONFLICT (id) DO UPDATE SET state = excluded.state, status = excluded.status, window_open = excluded.window_open,
       strike_date = excluded.strike_date, product_type = excluded.product_type, underlyings = excluded.underlyings,
       name = excluded.name, label = excluded.label, issuer = excluded.issuer, updated_at = excluded.updated_at,
       last_seq = excluded.last_seq`,
      [
        id,
        s.chain,
        s.engine,
        s.pid,
        s.definition,
        JSON.stringify(s),
        s.status,
        def ? windowOpen(def, s) : false,
        view?.strikeDate || null,
        terms?.hasTerms ? terms.params.productType : null,
        JSON.stringify(unds),
        view?.name ?? 'Unknown workflow',
        view?.label ?? 'Workflow',
        view?.issuer ?? s.creator,
        s.createdAt,
        s.updatedAt,
        ...(lastSeq === 'from-events' ? [] : [lastSeq]),
      ],
    ),
  );
  out.push(
    ...insertRows(
      store,
      'INSERT INTO holdings (note_id, asset, owner, balance)',
      s.holdings.map((h) => [id, h.asset, h.owner, h.balance]),
    ),
  );
  out.push(
    ...insertRows(
      store,
      'INSERT OR IGNORE INTO note_underlyings (note_id, symbol)',
      unds.map((u) => [id, u]),
    ),
  );
  return out;
}

/**
 * The Node API's email alerts: the routes are shared with the Worker (@sn/notifier routes.ts); this module adds
 * the notifier tick over the Postgres read model.
 */
import { CHAINS, noteView, type NoteState } from '@sn/sdk';
import { loadDef, type Db } from '@sn/indexer';
import { drain, planNote, type NoteEvent } from '@sn/notifier';
import type { AlertsDeps } from '@sn/notifier';

export { alertsRoutes, emailHashOf, type AlertsDeps } from '@sn/notifier';

/**
 * One notifier pass: plan every note touched in the last two days (or still running), queue the emails meant for
 * verified addresses, send what is due. Returns counts for logs.
 */
export async function notifierTick(db: Db, deps: AlertsDeps, now: number, chainLabel: (key: string) => string) {
  const appUrl = `${deps.siteUrl.replace(/\/$/, '')}/app`;
  const rows = await db.query<{ id: string; chain: string; definition: string; state: NoteState | string }>(
    'SELECT id, chain, definition, state FROM notes WHERE status = 0 OR updated_at >= $1',
    [now - 2 * 86_400],
  );
  let queued = 0;
  for (const r of rows) {
    const s = typeof r.state === 'string' ? (JSON.parse(r.state) as NoteState) : r.state;
    const def = await loadDef(db, r.chain, r.definition);
    if (!def) continue;
    const evs = await db.query<{ seq: string; tx: string; ts: string; name: string; data: Record<string, unknown> }>(
      'SELECT seq, tx, ts, name, data FROM events WHERE note_id = $1 ORDER BY seq',
      [r.id],
    );
    const events: NoteEvent[] = evs.map((e) => ({
      seq: Number(e.seq),
      tx: e.tx,
      ts: Number(e.ts),
      name: e.name,
      data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data,
    }));
    const planned = planNote({
      noteId: r.id,
      chainLabel: chainLabel(r.chain),
      link: `${appUrl}/note/${encodeURIComponent(r.id)}`,
      def,
      state: s,
      view: noteView(def, s, now),
      events,
      now,
    });
    if (!planned.length) continue;
    const verified = new Set(
      (await deps.store.verified([...new Set(planned.map((p) => p.address))])).map((b) => b.address),
    );
    queued += await deps.store.enqueue(
      planned
        .filter((p) => verified.has(p.address))
        .map((p) => ({
          dedupe: p.dedupe,
          address: p.address,
          noteId: r.id,
          category: p.category,
          payload: { template: p.template, subject: p.subject, body: p.body, vars: p.vars },
          sendAfter: p.sendAfter,
          expiresAt: p.expiresAt,
        })),
      now,
    );
  }
  const sent = await drain(deps.store, deps.sender, {
    now,
    unsubscribeUrl: (t) => `${appUrl}/alerts/unsubscribe?token=${t}`,
  });
  return { notes: rows.length, queued, ...sent };
}

export const chainLabelOf = (key: string) => CHAINS[key]?.name ?? key;

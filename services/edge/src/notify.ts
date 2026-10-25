/**
 * Email alerts in the Worker: the notifier's store on D1, its sender on Cloudflare Email Service (the EMAIL
 * binding, sent directly, with no relay hop), and the notifier tick over the D1 read model.
 *
 * What to send (which events, which audience, which template) is decided by the BPMN notification declarations
 * through the notifier's pure functions (@sn/notifier planNote); delivery (drain) renders each email for its
 * recipient, sends it once and records the result. The outbox's dedupe key means a replayed event can never
 * queue a second copy. Without a sender (Email Sending off), queued rows stay pending until it is on.
 */
import { noteView, type NoteState } from '@sn/sdk';
import {
  AlertsStore,
  drain,
  EmailNotConfigured,
  EmailRejected,
  planNote,
  type DrainResult,
  type EmailSender,
  type NoteEvent,
  type Sql,
} from '@sn/notifier';
import type { Store } from './d1';
import { loadDef, parseState } from './project';

/** The Workers EMAIL binding (Cloudflare Email Service). */
export interface EmailBinding {
  send(m: {
    to: string;
    from: string | { email: string; name?: string };
    subject: string;
    html: string;
    text: string;
  }): Promise<{ messageId?: string } | void>;
}

/** The notifier's `Sql` on D1 (`?` placeholders, counted against the invocation's query budget). */
export function d1Sql(store: Store): Sql {
  return {
    all: (sql, params = []) => store.all(sql, params),
    run: async (sql, params = []) => {
      await store.run(sql, params);
    },
  };
}

export const alertsStore = (store: Store) => new AlertsStore(d1Sql(store));

/** Send through the EMAIL binding, as "notes.markets" <from>. A domain not (yet) onboarded holds the outbox. */
export function bindingSender(binding: EmailBinding, from: string): EmailSender {
  return {
    async send(e) {
      try {
        const r = await binding.send({
          to: e.to,
          from: { email: from, name: 'notes.markets' },
          subject: e.subject,
          html: e.html,
          text: e.text,
        });
        return { messageId: (r && 'messageId' in r && r.messageId) || '' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/E_SENDER_DOMAIN_NOT_AVAILABLE|E_ACCOUNT_SUSPENDED|not (onboarded|available)|paused/i.test(msg))
          throw new EmailNotConfigured(msg);
        if (/E_RECIPIENT|invalid (recipient|address)|rejected/i.test(msg)) throw new EmailRejected(msg);
        throw err;
      }
    },
  };
}

export interface TickResult extends Partial<DrainResult> {
  notes: number;
  queued: number;
}

/**
 * One notifier pass on D1: plan every note that is running or changed in the last two days, queue the emails
 * meant for verified addresses, then send what is due (when a sender is configured).
 */
export async function notifierTick(
  store: Store,
  opts: {
    sender: EmailSender | null;
    siteUrl: string;
    now: number;
    chainLabel: (key: string) => string;
    maxNotes?: number;
  },
): Promise<TickResult> {
  const alerts = alertsStore(store);
  const appUrl = `${opts.siteUrl.replace(/\/$/, '')}/app`;
  const rows = await store.all<{ id: string; chain: string; definition: string; state: string }>(
    'SELECT id, chain, definition, state FROM notes WHERE status = 0 OR updated_at >= ?1 ORDER BY updated_at DESC LIMIT ?2',
    [opts.now - 2 * 86_400, opts.maxNotes ?? 40],
  );
  let queued = 0;
  for (const r of rows) {
    const s: NoteState = parseState(r.state);
    const def = await loadDef(store, r.chain, r.definition);
    if (!def) continue;
    const evs = await store.all<{ seq: number; tx: string; ts: number; name: string; data: string }>(
      'SELECT seq, tx, ts, name, data FROM events WHERE note_id = ?1 ORDER BY seq',
      [r.id],
    );
    const events: NoteEvent[] = evs.map((e) => ({
      seq: Number(e.seq),
      tx: e.tx,
      ts: Number(e.ts),
      name: e.name,
      data: JSON.parse(e.data),
    }));
    const planned = planNote({
      noteId: r.id,
      chainLabel: opts.chainLabel(r.chain),
      link: `${appUrl}/note/${encodeURIComponent(r.id)}`,
      def,
      state: s,
      view: noteView(def, s, opts.now),
      events,
      now: opts.now,
    });
    if (!planned.length) continue;
    const verified = new Set(
      (await alerts.verified([...new Set(planned.map((p) => p.address))])).map((b) => b.address),
    );
    queued += await alerts.enqueue(
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
      opts.now,
    );
  }
  if (!opts.sender) return { notes: rows.length, queued };
  const sent = await drain(alerts, opts.sender, {
    now: opts.now,
    unsubscribeUrl: (t) => `${appUrl}/alerts/unsubscribe?token=${t}`,
    limit: 25,
  });
  return { notes: rows.length, queued, ...sent };
}

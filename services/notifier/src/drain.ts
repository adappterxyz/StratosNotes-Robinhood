/**
 * Send what is due from the outbox: render each email for its recipient (with their own unsubscribe link),
 * send it, and record the result. Pure apart from the store and sender it is given, so it runs in Node or in a
 * Worker cron. Retries with backoff; gives up after a few tries or once an email's moment has passed.
 */
import { NOTIFY_CATEGORIES } from '@sn/core';
import { EmailNotConfigured, EmailRejected, type EmailSender } from './sender';
import type { AlertsStore, OutboxRow, SentMessage } from './store';
import { maskEmail, render, templateFor, type Rendered, type Vars } from './templates';

export interface DrainResult {
  sent: number;
  skipped: number;
  failed: number;
  held: number;
  notConfigured: boolean;
}

const MAX_ATTEMPTS = 6;

/**
 * Keep the person's copy of an email (Alerts → Emails sent). Best effort, and only after the outbox row is settled:
 * a failure here (say, before the email_messages migration is applied) must never make an email go out twice.
 */
async function keepCopy(
  store: AlertsStore,
  row: OutboxRow,
  to: string,
  r: Rendered,
  status: SentMessage['status'],
  noteLabel: string | undefined,
  now: number,
  touched: Set<string>,
) {
  try {
    await store.record({
      dedupe: row.dedupe,
      address: row.address,
      noteId: row.noteId,
      noteLabel: noteLabel ?? null,
      category: row.category,
      recipient: maskEmail(to),
      subject: r.subject,
      html: r.html,
      text: r.text,
      status,
      createdAt: row.sendAfter,
      sentAt: now,
    });
    touched.add(row.address);
  } catch (e) {
    console.warn(JSON.stringify({ notifier: 'copy not kept', error: e instanceof Error ? e.message : String(e) }));
  }
}

export async function drain(
  store: AlertsStore,
  sender: EmailSender,
  opts: { now: number; unsubscribeUrl: (token: string) => string; limit?: number },
): Promise<DrainResult> {
  const res: DrainResult = { sent: 0, skipped: 0, failed: 0, held: 0, notConfigured: false };
  const rows = await store.due(opts.now, opts.limit ?? 50);
  const touched = new Set<string>();
  const bindings = new Map((await store.verified([...new Set(rows.map((r) => r.address))])).map((b) => [b.address, b]));
  for (const row of rows) {
    if (row.expiresAt !== null && opts.now >= row.expiresAt) {
      await store.settle(row.dedupe, 'expired', opts.now);
      res.skipped++;
      continue;
    }
    const b = bindings.get(row.address);
    const wants =
      b &&
      !b.unsubscribed &&
      b.email &&
      (row.category === 'account' ||
        ((NOTIFY_CATEGORIES as string[]).includes(row.category) && b.categories.includes(row.category)));
    if (!b || !wants) {
      await store.settle(row.dedupe, 'skipped', opts.now, undefined, b ? 'not wanted' : 'no verified email');
      res.skipped++;
      continue;
    }
    const p = JSON.parse(row.payload) as { template?: string; subject?: string; body?: string; vars: Vars };
    const t = templateFor(p.template, p);
    if (!t) {
      await store.settle(row.dedupe, 'failed', opts.now, undefined, 'unknown template');
      await keepCopy(
        store,
        row,
        b.email!,
        { subject: p.subject?.trim() || 'An alert that could not be written', html: '', text: '' },
        'failed',
        p.vars?.note,
        opts.now,
        touched,
      );
      res.failed++;
      continue;
    }
    const r = render(
      p.vars.reminder ? { ...t, subject: `Reminder: ${t.subject}` } : t,
      p.vars,
      opts.unsubscribeUrl(b.unsubscribeToken),
    );
    try {
      const { messageId } = await sender.send({ to: b.email!, ...r });
      await store.settle(row.dedupe, 'sent', opts.now, messageId);
      await keepCopy(store, row, b.email!, r, 'sent', p.vars.note, opts.now, touched);
      res.sent++;
    } catch (e) {
      if (e instanceof EmailNotConfigured) {
        // Hold everything (no attempt counted) until Email Sending is onboarded: check again in 10 minutes.
        await store.retry(row.dedupe, row.attempts, opts.now + 600, e.message);
        res.held++;
        res.notConfigured = true;
        continue;
      }
      const attempts = row.attempts + 1;
      if (e instanceof EmailRejected || attempts >= MAX_ATTEMPTS) {
        await store.settle(row.dedupe, 'failed', opts.now, undefined, e instanceof Error ? e.message : String(e));
        await keepCopy(store, row, b.email!, r, 'failed', p.vars.note, opts.now, touched);
        res.failed++;
      } else {
        await store.retry(
          row.dedupe,
          attempts,
          opts.now + 60 * 2 ** attempts,
          e instanceof Error ? e.message : String(e),
        );
        res.held++;
      }
    }
  }
  // Retention: the newest MESSAGES_KEPT copies per address (one trim per address per pass).
  for (const a of touched) await store.trimMessages(a).catch(() => undefined);
  return res;
}

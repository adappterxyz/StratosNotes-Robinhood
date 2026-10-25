/**
 * Email alerts storage: verified email bindings (with their salts and pending codes) and the notification outbox.
 *
 * Behind a small `Sql` surface with `?` placeholders and SQLite-compatible SQL (TEXT, BIGINT, INSERT … ON
 * CONFLICT … DO NOTHING / DO UPDATE SET … = excluded.…), so the same statements run on PostgreSQL today
 * (pgSql in the API) and on Cloudflare D1 later. Emails and salts live only here: never on-chain, never logged.
 */

export interface Sql {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

/** Adapt a Postgres-style client (`$1` placeholders) to `Sql`. */
export function pgSql(q: { query<T>(sql: string, params?: unknown[]): Promise<T[]> }): Sql {
  const conv = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  return {
    all: (sql, params = []) => q.query(conv(sql), params),
    run: async (sql, params = []) => {
      await q.query(conv(sql), params);
    },
  };
}

export const ALERTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS email_bindings (
    address          TEXT PRIMARY KEY,
    email            TEXT,
    salt             TEXT,
    email_hash       TEXT,
    categories       TEXT NOT NULL,
    verified_at      BIGINT,
    pending_email    TEXT,
    code_hash        TEXT,
    code_expires     BIGINT,
    code_attempts    BIGINT NOT NULL DEFAULT 0,
    link_token_hash  TEXT,
    unsubscribe_token TEXT NOT NULL,
    unsubscribed     BIGINT NOT NULL DEFAULT 0,
    created_at       BIGINT NOT NULL,
    updated_at       BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS email_bindings_link ON email_bindings (link_token_hash)`,
  `CREATE INDEX IF NOT EXISTS email_bindings_unsub ON email_bindings (unsubscribe_token)`,
  `CREATE TABLE IF NOT EXISTS email_outbox (
    dedupe        TEXT PRIMARY KEY,
    address       TEXT NOT NULL,
    note_id       TEXT,
    category      TEXT NOT NULL,
    payload       TEXT NOT NULL,
    send_after    BIGINT NOT NULL,
    expires_at    BIGINT,
    status        TEXT NOT NULL,
    attempts      BIGINT NOT NULL DEFAULT 0,
    next_at       BIGINT NOT NULL,
    message_id    TEXT,
    error         TEXT,
    created_at    BIGINT NOT NULL,
    sent_at       BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox (status, next_at)`,
  // A copy of every alert email as it was sent (or as it was when it failed for good), for the person's own
  // "Emails sent" list on Alerts. Keyed by the outbox dedupe key; the recipient is stored masked. The newest
  // MESSAGES_KEPT per address are kept (older ones are trimmed when a new one is recorded).
  `CREATE TABLE IF NOT EXISTS email_messages (
    dedupe        TEXT PRIMARY KEY,
    address       TEXT NOT NULL,
    note_id       TEXT,
    note_label    TEXT,
    category      TEXT NOT NULL,
    recipient     TEXT NOT NULL,
    subject       TEXT NOT NULL,
    html          TEXT NOT NULL,
    text          TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    BIGINT NOT NULL,
    sent_at       BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS email_messages_address ON email_messages (address, sent_at, dedupe)`,
];

/** How many sent emails are kept per address (the newest; older copies are deleted). */
export const MESSAGES_KEPT = 200;

export interface Binding {
  address: string;
  email: string | null;
  salt: string | null;
  emailHash: string | null;
  categories: string[];
  verifiedAt: number | null;
  pendingEmail: string | null;
  codeHash: string | null;
  codeExpires: number | null;
  codeAttempts: number;
  unsubscribeToken: string;
  unsubscribed: boolean;
}

export interface OutboxRow {
  dedupe: string;
  address: string;
  noteId: string | null;
  category: string;
  payload: string;
  sendAfter: number;
  expiresAt: number | null;
  attempts: number;
}

/** What one email to one address says (rendered at send time, with the recipient's unsubscribe link). */
export interface OutboxItem {
  dedupe: string;
  address: string;
  noteId: string | null;
  category: string;
  payload: unknown;
  sendAfter: number;
  expiresAt: number | null;
}

/** One email as the person got it (or as it was when sending failed for good). */
export interface SentMessage {
  dedupe: string;
  address: string;
  noteId: string | null;
  noteLabel: string | null;
  category: string;
  /** The recipient, masked (a•••@x.com). */
  recipient: string;
  subject: string;
  html: string;
  text: string;
  status: 'sent' | 'failed';
  createdAt: number;
  sentAt: number;
}

/** An email still waiting in the outbox (scheduled, or held until sending works again). */
export interface QueuedRow {
  dedupe: string;
  noteId: string | null;
  category: string;
  payload: string;
  sendAfter: number;
  nextAt: number;
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const toBinding = (r: Record<string, unknown>): Binding => ({
  address: String(r.address),
  email: (r.email as string) ?? null,
  salt: (r.salt as string) ?? null,
  emailHash: (r.email_hash as string) ?? null,
  categories: String(r.categories ?? '')
    .split(',')
    .filter(Boolean),
  verifiedAt: n(r.verified_at),
  pendingEmail: (r.pending_email as string) ?? null,
  codeHash: (r.code_hash as string) ?? null,
  codeExpires: n(r.code_expires),
  codeAttempts: Number(r.code_attempts ?? 0),
  unsubscribeToken: String(r.unsubscribe_token),
  unsubscribed: Number(r.unsubscribed ?? 0) === 1,
});

export class AlertsStore {
  constructor(private sql: Sql) {}

  async migrate() {
    for (const s of ALERTS_SCHEMA) await this.sql.run(s);
  }

  async binding(address: string): Promise<Binding | null> {
    const [r] = await this.sql.all('SELECT * FROM email_bindings WHERE address = ?', [address]);
    return r ? toBinding(r) : null;
  }

  /** Start (or restart) verification of `email` for `address`: a new code and link; the verified email, if any,
   *  stays in force until the new one is verified. */
  async startVerification(a: {
    address: string;
    email: string;
    categories: string[];
    codeHash: string;
    codeExpires: number;
    linkTokenHash: string;
    unsubscribeToken: string;
    now: number;
  }) {
    await this.sql.run(
      `INSERT INTO email_bindings (address, categories, pending_email, code_hash, code_expires, code_attempts, link_token_hash, unsubscribe_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET categories = excluded.categories, pending_email = excluded.pending_email,
         code_hash = excluded.code_hash, code_expires = excluded.code_expires, code_attempts = 0,
         link_token_hash = excluded.link_token_hash, updated_at = excluded.updated_at`,
      [
        a.address,
        a.categories.join(','),
        a.email,
        a.codeHash,
        a.codeExpires,
        a.linkTokenHash,
        a.unsubscribeToken,
        a.now,
        a.now,
      ],
    );
  }

  async countAttempt(address: string, now: number) {
    await this.sql.run(
      'UPDATE email_bindings SET code_attempts = code_attempts + 1, updated_at = ? WHERE address = ?',
      [now, address],
    );
  }

  /** The pending email becomes the verified one, with its new salt and hash; codes and link are spent. */
  async completeVerification(address: string, salt: string, emailHash: string, now: number) {
    await this.sql.run(
      `UPDATE email_bindings SET email = pending_email, salt = ?, email_hash = ?, verified_at = ?, pending_email = NULL,
         code_hash = NULL, code_expires = NULL, code_attempts = 0, link_token_hash = NULL, unsubscribed = 0, updated_at = ?
       WHERE address = ? AND pending_email IS NOT NULL`,
      [salt, emailHash, now, now, address],
    );
  }

  async byLinkToken(tokenHash: string): Promise<Binding | null> {
    const [r] = await this.sql.all('SELECT * FROM email_bindings WHERE link_token_hash = ?', [tokenHash]);
    return r ? toBinding(r) : null;
  }

  async setCategories(address: string, categories: string[], now: number) {
    await this.sql.run('UPDATE email_bindings SET categories = ?, unsubscribed = 0, updated_at = ? WHERE address = ?', [
      categories.join(','),
      now,
      address,
    ]);
  }

  /** One-click unsubscribe: no more alerts to this binding (the verified email itself stays, for issuing). */
  async unsubscribe(token: string, now: number): Promise<boolean> {
    const rows = await this.sql.all<{ address: string }>(
      'SELECT address FROM email_bindings WHERE unsubscribe_token = ?',
      [token],
    );
    if (!rows.length) return false;
    await this.sql.run('UPDATE email_bindings SET unsubscribed = 1, updated_at = ? WHERE unsubscribe_token = ?', [
      now,
      token,
    ]);
    return true;
  }

  /** Verified bindings for these addresses (lowercase). */
  async verified(addresses: string[]): Promise<Binding[]> {
    if (!addresses.length) return [];
    const out: Binding[] = [];
    for (let i = 0; i < addresses.length; i += 50) {
      const chunk = addresses.slice(i, i + 50);
      const rows = await this.sql.all(
        `SELECT * FROM email_bindings WHERE verified_at IS NOT NULL AND address IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      );
      out.push(...rows.map(toBinding));
    }
    return out;
  }

  /** Queue emails; a dedupe key already queued (or sent) is ignored, so replays never send twice. */
  async enqueue(items: OutboxItem[], now: number): Promise<number> {
    let added = 0;
    for (const it of items) {
      const before = await this.sql.all('SELECT 1 AS x FROM email_outbox WHERE dedupe = ?', [it.dedupe]);
      if (before.length) continue;
      await this.sql.run(
        `INSERT INTO email_outbox (dedupe, address, note_id, category, payload, send_after, expires_at, status, attempts, next_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?) ON CONFLICT (dedupe) DO NOTHING`,
        [
          it.dedupe,
          it.address,
          it.noteId,
          it.category,
          JSON.stringify(it.payload),
          it.sendAfter,
          it.expiresAt,
          it.sendAfter,
          now,
        ],
      );
      added++;
    }
    return added;
  }

  async due(now: number, limit = 50): Promise<OutboxRow[]> {
    const rows = await this.sql.all<Record<string, unknown>>(
      `SELECT dedupe, address, note_id, category, payload, send_after, expires_at, attempts FROM email_outbox
       WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({
      dedupe: String(r.dedupe),
      address: String(r.address),
      noteId: (r.note_id as string) ?? null,
      category: String(r.category),
      payload: String(r.payload),
      sendAfter: Number(r.send_after),
      expiresAt: n(r.expires_at),
      attempts: Number(r.attempts),
    }));
  }

  async settle(
    dedupe: string,
    status: 'sent' | 'failed' | 'expired' | 'skipped',
    now: number,
    messageId?: string,
    error?: string,
  ) {
    await this.sql.run('UPDATE email_outbox SET status = ?, sent_at = ?, message_id = ?, error = ? WHERE dedupe = ?', [
      status,
      now,
      messageId ?? null,
      error ?? null,
      dedupe,
    ]);
  }

  async retry(dedupe: string, attempts: number, nextAt: number, error: string) {
    await this.sql.run('UPDATE email_outbox SET attempts = ?, next_at = ?, error = ? WHERE dedupe = ?', [
      attempts,
      nextAt,
      error,
      dedupe,
    ]);
  }

  /** Keep a copy of an email for the recipient's own list. A second copy of the same dedupe key is ignored. */
  async record(m: SentMessage) {
    await this.sql.run(
      `INSERT INTO email_messages (dedupe, address, note_id, note_label, category, recipient, subject, html, text, status, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe) DO NOTHING`,
      [
        m.dedupe,
        m.address,
        m.noteId,
        m.noteLabel,
        m.category,
        m.recipient,
        m.subject,
        m.html,
        m.text,
        m.status,
        m.createdAt,
        m.sentAt,
      ],
    );
  }

  /** Delete all but the newest `keep` copies for an address. */
  async trimMessages(address: string, keep = MESSAGES_KEPT) {
    await this.sql.run(
      `DELETE FROM email_messages WHERE address = ? AND dedupe NOT IN (
         SELECT dedupe FROM email_messages WHERE address = ? ORDER BY sent_at DESC, dedupe DESC LIMIT ?)`,
      [address, address, keep],
    );
  }

  /** An address's emails, newest first; `before` is the last one of the previous page. */
  async messages(
    address: string,
    opts: { before?: { at: number; id: string }; limit: number },
  ): Promise<SentMessage[]> {
    const page = opts.before
      ? await this.sql.all<Record<string, unknown>>(
          `SELECT * FROM email_messages WHERE address = ? AND (sent_at < ? OR (sent_at = ? AND dedupe < ?))
         ORDER BY sent_at DESC, dedupe DESC LIMIT ?`,
          [address, opts.before.at, opts.before.at, opts.before.id, opts.limit],
        )
      : await this.sql.all<Record<string, unknown>>(
          'SELECT * FROM email_messages WHERE address = ? ORDER BY sent_at DESC, dedupe DESC LIMIT ?',
          [address, opts.limit],
        );
    return page.map((r) => ({
      dedupe: String(r.dedupe),
      address: String(r.address),
      noteId: (r.note_id as string) ?? null,
      noteLabel: (r.note_label as string) ?? null,
      category: String(r.category),
      recipient: String(r.recipient),
      subject: String(r.subject),
      html: String(r.html),
      text: String(r.text),
      status: r.status === 'failed' ? 'failed' : 'sent',
      createdAt: Number(r.created_at),
      sentAt: Number(r.sent_at),
    }));
  }

  /** An address's emails still waiting in the outbox, soonest first. */
  async queued(address: string, limit = 20): Promise<QueuedRow[]> {
    const rows = await this.sql.all<Record<string, unknown>>(
      `SELECT dedupe, note_id, category, payload, send_after, next_at FROM email_outbox
       WHERE address = ? AND status = 'pending' ORDER BY next_at, dedupe LIMIT ?`,
      [address, limit],
    );
    return rows.map((r) => ({
      dedupe: String(r.dedupe),
      noteId: (r.note_id as string) ?? null,
      category: String(r.category),
      payload: String(r.payload),
      sendAfter: Number(r.send_after),
      nextAt: Number(r.next_at),
    }));
  }

  async counts(): Promise<Record<string, number>> {
    const rows = await this.sql.all<{ status: string; c: unknown }>(
      'SELECT status, COUNT(*) AS c FROM email_outbox GROUP BY status',
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
  }
}

-- notes.markets on Cloudflare D1: email alerts. The same tables as the notifier's AlertsStore
-- (services/notifier/src/store.ts, ALERTS_SCHEMA), one schema for the Worker and the tests.
-- Emails and their salts live only here (never on-chain, never in logs); on-chain the engine sees only the
-- salted hash attestation, email_hash = keccak256(abi.encode(salt, lower(trim(email)))).

-- One verified (or pending) email per wallet address, with its pending code and link (stored hashed).
CREATE TABLE email_bindings (
  address           TEXT PRIMARY KEY,
  email             TEXT,
  salt              TEXT,
  email_hash        TEXT,
  categories        TEXT NOT NULL,
  verified_at       INTEGER,
  pending_email     TEXT,
  code_hash         TEXT,
  code_expires      INTEGER,
  code_attempts     INTEGER NOT NULL DEFAULT 0,
  link_token_hash   TEXT,
  unsubscribe_token TEXT NOT NULL,
  unsubscribed      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX email_bindings_link ON email_bindings (link_token_hash);
CREATE INDEX email_bindings_unsub ON email_bindings (unsubscribe_token);

-- The notification outbox: one row per (note, step, period, kind, recipient) dedupe key, so a restart or a
-- replayed event never sends twice. send_after schedules reminders; the email is rendered when it is sent.
CREATE TABLE email_outbox (
  dedupe     TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  note_id    TEXT,
  category   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  send_after INTEGER NOT NULL,
  expires_at INTEGER,
  status     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  message_id TEXT,
  error      TEXT,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX email_outbox_due ON email_outbox (status, next_at);

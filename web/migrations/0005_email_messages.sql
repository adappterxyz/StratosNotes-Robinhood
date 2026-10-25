-- notes.markets on Cloudflare D1: a copy of every alert email, for the recipient's own "Emails sent" list on the
-- Alerts tab (POST /api/alerts/emails, signed by the wallet). The same table as the notifier's AlertsStore
-- (services/notifier/src/store.ts, ALERTS_SCHEMA).
--
-- One row per outbox dedupe key (so per recipient binding), written by the notifier's drain when an email is sent
-- or fails for good: the subject, HTML and text exactly as sent, the note it concerns, the status, the time. The
-- recipient is kept masked (a•••@x.com). Queued emails are not copied here: the API renders them from
-- email_outbox. Verification-code emails are never copied (their codes would be stored in the clear).
--
-- Retention: the newest 200 per address (MESSAGES_KEPT); older rows are deleted when a new one is recorded.
CREATE TABLE email_messages (
  dedupe     TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  note_id    TEXT,
  note_label TEXT,
  category   TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  html       TEXT NOT NULL,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER NOT NULL
);
CREATE INDEX email_messages_address ON email_messages (address, sent_at, dedupe);

-- Emails sent before this migration: what email_outbox still knows (no body was kept then). Their copies say so.
INSERT OR IGNORE INTO email_messages (dedupe, address, note_id, note_label, category, recipient, subject, html, text, status, created_at, sent_at)
SELECT o.dedupe, o.address, o.note_id, json_extract(o.payload, '$.vars.note'), o.category, '',
       CASE json_extract(o.payload, '$.template')
         WHEN 'payment-due' THEN 'Payment due' WHEN 'payment-missed' THEN 'Payment missed' WHEN 'margin-call' THEN 'Margin call'
         WHEN 'payment-made' THEN 'You were paid' WHEN 'default-holder' THEN 'Note defaulted' WHEN 'default-issuer' THEN 'Note defaulted'
         WHEN 'collateral-released' THEN 'Collateral released' WHEN 'strike-fixed' THEN 'Strike fixed'
         WHEN 'issued' THEN 'Your note is live' WHEN 'subscribed' THEN 'You subscribed'
         ELSE COALESCE(NULLIF(json_extract(o.payload, '$.subject'), ''), 'Alert') END
         || COALESCE(': ' || json_extract(o.payload, '$.vars.note'), ''),
       '', 'This email was sent before notes.markets kept copies, so its text is not available.', o.status, o.created_at, o.sent_at
FROM email_outbox o WHERE o.status IN ('sent', 'failed') AND o.sent_at IS NOT NULL;

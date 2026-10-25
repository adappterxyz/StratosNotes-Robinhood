-- notes.markets on Cloudflare D1: the indexer's read model and the template library.
-- Ported from services/indexer/src/schema.ts (Postgres). SQLite types: block numbers, timestamps and sequence
-- numbers are INTEGER (64-bit); addresses, hashes, process ids and token balances (up to 78 digits) are TEXT;
-- JSON documents are TEXT holding json(). Underlyings get a join table (note_underlyings) in place of Postgres's
-- text[] + GIN index.

-- One row per indexed chain: the engine, the cursor (last block fully ingested) and the fallback reporter in
-- force at the cursor.
CREATE TABLE chains (
  chain             TEXT PRIMARY KEY,
  family            TEXT NOT NULL,
  chain_id          INTEGER,
  engine            TEXT NOT NULL,
  start_block       INTEGER NOT NULL,
  cursor            INTEGER NOT NULL,
  head              INTEGER,
  fallback_reporter TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Hashes of recently ingested blocks (every block with events, and every batch's last block): how a reorg is
-- detected and how far back to undo it.
CREATE TABLE blocks (
  chain  TEXT NOT NULL,
  number INTEGER NOT NULL,
  hash   TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  PRIMARY KEY (chain, number)
);

-- Every engine event, decoded and chain-neutral (sdk events.ts), keyed by (chain, block, log_index) so
-- re-ingesting is a no-op. `seq` orders them globally.
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  chain      TEXT NOT NULL,
  block      INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  log_index  INTEGER NOT NULL,
  tx         TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  name       TEXT NOT NULL,
  note_id    TEXT,
  data       TEXT NOT NULL,
  UNIQUE (chain, block, log_index)
);
CREATE INDEX events_note ON events (note_id, block, log_index);
CREATE INDEX events_chain_block ON events (chain, block);
CREATE INDEX events_chain_name ON events (chain, name, block);

-- Content-addressed workflows: bytes = CORE ‖ META, hex.
CREATE TABLE definitions (
  chain   TEXT NOT NULL,
  id      TEXT NOT NULL,
  creator TEXT NOT NULL,
  bytes   TEXT NOT NULL,
  name    TEXT NOT NULL,
  block   INTEGER NOT NULL,
  PRIMARY KEY (chain, id)
);

-- The projection: each note's NoteState (JSON) plus the columns the API filters and sorts on.
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,
  chain        TEXT NOT NULL,
  engine       TEXT NOT NULL,
  pid          TEXT NOT NULL,
  definition   TEXT NOT NULL,
  state        TEXT NOT NULL,
  status       INTEGER NOT NULL,
  window_open  INTEGER NOT NULL,
  strike_date  INTEGER,
  product_type TEXT,
  underlyings  TEXT NOT NULL DEFAULT '[]',
  name         TEXT NOT NULL,
  label        TEXT NOT NULL,
  issuer       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_seq     INTEGER NOT NULL
);
CREATE INDEX notes_chain ON notes (chain, created_at DESC);
CREATE INDEX notes_status ON notes (status, created_at DESC);
CREATE INDEX notes_product ON notes (product_type);
CREATE INDEX notes_created ON notes (created_at DESC, id DESC);

CREATE TABLE note_underlyings (
  note_id TEXT NOT NULL,
  symbol  TEXT NOT NULL,
  PRIMARY KEY (symbol, note_id)
);

-- The projection of balances, indexed by owner for portfolios.
CREATE TABLE holdings (
  note_id TEXT NOT NULL,
  asset   INTEGER NOT NULL,
  owner   TEXT NOT NULL,
  balance TEXT NOT NULL,
  PRIMARY KEY (note_id, asset, owner)
);
CREATE INDEX holdings_owner ON holdings (owner);

-- Live updates: one row per note changed by an ingest or a reorg (note_id NULL = everything on the chain).
-- The app polls /api/updates?since=<seq>; rows older than a day are pruned by the cron.
CREATE TABLE changes (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  chain   TEXT NOT NULL,
  note_id TEXT,
  at      INTEGER NOT NULL
);
CREATE INDEX changes_at ON changes (at);

-- The template library (written by the API, EIP-191 signed by the author).
CREATE TABLE templates (
  definition  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  author      TEXT NOT NULL,
  signature   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  label       TEXT NOT NULL,
  entry       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX templates_created ON templates (created_at DESC);

-- Fixed-window counters for the hourly limits (templates, faucet); per-minute read limits use the Workers
-- rate-limiting binding instead, which costs no D1 writes.
CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  client       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  n            INTEGER NOT NULL,
  PRIMARY KEY (bucket, client, window_start)
);

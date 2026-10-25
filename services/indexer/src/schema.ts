/**
 * The read model's schema, as ordered migrations (applied once each, recorded in schema_migrations).
 *
 *  - chains:      one row per indexed chain: the engine, the cursor (last block fully ingested), the fallback
 *                 reporter in force at the cursor.
 *  - blocks:      hashes of recently ingested blocks (every block with events, and every batch's last block):
 *                 how a reorg is detected and how far back to undo it.
 *  - events:      every engine event, decoded and chain-neutral (sdk events.ts), keyed by (chain, block,
 *                 log_index) so re-ingesting is a no-op. `seq` orders them globally for live updates.
 *  - definitions: content-addressed workflows (bytes = CORE ‖ META), decoded on demand.
 *  - notes:       the projection: each note's NoteState (jsonb) plus the columns the API filters and sorts on.
 *  - holdings:    the projection of balances, indexed by owner for portfolios.
 *  - templates:   the template library (written by the API).
 */
import type { Queryable } from './db';

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE chains (
    chain             text PRIMARY KEY,
    family            text NOT NULL,
    chain_id          integer,
    engine            text NOT NULL,
    start_block       bigint NOT NULL,
    cursor            bigint NOT NULL,
    head              bigint,
    fallback_reporter text NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
    updated_at        timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE blocks (
    chain  text NOT NULL,
    number bigint NOT NULL,
    hash   text NOT NULL,
    ts     bigint NOT NULL,
    PRIMARY KEY (chain, number)
  );
  CREATE TABLE events (
    seq        bigserial PRIMARY KEY,
    chain      text NOT NULL,
    block      bigint NOT NULL,
    block_hash text NOT NULL,
    log_index  integer NOT NULL,
    tx         text NOT NULL,
    ts         bigint NOT NULL,
    name       text NOT NULL,
    note_id    text,
    data       jsonb NOT NULL,
    UNIQUE (chain, block, log_index)
  );
  CREATE INDEX events_note ON events (note_id, seq);
  CREATE INDEX events_chain_block ON events (chain, block);
  CREATE INDEX events_payout_holder ON events ((data->>'holder'), seq) WHERE name = 'PayoutPaid';
  CREATE TABLE definitions (
    chain   text NOT NULL,
    id      text NOT NULL,
    creator text NOT NULL,
    bytes   bytea NOT NULL,
    name    text NOT NULL,
    block   bigint NOT NULL,
    PRIMARY KEY (chain, id)
  );
  CREATE TABLE notes (
    id           text PRIMARY KEY,
    chain        text NOT NULL,
    engine       text NOT NULL,
    pid          numeric NOT NULL,
    definition   text NOT NULL,
    state        jsonb NOT NULL,
    status       smallint NOT NULL,
    window_open  boolean NOT NULL,
    strike_date  bigint,
    product_type text,
    underlyings  text[] NOT NULL DEFAULT '{}',
    name         text NOT NULL,
    label        text NOT NULL,
    issuer       text NOT NULL,
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL,
    last_seq     bigint NOT NULL
  );
  CREATE INDEX notes_chain ON notes (chain);
  CREATE INDEX notes_status ON notes (status, created_at DESC);
  CREATE INDEX notes_product ON notes (product_type);
  CREATE INDEX notes_underlyings ON notes USING gin (underlyings);
  CREATE TABLE holdings (
    note_id text NOT NULL,
    asset   smallint NOT NULL,
    owner   text NOT NULL,
    balance numeric(78, 0) NOT NULL,
    PRIMARY KEY (note_id, asset, owner)
  );
  CREATE INDEX holdings_owner ON holdings (owner);
  CREATE TABLE templates (
    definition  text PRIMARY KEY,
    name        text NOT NULL,
    description text NOT NULL,
    author      text NOT NULL,
    signature   text NOT NULL,
    kind        text NOT NULL,
    label       text NOT NULL,
    entry       jsonb NOT NULL,
    created_at  bigint NOT NULL
  );
  CREATE INDEX templates_created ON templates (created_at DESC);
  `,
];

export async function migrate(db: Queryable & { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> }) {
  // One transaction under an advisory lock, so migrators starting together (indexer and API) serialise. The lock
  // must come first: two concurrent CREATE TABLE IF NOT EXISTS can still collide on the catalog in Postgres.
  await db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(7710001)');
    await q.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await q.query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => Number(r.version)),
    );
    for (let v = 1; v <= MIGRATIONS.length; v++) {
      if (done.has(v)) continue;
      for (const stmt of MIGRATIONS[v - 1]
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean))
        await q.query(stmt);
      await q.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
    }
  });
}

# services/edge: the notes.markets backend on Cloudflare (Worker + D1)

All internal data lives in **Cloudflare D1** (`web/migrations/`). The site's Worker (`web/worker.ts`, wrangler
environment `edge`) is the whole backend:

| Piece | Where | Replaces |
|---|---|---|
| API (`src/api.ts`) | Worker `fetch`, `/api/*`, Hono over D1 | services/api on Node + Postgres |
| Indexer (`src/ingest.ts`, `src/scheduled.ts`) | Worker `scheduled`, every minute | services/indexer on Node + Postgres |
| Notifier delivery (`src/notify.ts`) | same cron, Cloudflare Email Service (`EMAIL` binding) | the planned Node notifier |
| Live updates | `GET /api/updates?since=<seq>` polled by the app every 4 s | SSE on Postgres LISTEN/NOTIFY |
| AI | Worker `fetch`, `/api/ai`, Workers AI | unchanged |

Only the CRE keeper (the CRE simulator) and the issuer bots still run on the server.

## Data

`0001_read_model.sql`: `chains` (cursor per chain), `blocks` (recent hashes for reorg checks), `events` (every
engine event, unique on chain/block/log_index, `seq` autoincrement), `definitions` (CORE ‖ META hex), `notes`
(NoteState JSON + filter columns), `note_underlyings` (replaces Postgres `text[]` + GIN), `holdings`, `changes`
(live-update feed, pruned after a day), `templates`, `rate_limits` (hourly counters).

`0002_email.sql`: `subscriptions` (address → email, salt, salted hash, verification), `email_codes`,
`preferences`, `outbox` (unique `dedupe_key`, `not_before` for reminders, retries). Emails and salts exist only
here; on-chain there is only the salted-hash attestation.

SQLite types: block numbers, timestamps and sequence numbers are INTEGER; addresses, hashes, pids and balances
(up to 78 digits) TEXT; JSON as TEXT.

## Atomicity and reorgs on D1

D1 has no interactive transactions; `batch()` runs a list of statements as one transaction (a failing statement
rolls back all of them; verified in Miniflare). Each ingest step therefore:

1. reads what it needs (cursor, stored hash at the cursor, the touched notes' current state, definitions),
2. reads the chain (logs, block hashes, new definitions' CORE) and folds the new events into the notes in memory,
3. writes everything in **one batch**: events (INSERT OR IGNORE), definitions, note rows, holdings, underlyings,
   block hashes, the cursor, the `changes` rows.

The batch starts with a **guard**: `SELECT CASE WHEN (SELECT cursor …) IS ?expected THEN 1 ELSE json('…') END`.
If another cron invocation moved the cursor meanwhile, `json()` raises and the whole batch rolls back (this
replaces `SELECT … FOR UPDATE`). Events already in the log are skipped by the fold, so replaying a range is a
no-op.

A **reorg** (the chain no longer has the cursor block's stored hash) walks back through stored hashes to the last
common block, rebuilds each affected note in memory from its remaining events, and applies one guarded batch:
delete events/definitions/blocks after the ancestor, rewrite or remove the affected notes, move the cursor back.

## Limits (per cron invocation)

| Limit | Platform | Used |
|---|---|---|
| D1 queries (each batch statement counts) | 1,000 paid / 50 free | budget 800; a full step ≤ ~230 (150 events, 25 notes); measured ≤ 30 per run on the local e2e |
| Subrequests (JSON-RPC calls) | 1,000 paid / 50 free | budget 700; a step ≈ 4 + blocks with events; measured ≤ 10 per run |
| Bound parameters per statement | 100 | multi-row inserts are chunked (e.g. 25 holdings rows) |
| Statement size | 100 KB | note state JSON for 62 holders ≈ 15 KB |
| CPU time | 30 s default | budget 20 s wall; measured ≤ 0.6 s per run |

A step covers up to `maxRange` blocks (2,000 for the testnets), cut at a block boundary once it holds 150 events
or 25 notes. Backfill from the deployment block therefore needs about (blocks behind ÷ 2,000) steps, several per
cron run. The free plan's 50 subrequests per invocation is too few for two chains; use Workers Paid.

Expected volume (two testnet chains): a note's life is ~150 events; the cron writes ~3–4 rows per chain per minute
while blocks advance (block hash, cursor, prune), ≈ 11k row writes/day; the app's polling reads ~2 rows per poll
per open tab.

## Tests

`npm -w services/edge test` runs against a local D1 (Miniflare): backfill, idempotent replay, reorgs (including
one that removes a note), confirmations, CRE vs fallback provenance, live-update rows, the guard against a
concurrent writer, bounded batches, a 62-holder book; the whole API (ported from services/api's tests); polling
updates; the cron's budgets and the outbox (sent once, skipped without a verified email, untouched without a
sender).

`E2E=1 bash scripts/dev-local-d1.sh` (KEEPER=fallback or cre) runs `wrangler dev --local` with a local D1 against
an anvil fork, the app and a keeper, and the app end-to-end check.

# @sn/indexer

Reads every configured chain's FlowEngine events into one PostgreSQL read model, which the API serves and the
app renders. Chain-neutral: notes are keyed `<chain>:<engine>:<pid>` and stored as the SDK's `NoteState`, so a
future non-EVM ingester could write the same tables.

```bash
INDEXER_CONFIG=config.json DATABASE_URL=postgres://user:pass@host/db npx tsx src/main.ts
npm test   # PGlite: backfill, idempotent replay, reorgs (including one that removes a note), depth, notify
```

`config.json`:

```json
{ "chains": [
  { "key": "arbitrum-sepolia", "family": "evm", "chainId": 421614, "rpc": "https://sepolia-rollup.arbitrum.io/rpc",
    "engine": "0x…", "startBlock": 12345678, "confirmations": 2, "maxRange": 1000, "pollMs": 2000 },
  { "key": "robinhood-testnet", "family": "evm", "chainId": 46630, "rpc": "https://rpc.testnet.chain.robinhood.com",
    "engine": "0x…", "startBlock": 456, "confirmations": 20, "maxRange": 2000 }
] }
```

## Why PostgreSQL (not Cloudflare D1)

- **Ingestion is long-running.** Each chain is a polling loop with its own backoff, and it needs a transaction per batch: the events, the projection, the block hashes and the cursor commit together or not at all. A Node process on managed Postgres (Neon, RDS, Cloud SQL) does that without fighting Worker CPU and duration limits.
- **Live updates come from the database.** The indexer `NOTIFY`s after each commit and the API `LISTEN`s, then fans out over SSE. D1 has no equivalent, so it would need a Durable Object relay.
- **Filters need real indexes.** The marketplace filters on arrays of underlyings (GIN), JSON state and 78-digit balances. Postgres types fit these exactly.
- **Tests run the production SQL.** They use PGlite, Postgres compiled to WASM, in-process. Production uses `pg`. Both sit behind the same small `Db` interface (`src/db.ts`).

## How it stays correct

| Concern | What the indexer does |
|---|---|
| Depth | Reads only blocks `confirmations` behind the head, or finalized blocks with `"finality": "finalized"` |
| Reorgs | Before each batch, compares the stored hash of the cursor block with the chain. On a mismatch it walks back through stored hashes (every block with events, and every batch end, for the last 2,048 blocks) to the last common block. Then it deletes later events, rebuilds the notes they touched from the remaining log, and resumes. Within a batch, every block with events is re-read and must match its logs' block hash, or the batch is retried |
| Replays | Events are unique on `(chain, block, log_index)` and inserted only if new. Projections apply only inserted rows, so re-ingesting changes nothing |
| Two indexers | Each batch locks its chain row and commits only if the cursor has not moved |
| Backfill | A chain starts at `startBlock` (the engine's deployment block) and replays history in `maxRange` steps |
| Definitions | `DefinitionRegistered` carries META. CORE is read from the engine (content-addressed), and the pair must hash to the id |
| CRE or fallback | Each `ReportProcessed` is classified by the fallback reporter in force at that point in the chain. Anything else came through the KeystoneForwarder, i.e. Chainlink CRE |

## Tables

`chains` (cursor per chain), `blocks` (recent hashes), `events` (the log), `definitions`, `notes` (`NoteState` as JSON plus filter columns), `holdings` (by owner), and `templates` (written by the API). See `src/schema.ts`.

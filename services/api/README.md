# @sn/api

The REST and live-update API the app reads from. It serves the indexer's Postgres read model, the template
library and the AI assistant.

```bash
API_CONFIG=config.json DATABASE_URL=postgres://… PORT=8787 npx tsx src/main.ts
npm test   # PGlite + the indexer's fake chain: filters, paging, validation, CORS, templates (EIP-191), AI gate, SSE
```

Environment variables:
- `CF_ACCOUNT_ID` and `CF_AI_TOKEN` (Workers AI read permission) enable `/api/ai` when the config has `"ai": true`.
- `FAUCET_KEY` signs the mint on dev chains whose config has a `faucet`.

## Why Node (Hono) rather than a Cloudflare Worker

- **It needs a long-lived Postgres connection.** It holds one `LISTEN` connection to the indexer's notifications and fans it out to many open Server-Sent Event streams. A Node process does this directly. A Worker would need Hyperdrive for Postgres plus a Durable Object to hold the listener.
- **It reads the same database as the indexer**, so both use the same `Db` layer and schema (`@sn/indexer`).
- **The code is portable.** Hono runs unchanged on Workers. The AI uses Workers AI over its REST API (the same models as the hackathon's binding: Clef routes, Kimi K2.6 extracts and edits), so moving the API to a Worker later only changes how it reaches Postgres.

## Endpoints

| | |
|---|---|
| `GET /api/health` | indexer cursors and heads per chain |
| `GET /api/config` | the chains the app can use: RPC, engine, lens, stablecoin, CRE support, faucet |
| `GET /api/notes?chain&status&underlying&product&q&limit&cursor` | `status`: `book` \| `live` \| `redeemed` \| `active` \| `all`; keyset paging |
| `GET /api/notes/:id` | `{ state, view }` (`id` = `<chain>:<engine>:<pid>`) |
| `GET /api/notes/:id/history` | the note's events, newest first |
| `GET /api/definitions/:chain/:id` | definition bytes (CORE ‖ META), cached forever (content-addressed) |
| `GET /api/portfolio/:address` | every note the address holds, with its position |
| `GET /api/templates`, `GET /api/templates/:definition` | the library |
| `POST /api/templates` | `{ entry, signature }`: an EIP-191 signature by `entry.author` of `StratosNotes: publish template <definition>`. The workflow is recompiled and must land on `definition` |
| `POST /api/ai` | `{ prompt, draft? }` -> a reply, a clarifying question, a product, or a workflow edit |
| `POST /api/faucet` | dev chains only: mints the mock stablecoin |
| `GET /api/stream?notes=a,b` or `?chain=x` | SSE: `ready`, then `notes` events naming changed notes (pings every 15 s) |

## Security

- **CORS** answers only `allowedOrigins`.
- **Writes** (`POST`) are refused from any other `Origin`.
- **Bodies** are size-limited, and every input is validated with zod.
- **Rate limits** are per client IP: reads per minute, and AI, templates and faucet per hour. Open streams are capped per IP. Set `trustProxy` only behind a proxy that sets `X-Forwarded-For`. Limits are per instance, so put edge rate limiting in front for hard global limits.
- **Searches** escape LIKE wildcards, and every SQL value is a bound parameter.
- **Template signatures:** EOA signatures (EIP-191) are checked with `ecrecover`. Smart-contract wallets (EIP-1271) need an RPC check, which is not wired yet.

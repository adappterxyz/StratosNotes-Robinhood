# Deploy runbook: Arbitrum Sepolia, Robinhood Chain testnet, notes.markets

> **Networks: testnets only.** notes.markets issues every note on Arbitrum Sepolia; Robinhood Chain testnet is the collateral chain (its vault, and the legacy notes issued there earlier). Chainlink runs
> through the CRE simulator (`cre workflow simulate --broadcast` against the mock forwarders), so there is no mainnet
> deployment: Arbitrum One and Robinhood Chain mainnet wait on CRE production (DON) access and an audit
> (docs/MILESTONES.md). Mainnets are only read, for Chainlink prices: crypto on Ethereum, equities on Robinhood Chain
> (notes issued before 2026-10-24 keep the Arbitrum One equity feeds compiled into them).
>
> **Current engines (v3, 2026-10-24):** Arbitrum Sepolia `0xAF8425A4b2d8994796e019D9b42Cd99D40297e10`, Robinhood
> Chain testnet `0xCbF6eeC598b8f3b4a4082f5583Db6bD6f488b22D`. Earlier engines: `deployments/archive/` (v1, v2). The
> v3 redeploy reset the D1 read model for both chains (the reset in the notes of §8) and kept the email tables
> and templates.
>
> **Engine v4 (live on both testnets since 2026-10-24; v3 notes keep running on their own engines):** note units as ERC-20s; payouts claimed by holders with a receipt
> per claim, or pushed to wallets where the issuer opts in (docs/ERC20-NOTES.md). Its redeploy record, with gas
> measured on a fork (≈11M gas per chain), is in docs/ERC20-NOTES.md §9. With v4, reports cost the same for any number of holders (a coupon
> about 0.4M gas, a default about 1.0M).

Everything below runs from the repo root on the server. Keys live in `.keys/` (gitignored, mode 600) and are read
from files by the scripts, never typed on a command line or printed.

| Key | Address | Role |
|---|---|---|
| `.keys/deployer.json` | `0x298afB9424188C7eA7c01556D8CAE6ff4768de0a` | Deploys and owns the engine (and the retired test tokens and faucet of earlier deployments); issuer and paying agent of the seeded demo notes |
| `.keys/keeper.json` | `0xcA06AbE78eCBcC861a8eE12fd980035dC91d118f` | Pays gas for the CRE simulator's `--broadcast` reports |
| `.keys/investor1.json`, `investor2.json` | created by `scripts/seed-note.ts` | Demo investors in the seeded notes (the deployer sends each 0.001 ETH for gas) |

The deployer is also the **issuer** of the seeded notes: it pledges their USDG collateral and, through
`scripts/issuer-bot.ts` (pm2 `sn-arb-issuer-<chain>`), funds each payment as it falls due, from USDG it holds (claim
it at faucet.paxos.com: notes.markets mints no token). Older demo notes settle in the retired tUSD, which the bot
can still mint for them with `MINT=1` as the token's owner. Each funding costs about 0.22M gas.

## 1. Fund the two addresses

Measured on a local fork of Arbitrum Sepolia (`REHEARSAL=1 bash scripts/deploy-testnets.sh`): the whole deployment
(engine, lens, 8 test tokens, faucet, minter and drip settings) is **27 transactions, 13.86M gas**. The engine alone
estimates at 5.33M gas on both live testnets (`cast estimate`, read-only, 2026-10-23). Gas prices that day: Arbitrum
Sepolia 0.020 gwei, Robinhood Chain testnet 0.010 gwei.

| Address | Arbitrum Sepolia | Robinhood Chain testnet | What it covers |
|---|---|---|---|
| Deployer `0x298a…de0a` | **0.02 ETH** | **0.02 ETH** | Deployment (~0.0003 ETH at today's price), two seeded notes, 0.002 ETH passed to the demo investors, and room for gas-price spikes |
| Keeper `0xcA06…118f` | **0.03 ETH** | **0.03 ETH** | Reports: 0.2–0.5M gas each for a small book; a coupon to a full book of 62 holders 2.3M, a default paying three assets to 62 holders 5.0M (6M limit); several hundred reports at today's prices |

Faucets: Arbitrum Sepolia, https://faucets.chain.link/arbitrum-sepolia (or bridge Sepolia ETH); Robinhood Chain
testnet, https://faucet.testnet.chain.robinhood.com.

## 2. Deploy the contracts

```bash
REHEARSAL=1 SEED=1 bash scripts/deploy-testnets.sh   # optional: the same against local forks first
bash scripts/deploy-testnets.sh                      # both testnets: writes deployments/<chain>.json,
                                                     # cre/notes-keeper-evm/config.staging.json, deployments/server/*.json
```

The engine trusts each chain's **MockKeystoneForwarder** (what `cre workflow simulate --broadcast` writes through).
The fallback reporter stays off. Commit `deployments/*.json` and the generated configs afterwards.

## 3. Database, indexer and API (pm2)

These commands create new resources on this server. They don't touch the existing cloudflared tunnel, the
splice-validator containers or other pm2 processes. Run them after approval.

```bash
# Postgres 16, local only, persistent volume
PGPASS="$(openssl rand -hex 24)"
docker run -d --name sn-arb-pg --restart unless-stopped -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=sn -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=stratosnotes \
  -v sn-arb-pgdata:/var/lib/postgresql/data postgres:16-alpine

# Secrets for the services (never committed)
umask 077
printf 'DATABASE_URL=postgres://sn:%s@127.0.0.1:55432/stratosnotes\nSN_PROXY_SECRET=%s\n' "$PGPASS" "$(openssl rand -hex 32)" > .env.server
unset PGPASS

# Email (docs/NOTIFICATIONS.md): the relay secret the API and the Worker share, and the verifier key that signs
# on-chain email attestations (its address is the engine's verifier: scripts/deploy-testnets.sh reads it)
printf 'EMAIL_RELAY_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env.server
[ -f .keys/verifier.json ] || (cast wallet new --json > .keys/verifier.json && chmod 600 .keys/verifier.json)

pm2 start ops/ecosystem.config.cjs --only sn-arb-indexer,sn-arb-api
curl -s http://127.0.0.1:8787/api/health      # the indexer's cursor per chain
```

The API also runs the email notifier (no separate process). Alerts go out once Email Sending is onboarded for
notes.markets (docs/NOTIFICATIONS.md, "Turning on Email Sending"); until then the outbox holds them.

## 4. Public API hostname: a separate Cloudflare Tunnel

A new tunnel with its own credentials directory, so the existing `/etc/cloudflared` tunnel and
`~/.cloudflared/cert.pem` are left alone. The login opens a browser link: pick the **stratoslab.app** zone in account
`325f8b322c30ee0f5460cfdaef82ecf5`.

```bash
mkdir -p /root/.cloudflared-notes
HOME=/root/.cloudflared-notes cloudflared tunnel login
HOME=/root/.cloudflared-notes cloudflared tunnel create sn-arb-api
HOME=/root/.cloudflared-notes cloudflared tunnel route dns sn-arb-api api.notes.markets
TID="$(HOME=/root/.cloudflared-notes cloudflared tunnel list -o json | python3 -c "import json,sys;print([t['id'] for t in json.load(sys.stdin) if t['name']=='sn-arb-api'][0])")"
cat > /root/.cloudflared-notes/config.yml <<EOF
tunnel: $TID
credentials-file: /root/.cloudflared-notes/.cloudflared/$TID.json
ingress:
  - hostname: api.notes.markets
    service: http://127.0.0.1:8787
  - service: http_status:404
EOF
pm2 start cloudflared --name sn-arb-tunnel -- tunnel --no-autoupdate --config /root/.cloudflared-notes/config.yml run sn-arb-api
curl -s https://api.notes.markets/api/health
```

## 5. The site Worker (notes.markets)

```bash
(cd web && npm install)
# the same SN_PROXY_SECRET as .env.server, so the API trusts the client IP the Worker forwards
grep '^SN_PROXY_SECRET=' .env.server | cut -d= -f2 | (cd web && CLOUDFLARE_ACCOUNT_ID=325f8b322c30ee0f5460cfdaef82ecf5 npx wrangler secret put SN_PROXY_SECRET)
# the same EMAIL_RELAY_SECRET as .env.server, for /internal/email (the API's email relay)
grep '^EMAIL_RELAY_SECRET=' .env.server | cut -d= -f2 | (cd web && CLOUDFLARE_ACCOUNT_ID=325f8b322c30ee0f5460cfdaef82ecf5 npx wrangler secret put EMAIL_RELAY_SECRET)
npm run deploy        # landing-proof from deployments/*.json, build landing + app, wrangler deploy (custom domain)
```

## 6. Keeper, seed data, templates

```bash
cd cre && cre whoami && cd ..                          # the CRE CLI must be logged in
pm2 start ops/ecosystem.config.cjs --only sn-arb-keeper
pm2 start ops/ecosystem.config.cjs --only sn-arb-issuer-arbitrum-sepolia,sn-arb-issuer-robinhood-testnet  # the issuer funds its notes
bash scripts/seed.sh                                   # one demo note per chain + the template library
# To show a default: leave one note's payment unfunded, e.g. pid 2's first payment on Arbitrum Sepolia
MISS=2:1 pm2 restart sn-arb-issuer-arbitrum-sepolia --update-env
pm2 logs sn-arb-keeper --lines 20                      # "... Task_FixStrike [...] -> written 0x…"
```

## 7. Record the evidence

After a seeded note completes, add its transactions to `docs/evidence.json` (see `scripts/landing-proof.ts` for the
shape) and to docs/SUBMISSION.md, then `npm run deploy` again so the landing page shows them.

## 8. Cutover to Cloudflare D1 (the whole backend on the Worker)

**Done 2026-10-23.**
- D1 database `notes-markets` (id `33c7e4bc-596c-458e-8d67-ff0903d1978a`); the edge config is now the default
  Worker config, so `npm run deploy` deploys it.
- Backfilled from the v2 deployments' start blocks in proxy mode; then switched to edge.
- Retired: `sn-arb-indexer`, `sn-arb-api` and `sn-arb-tunnel` (pm2), the `sn-arb-pg` container (its volume
  `sn-arb-pgdata` is kept as a backup), and the `sn-arb-api` tunnel.
- The `api.notes.markets` DNS record is still there: delete it in the Cloudflare dashboard (notes.markets → DNS),
  since cloudflared cannot remove DNS records.
- On the server: the CRE keeper (`sn-arb-keeper`) and the issuer bots (`sn-arb-issuer-*`) only.

The steps as run, kept for re-runs:

All internal data moves to D1: the indexer's read model, templates, email subscriptions (emails and salts),
verification codes, preferences and the notification outbox (`web/migrations/`). The Worker serves the API from
D1 and runs the indexer and the notifier on a one-minute cron (`services/edge`, wrangler environment `edge`).
Afterwards only the CRE keeper and the issuer bots run on this server; Postgres, `sn-arb-indexer`, `sn-arb-api`
and the `sn-arb-tunnel` (api.notes.markets) are retired.

Rehearse first, locally: `E2E=1 bash scripts/dev-local-d1.sh` (anvil fork + `wrangler dev --local` with a local
D1 + the app end-to-end check).

```bash
cd web
export CLOUDFLARE_ACCOUNT_ID=325f8b322c30ee0f5460cfdaef82ecf5

# 1. Create the database, put its id into wrangler.jsonc (env.edge.d1_databases[0].database_id), commit.
npx wrangler d1 create notes-markets

# 2. Schema.
npx wrangler d1 migrations apply DB --remote --env edge

# 3. Deploy the edge Worker, still proxying the API to the server while D1 backfills.
#    (Set "API_MODE": "proxy" in env.edge.vars for this deploy.)
bash build.sh && npx wrangler deploy --env edge
#    Secrets do not carry over between environments: set them for env edge.
grep '^SN_PROXY_SECRET=' ../.env.server | cut -d= -f2 | npx wrangler secret put SN_PROXY_SECRET --env edge

# 4. Backfill: the cron indexes from each engine's deployment block (deployments/server/indexer.json startBlock).
#    Watch it catch up; the cursor per chain should reach the head within a few cron runs.
npx wrangler tail --env edge --format json | grep '"cron":"indexer"'
npx wrangler d1 execute DB --remote --env edge --command "SELECT chain, cursor, head, updated_at FROM chains"

# 5. Templates: re-seed the library through the API once it serves from D1 (they are signed; no copy needed),
#    or copy them from Postgres:
#    psql "$DATABASE_URL" -Atc "SELECT json_agg(t) FROM templates t" > /tmp/templates.json   then insert via
#    `npx wrangler d1 execute DB --remote --env edge --file <generated inserts.sql>`.

# 6. Switch: "API_MODE": "edge" in env.edge.vars (the default), redeploy, verify.
bash build.sh && npx wrangler deploy --env edge
curl -s https://notes.markets/api/health          # chains with cursor near head, served by the Worker
curl -s "https://notes.markets/api/notes?limit=5" # the live notes
curl -s "https://notes.markets/api/updates"       # {"seq":…,"changes":[]}

# 7. Retire the old backend (only after 6 verifies).
pm2 delete sn-arb-indexer sn-arb-api sn-arb-tunnel && pm2 save
docker stop sn-arb-pg   # keep the volume a while as a backup; `docker rm sn-arb-pg` later
HOME=/root/.cloudflared-notes cloudflared tunnel delete sn-arb-api   # and remove the api.notes.markets DNS record
```

Notes:
- Email: when notes.markets is onboarded for Email Sending, add the `send_email` binding (`EMAIL`) to `env.edge`
  and set `"EMAIL_SENDING": "on"`. Until then the outbox fills and nothing is sent.
- A redeployed engine on a chain: the indexer refuses a chain row whose engine changed. Index the new engine
  under a new key (e.g. `arbitrum-sepolia-v2`), or reset the chain: delete its rows from `chains`, `blocks`,
  `events`, `definitions`, and its notes/holdings/note_underlyings (`WHERE chain = …` / `note_id LIKE '<chain>:%'`).
- Limits per cron run (services/edge/src/scheduled.ts): ≤ 800 D1 queries of the 1,000 allowed, ≤ 700 RPC calls
  of the 1,000 subrequests allowed (paid plan; the free plan's 50 subrequests is too few), 20 s of wall time.
  Each batch is at most 150 events and 25 notes, cut at a block boundary.

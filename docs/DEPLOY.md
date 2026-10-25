# Deploy runbook: Robinhood Chain testnet, notes.markets

> **Network: Robinhood Chain testnet (chain id 46630) only.** Every note is issued, collateralised, observed and paid
> there. Chainlink runs through the CRE simulator (`cre workflow simulate --broadcast` against the chain's
> MockKeystoneForwarder `0x0b93082D9b3C7C97fAcd250082899BAcf3af3885`), so there is no mainnet deployment: Robinhood
> Chain mainnet waits on CRE write support there and an audit. Mainnets are only read, for Chainlink prices: crypto on
> Ethereum, equities on Robinhood Chain mainnet (over CRE's HTTP capability).
>
> **Fresh deployment.** This build deploys a new FlowEngine (v4: ERC-20 note units, claimed payouts with receipts,
> docs/ERC20-NOTES.md) and NotesLens on Robinhood Chain testnet. Until then `deployments/robinhood-testnet.json` is a
> placeholder with no `engine`, and the generated configs (`deployments/server/*.json`,
> `cre/notes-keeper-evm/config.staging.json`) list no chain. The earlier build's engines, notes and cross-chain pairs
> are kept for reference only in `deployments/archive/arbitrum-build/` and are not served, indexed or kept running.
> Cross-chain collateral is planned, not deployed (docs/CROSS-CHAIN.md): there is no `deployments/crosschain-testnet.json`.

Everything below runs from the repo root on the server. Keys live in `.keys/` (gitignored, mode 600) and are read
from files by the scripts, never typed on a command line or printed.

| Key | Address | Role |
|---|---|---|
| `.keys/deployer.json` | `0x298afB9424188C7eA7c01556D8CAE6ff4768de0a` | Deploys and owns the engine; issuer and paying agent of the seeded demo notes |
| `.keys/keeper.json` | `0xcA06AbE78eCBcC861a8eE12fd980035dC91d118f` | Pays gas for the CRE simulator's `--broadcast` reports |
| `.keys/verifier.json` | (its address becomes the engine's verifier) | Signs on-chain email attestations (docs/NOTIFICATIONS.md) |
| `.keys/investor1.json`, `investor2.json` | created by `scripts/seed-note.ts` | Demo investors in the seeded notes (the deployer sends each a little ETH for gas) |

The deployer is also the **issuer** of the seeded notes: it pledges their collateral and, through
`scripts/issuer-bot.ts` (pm2, `ops/ecosystem.config.cjs`), funds each payment as it falls due, from USDG it holds.
notes.markets mints no token: every token is real on Robinhood Chain testnet (packages/core `CHAIN_TOKENS`).

## 1. Fund the addresses

The engine alone estimates at about 5.3M gas (`cast estimate`, 2026-10-23, at ~0.010 gwei on Robinhood Chain
testnet); the v4 redeploy measured ≈11M gas with the lens on a fork (docs/ERC20-NOTES.md §9).

| Address | Robinhood Chain testnet | What it covers |
|---|---|---|
| Deployer `0x298a…de0a` | **0.02 ETH**, **~3,000 USDG**, a few **TSLA** (and AMZN for the equity seed) | Deployment, the seeded notes' collateral (USDG, and stock tokens where a seed pledges or reserves them), the issuer bot's payment funding, ETH passed to the demo investors |
| Keeper `0xcA06…118f` | **0.03 ETH** | Reports: 0.2–0.5M gas each for a small book; a coupon to a full book of 62 holders 2.3M, a default paying three assets to 62 holders 5.0M; several hundred reports at today's prices |
| Demo investors | USDG to subscribe (the seed passes it on from the deployer) | Subscriptions in the seeded notes |
| Presenter wallet (demo) | ETH, ≥1 TSLA, ~25 USDG | docs/DEMO-AUTOMATION.md |

Faucets (plain links; rate-limited per wallet):
- ETH for gas and Robinhood's stock tokens (TSLA, AMZN, AMD, PLTR, NFLX): https://faucet.testnet.chain.robinhood.com
- USDG (Paxos Global Dollar on Robinhood Chain testnet, `0x7E955252E15c84f5768B83c41a71F9eba181802F`):
  https://faucet.paxos.com

## 2. Deploy the contracts

```bash
REHEARSAL=1 SEED=1 CHAINS=robinhood-testnet bash scripts/deploy-testnets.sh   # optional: the same against a local fork first
CHAINS=robinhood-testnet bash scripts/deploy-testnets.sh
# writes deployments/robinhood-testnet.json (over the placeholder), then runs
#   npx tsx scripts/cre-config.ts staging     -> cre/notes-keeper-evm/config.staging.json
#   npx tsx scripts/server-config.ts          -> deployments/server/{api,indexer}.json
```

The engine trusts Robinhood Chain testnet's **MockKeystoneForwarder** (what `cre workflow simulate --broadcast` writes
through). The fallback reporter stays off. Check the outputs: `deployments/server/api.json` lists one chain,
`robinhood-testnet`, with the new engine and lens, `stablecoin` USDG and the real tokens (USDG, WETH, TSLA, AMZN, AMD,
PLTR, NFLX), no `crossChain` and no `legacyEngines`; `config.staging.json` lists the new engine under
`robinhood-testnet` and no `gateways` or `vaults`. Commit `deployments/robinhood-testnet.json` and the generated
configs.

## 3. Reset the D1 read model, then deploy the Worker

The Worker (`web/wrangler.jsonc`: same name, routes and D1 database `notes-markets` as before) serves the API from D1
and runs the indexer and notifier on a one-minute cron. Its read model still holds the earlier build's chains and
notes, and the indexer refuses a chain row whose engine changed, so reset it **before** deploying the new config:

```bash
cd web
export CLOUDFLARE_ACCOUNT_ID=325f8b322c30ee0f5460cfdaef82ecf5
# Look first (read-only):
npx wrangler d1 execute DB --remote --command "SELECT chain, cursor, head FROM chains"
# Reset: deletes chains, blocks, events, definitions, notes, note_underlyings, holdings and changes rows.
# Email bindings, the outbox and messages, rate limits and templates are kept (see the file's comments).
npx wrangler d1 execute DB --remote --file reset/0000_robinhood_reset.sql
cd ..
npm run deploy        # landing-proof from deployments/robinhood-testnet.json, build landing + app, wrangler deploy
```

Secrets already set on the Worker carry over (`VERIFIER_KEY`, `SN_PROXY_SECRET`); set `VERIFIER_KEY` again only if
the verifier key changed. Then verify:

```bash
curl -s https://notes.markets/api/config            # one chain: robinhood-testnet, the new engine
curl -s https://notes.markets/api/health            # its cursor moves toward the head within a few cron runs
```

Rehearse locally first if you like: `E2E=1 bash scripts/dev-local-d1.sh` (anvil fork + `wrangler dev --local` with a
local D1 + the app end-to-end check).

## 4. Keeper, issuer bot, seed data, templates

```bash
cd cre && cre whoami && cd ..                          # the CRE CLI must be logged in
pm2 start ops/ecosystem.config.cjs                     # the CRE keeper loop and the issuer bot for robinhood-testnet
bash scripts/seed.sh                                   # demo notes on Robinhood Chain (crypto and equity, USDG cash) + the template library
pm2 logs --lines 20                                    # keeper: "... Task_FixStrike [...] -> written 0x…"
# To show a default: leave one note's payment unfunded, e.g. pid 2's first payment
MISS=2:1 pm2 restart <issuer bot> --update-env         # its name in ops/ecosystem.config.cjs
```

The seed needs the deployer funded as in §1: USDG for collateral, payments and the investors' subscriptions, and the
stock tokens an equity note pledges or reserves for physical delivery. The demo investor autopilot
(`scripts/demo-investor.ts`) needs its own key with ETH and USDG (docs/DEMO-AUTOMATION.md).

## 5. Record the evidence

After a seeded note completes, add its transactions to `docs/evidence.json` (`runs`, chain `robinhood-testnet`; see
`scripts/landing-proof.ts` for the shape; the earlier build's runs are in `docs/archive/evidence.json`), and to
docs/OVERVIEW.md, then `npm run deploy` again so the landing proof data picks them up.

## Notes

- **Redeploying the engine again later:** the indexer refuses a chain row whose engine changed. Either keep the old
  engine as a legacy one (`deployments/archive/v<N>/robinhood-testnet.json`: scripts/server-config.ts serves it as
  `legacyEngines`, indexed under `robinhood-testnet-v<N>`, and `LEGACY=v<N> npx tsx scripts/cre-config.ts staging`
  keeps the keeper on it), or reset the read model again with `web/reset/0000_robinhood_reset.sql`.
- **Email:** alerts go out through the `EMAIL` binding (Cloudflare Email Service) when `EMAIL_SENDING` is `on`;
  otherwise the outbox fills and nothing is sent (docs/NOTIFICATIONS.md).
- **Limits per cron run** (services/edge/src/scheduled.ts): ≤ 800 D1 queries of the 1,000 allowed, ≤ 700 RPC calls
  of the 1,000 subrequests allowed (paid plan), 20 s of wall time. Each batch is at most 150 events and 25 notes,
  cut at a block boundary. Robinhood Chain testnet is indexed with 120 confirmations and 20,000-block ranges.
- **History:** the earlier build ran Postgres + pm2 services and a Cloudflare Tunnel before moving to D1
  (2026-10-23); none of that is used now. The `api.notes.markets` DNS record, if still present, can be deleted.

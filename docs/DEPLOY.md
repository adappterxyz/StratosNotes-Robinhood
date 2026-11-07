# Deploy runbook: Robinhood Chain testnet and Base Sepolia, notes.markets

> **Networks: Robinhood Chain testnet (chain id 46630) and Base Sepolia (chain id 84532).** Each note is issued,
> collateralised, observed and paid on its own chain; collateral can also stay locked on the other chain
> (docs/CROSS-CHAIN.md). Chainlink runs through the CRE simulator (`cre workflow simulate --broadcast` against each
> chain's MockKeystoneForwarder: `0x0b93082D9b3C7C97fAcd250082899BAcf3af3885` on Robinhood Chain testnet,
> `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` on Base Sepolia), so there is no mainnet deployment. Mainnets are only
> read, for Chainlink prices: crypto on Ethereum, equities on Robinhood Chain mainnet (over CRE's HTTP capability).
>
> **Fresh deployment.** This build deploys a new FlowEngine (v4: ERC-20 note units, claimed payouts with receipts,
> docs/ERC20-NOTES.md) and NotesLens on Robinhood Chain testnet. Until then `deployments/robinhood-testnet.json` is a
> placeholder with no `engine`, and the generated configs (`deployments/server/*.json`,
> `cre/notes-keeper-evm/config.staging.json`) list no chain. The earlier build's engines, notes and cross-chain pairs
> are kept for reference only in `deployments/archive/arbitrum-build/` and are not served, indexed or kept running.
> **Base Sepolia and cross-chain collateral** are added by §2b: a FlowEngine and NotesLens on Base Sepolia
> (`deployments/base-sepolia.json`) and one gateway–vault pair per direction (`deployments/crosschain/<home>.json`).
> Sections 1–2 describe the Robinhood Chain deployment that is already live.

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

## 2b. Base Sepolia and cross-chain collateral (both directions)

Nothing here is broadcast until you run it. Rehearse each step on anvil forks first (`REHEARSAL=1`: forks of both
chains, the deployer funded on the fork only, records written under `deployments/local/rehearsal/`).

Funding, before step 1 (the deployer `0x298a…de0a` deploys and owns everything; fees are quoted at run time and the
scripts refuse to start below their balance check):

| Wallet | Base Sepolia | Robinhood Chain testnet | What it covers |
|---|---|---|---|
| Deployer | 0.01 ETH (needs ~0.0051: engine ~0.00007, gateway ~0.00002 + 0.005 fee pool, vault ~0.00001, wire ~0.00003; the gateway step checks for 0.007) | 0.01 ETH (needs ~0.0051: gateway ~0.00004 + 0.005 fee pool, vault ~0.00002, wire ~0.00002; Orbit L1 data gas adds a little) | Base engine + lens; each pair's gateway (with its release fee pool), vault and wire step |
| Keeper (CRE simulator broadcaster) | 0.002 ETH (a report ≤ ~0.00002) | (as §1) | Engine reports and gateway flush reports on Base |
| Issuer bot (per chain) | 0.001–0.002 ETH | (as §1) | Funding payments, receipt withdrawals and pushes, fallback flushes |
| Issuer locking collateral | ~0.000054 ETH CCIP fee + ~330k gas per lock on Base | ~0.000050 ETH CCIP fee + ~340k gas per lock on Robinhood | One CCIP lock fee per lock, paid in native ETH on the asset chain |
| Investors | < 0.00001 ETH per subscribe or claim, + USDC | (as §1) | Subscribing to Base notes |

Measured on anvil forks on 2026-11-06 (gas prices then: Base Sepolia 0.006 gwei, Robinhood Chain testnet 0.01 gwei):
engine deploy on Base 12.1M gas (6 tx); gateway 4.0M (2 tx) on either chain; vault 1.7M on Base (2 tokens) and 1.9M on
Robinhood (6 tokens); wire 1.9M on Robinhood (2 receipts) and 5.6M on Base (6 receipts). CCIP fees on the real routers
(fork test): a release from the Robinhood gateway ~0.0000495 ETH, from the Base gateway ~0.0000539 ETH; a 0.005 ETH fee
pool pays ~90–100 releases (top up with `ROLE=fund`).

Faucets: Base Sepolia ETH (https://faucets.chain.link/base-sepolia, https://www.alchemy.com/faucets/base-sepolia), USDC
on Base Sepolia (Circle, https://faucet.circle.com; `0x036CbD53842c5426634e7929541eC2318f3dCF7e`), Robinhood's stock
tokens and ETH on Robinhood Chain testnet (https://faucet.testnet.chain.robinhood.com).

```bash
# 0. Optional: the whole sequence on anvil forks of both chains
REHEARSAL=1 CHAINS=base-sepolia bash scripts/deploy-testnets.sh
REHEARSAL=1 HOME_CHAIN=robinhood-testnet ASSET_CHAIN=base-sepolia bash scripts/deploy-crosschain.sh
REHEARSAL=1 HOME_CHAIN=base-sepolia ASSET_CHAIN=robinhood-testnet bash scripts/deploy-crosschain.sh

# 1. Base Sepolia engine and lens (a chain already in deployments/ is skipped unless REDEPLOY=1)
CHAINS=base-sepolia bash scripts/deploy-testnets.sh
#   -> deployments/base-sepolia.json; regenerates config.staging.json and deployments/server/*.json

# 2. Robinhood Chain note <- collateral on Base: gateway (+ fee pool) on Robinhood Chain, vault on Base allowing
#    USDC and WETH, receipts USDC.base and WETH.base registered on Robinhood Chain
HOME_CHAIN=robinhood-testnet ASSET_CHAIN=base-sepolia bash scripts/deploy-crosschain.sh
#   -> deployments/crosschain/robinhood-testnet.json (validated), configs regenerated

# 3. Base note <- collateral on Robinhood Chain: gateway (+ fee pool) on Base, vault on Robinhood Chain allowing
#    USDG, WETH, TSLA, AMZN, AMD and PLTR, receipts *.rh registered on Base
HOME_CHAIN=base-sepolia ASSET_CHAIN=robinhood-testnet bash scripts/deploy-crosschain.sh
#   -> deployments/crosschain/base-sepolia.json (validated), configs regenerated
```

Check the outputs: `deployments/server/api.json` lists both chains, `base-sepolia` with stablecoin USDC and tokens
USDC, WETH and the `.rh` receipts, `robinhood-testnet` with the `.base` receipts, and each with a `crossChain` entry
(`role: home`, its gateway and the vault on the other chain); `config.staging.json` lists both engines (CRE chain names
`robinhood-testnet` and `ethereum-testnet-sepolia-base-1`), two `gateways` and one `vaults` entry per receipt.
Verify on-chain:

```bash
cast call <gateway> 'VERSION()(uint256)' --rpc-url <home rpc>                       # 2
cast call <gateway> 'getForwarderAddress()(address)' --rpc-url <home rpc>           # = the home engine's forwarder
cast call <gateway> 'releaseQueue()(uint256,uint256,uint256,uint256,uint256)' --rpc-url <home rpc>
cast call <vault> 'homeGateway()(address)' --rpc-url <asset rpc>                    # = <gateway>
```

Commit `deployments/base-sepolia.json`, `deployments/crosschain/*.json` and the regenerated configs, then continue with
§3 (the Worker; no D1 migration is needed for a second chain: every read-model table and the cron cursors are keyed by chain)
and §4, adding the keeper's Base target (the staging config covers both chains) and a second issuer bot with
`CHAIN_ID=84532` and Base's engine, lens and RPC (`https://base-sepolia-rpc.publicnode.com`; `https://sepolia.base.org` caps eth_getLogs at 200 blocks). The CRE workflow needs an RPC for
`ethereum-testnet-sepolia-base-1` in `cre/project.yaml` (staging target).

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
curl -s https://notes.markets/api/config            # robinhood-testnet (and base-sepolia once §2b ran), with their engines
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
  cut at a block boundary. Robinhood Chain testnet is indexed with 120 confirmations and 20,000-block ranges; Base
  Sepolia with its own settings in `scripts/server-config.ts`.
- **History:** the earlier build ran Postgres + pm2 services and a Cloudflare Tunnel before moving to D1
  (2026-10-23); none of that is used now. The `api.notes.markets` DNS record, if still present, can be deleted.

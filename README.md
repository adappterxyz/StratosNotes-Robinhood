# notes.markets on Robinhood Chain and Base

Structured notes on stocks, crypto, forex and commodities that anyone can issue and sell, on two testnets: **Robinhood
Chain testnet** (chain id 46630) and **Base Sepolia** (chain id 84532). Each note runs on one of them, its home chain:
issuance, subscriptions, the note's ERC-20 units, the escrow, coupons, redemption and every **Chainlink CRE** report
happen there. A note raises the home chain's dollar for the issuer (USDG on Robinhood Chain, USDC on Base) against
collateral valued by Chainlink after a haircut: pledged into the note on its own chain (USDG, WETH, or Robinhood's
TSLA, AMZN, AMD and PLTR stock tokens on Robinhood Chain; USDC or WETH on Base), or locked on the other chain and
carried by **Chainlink CCIP** ([docs/CROSS-CHAIN.md](docs/CROSS-CHAIN.md)). The headline case: Robinhood's stock
tokens stay locked on Robinhood Chain and collateralise a structured note on Base. Below the knock-in barrier a
physically settled note delivers the token itself where its chain has one (the stock tokens or WETH on Robinhood Chain,
WETH on Base); everything else settles in cash. The issuer funds each payment before it falls due, or the holders are
paid what they are owed from the collateral, which recovers up to its value
([docs/NOTE-ECONOMICS.md](docs/NOTE-ECONOMICS.md)). Chainlink CRE is the calculation agent: it pays each coupon into the
note on its payment date, and holders claim it from their portfolio whenever they like, with a receipt per claim
([docs/ERC20-NOTES.md](docs/ERC20-NOTES.md) §5). Testnet only; the contracts are not audited.

Underlyings: any price in the Chainlink catalogue (141 USD feeds: stocks, crypto, forex, commodities;
[docs/UNDERLYINGS.md](docs/UNDERLYINGS.md)), generated from Chainlink's reference data directory by
`scripts/feeds-catalogue.ts`, the same on both chains. Equities come from Robinhood Chain **mainnet** Chainlink feeds,
read by CRE over its HTTP capability; crypto, forex and commodities from Ethereum mainnet (a few from Arbitrum One).
Collateral is a separate whitelist of tokens a note can lock (above). Cross-chain collateral is wired both ways
(Robinhood Chain note ← USDC/WETH on Base; Base note ← USDG/WETH/TSLA/AMZN/AMD/PLTR on Robinhood Chain); the Base
engine and the two gateway–vault pairs are deployed with `scripts/deploy-testnets.sh` and
`scripts/deploy-crosschain.sh` ([docs/DEPLOY.md](docs/DEPLOY.md)).

- Site: https://notes.markets · App: https://notes.markets/app
- Overview: [docs/OVERVIEW.md](docs/OVERVIEW.md) · Demo: [docs/DEMO.md](docs/DEMO.md) · Deploy: [docs/DEPLOY.md](docs/DEPLOY.md)

| Path | What it is |
|---|---|
| `packages/core` | BPMN, compiler (EVM definition bytes), products and reference payoffs, templates, AI pipeline, keeper decisions |
| `packages/evm-engine` | `FlowEngine.sol`, `NotesLens.sol`, the cross-chain contracts (HomeGateway, RemoteVault, RemoteReceipt), Foundry tests, deploy scripts (the retired test tokens and faucet stay only for local tests) |
| `packages/sdk` | chain adapter (viem), events and the read model |
| `cre/notes-keeper-evm` | the Chainlink CRE workflow: reports on both chains, flushes each home gateway, checks every vault |
| `services/indexer`, `services/api` | Postgres read model and the REST/SSE API (`services/edge`: the same on D1 in the Worker) |
| `services/keeper-fallback` | the same keeper logic for chains without CRE (off by default) |
| `scripts/issuer-bot.ts` | the issuer's side, automated for demos and tests: funds payments as they fall due (or leaves one unfunded); pushes payouts only for notes that opt in (`PUSH=1` for all); withdraws and pushes cross-chain receipts. One instance per chain |
| `app`, `landing`, `web` | the app, the landing page, and the Cloudflare Worker that serves both |

```bash
npm install && npm run typecheck && npm test        # unit tests
npm run test:evm                                    # Foundry (fetch lib/ first: packages/evm-engine/README.md)
bash scripts/e2e-cre-evm.sh                         # CRE simulator + fallback keeper on a local Robinhood Chain testnet fork
REHEARSAL=1 HOME_CHAIN=base-sepolia ASSET_CHAIN=robinhood-testnet bash scripts/deploy-crosschain.sh   # a cross-chain pair on anvil forks
E2E=1 bash scripts/dev-local.sh                     # the whole stack locally, driven by a headless browser
```

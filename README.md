# notes.markets on Robinhood Chain

Structured notes on stocks, crypto, forex and commodities that anyone can issue and sell, running on **Robinhood Chain testnet** (chain id
46630). Issuance, subscriptions, the note's ERC-20 units, the escrow, coupons, redemption and every **Chainlink CRE**
report happen there. A note raises USDG for the issuer against collateral pledged into the note on Robinhood Chain:
USDG, WETH, or Robinhood's TSLA, AMZN, AMD and PLTR stock tokens, valued by Chainlink after a haircut. Below the
knock-in barrier a physically settled note delivers the stock token (or WETH) itself; BTC, SOL and stocks with no token
there settle in cash. The issuer funds each payment before it falls due, or the holders are paid what they are owed
from the collateral ([docs/NOTE-ECONOMICS.md](docs/NOTE-ECONOMICS.md)). Chainlink CRE is the calculation agent: it
pays each coupon into the note on its payment date, and holders claim it from their portfolio whenever they like, with
a receipt per claim ([docs/ERC20-NOTES.md](docs/ERC20-NOTES.md) §5).

Underlyings: any price in the Chainlink catalogue (141 USD feeds: stocks, crypto, forex, commodities;
[docs/UNDERLYINGS.md](docs/UNDERLYINGS.md)), generated from Chainlink's reference data directory by
`scripts/feeds-catalogue.ts`. Equities come from Robinhood Chain **mainnet** Chainlink feeds, read by CRE over its HTTP
capability; crypto, forex and commodities from Ethereum mainnet (a few from Arbitrum One). Collateral is a separate
whitelist of tokens a note can lock (above); forex, commodities and stocks with no token there settle in cash. Collateral on other chains, with Robinhood Chain as the home chain, is planned
([docs/CROSS-CHAIN.md](docs/CROSS-CHAIN.md)); the contracts are in the repo, nothing of it is deployed.

- Site: https://notes.markets · App: https://notes.markets/app
- Overview: [docs/OVERVIEW.md](docs/OVERVIEW.md) · Demo: [docs/DEMO.md](docs/DEMO.md) · Deploy: [docs/DEPLOY.md](docs/DEPLOY.md)

| Path | What it is |
|---|---|
| `packages/core` | BPMN, compiler (EVM definition bytes), products and reference payoffs, templates, AI pipeline, keeper decisions |
| `packages/evm-engine` | `FlowEngine.sol`, `NotesLens.sol`, the planned cross-chain contracts, Foundry tests, deploy scripts (the retired test tokens and faucet stay only for local tests) |
| `packages/sdk` | chain adapter (viem), events and the read model |
| `cre/notes-keeper-evm` | the Chainlink CRE workflow |
| `services/indexer`, `services/api` | Postgres read model and the REST/SSE API (`services/edge`: the same on D1 in the Worker) |
| `services/keeper-fallback` | the same keeper logic for chains without CRE (off by default) |
| `scripts/issuer-bot.ts` | the issuer's side, automated for demos and tests: funds payments as they fall due (or leaves one unfunded); pushes payouts only for notes that opt in (`PUSH=1` for all) |
| `app`, `landing`, `web` | the app, the landing page, and the Cloudflare Worker that serves both |

```bash
npm install && npm run typecheck && npm test        # unit tests
npm run test:evm                                    # Foundry (fetch lib/ first: packages/evm-engine/README.md)
bash scripts/e2e-cre-evm.sh                         # CRE simulator + fallback keeper on a local Robinhood Chain testnet fork
E2E=1 bash scripts/dev-local.sh                     # the whole stack locally, driven by a headless browser
```

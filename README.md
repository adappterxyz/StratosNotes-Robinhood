# StratosNotes on Arbitrum

Structured notes on stocks and crypto that anyone can issue and sell. Every note is issued and runs on **Arbitrum
Sepolia**; **Robinhood Chain testnet** is the collateral chain, where stock tokens (TSLA, AMZN, AMD, PLTR) stay locked
in a vault backing Arbitrum notes ([docs/CROSS-CHAIN.md](docs/CROSS-CHAIN.md)). **Chainlink CRE** is the calculation agent. A note raises funds for the issuer against collateral
locked in the note; the issuer funds each payment before it falls due, or the holders are paid what they are owed from the collateral
([docs/NOTE-ECONOMICS.md](docs/NOTE-ECONOMICS.md)). Chainlink CRE pays each coupon into the note on its payment date, and
holders claim it from their portfolio whenever they like, with a receipt per claim (claim by default:
[docs/ERC20-NOTES.md](docs/ERC20-NOTES.md) §5). Built for the Arbitrum Hackerhouse.

- Site: https://notes.markets · App: https://notes.markets/app
- Submission: [docs/SUBMISSION.md](docs/SUBMISSION.md) · Demo: [docs/DEMO.md](docs/DEMO.md) · Deploy: [docs/DEPLOY.md](docs/DEPLOY.md)

| Path | What it is |
|---|---|
| `packages/core` | BPMN, compiler (EVM definition bytes), products and reference payoffs, templates, AI pipeline, keeper decisions |
| `packages/evm-engine` | `FlowEngine.sol`, `NotesLens.sol`, Foundry tests, deploy script (the retired test tokens and faucet stay only for local tests) |
| `packages/sdk` | chain adapter (viem), events and the read model |
| `cre/notes-keeper-evm` | the Chainlink CRE workflow |
| `services/indexer`, `services/api` | Postgres read model and the REST/SSE API |
| `services/keeper-fallback` | the same keeper logic for chains without CRE (off by default) |
| `scripts/issuer-bot.ts` | the issuer's side, automated for demos and tests: funds payments as they fall due (or leaves one unfunded); pushes payouts only for notes that opt in (`PUSH=1` for all) |
| `app`, `landing`, `web` | the app, the landing page, and the Cloudflare Worker that serves both |

```bash
npm install && npm run typecheck && npm test        # unit tests
npm run test:evm                                    # Foundry (fetch lib/ first: packages/evm-engine/README.md)
bash scripts/e2e-cre-evm.sh                         # CRE simulator + fallback keeper on local testnet forks
E2E=1 bash scripts/dev-local.sh                     # the whole stack locally, driven by a headless browser
```

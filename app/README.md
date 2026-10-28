# @sn/app

The StratosNotes web app: Marketplace, note pages, Portfolio, and Issue. It is a port of the hackathon UI from Solana
to Robinhood Chain (EVM), with the same Flow-like design.

- **Note page diagram** ("How this note runs", `NoteFlow.tsx` / `FlowMap.tsx`): the note's BPMN workflow, read-only,
  at a readable scale in its own scrolling box, with zoom, full screen, the current step lit and the steps already run
  marked. Picking a step (click, tap or keyboard) shows what it does, who acts, its date and the values it recorded for
  this note (`lib/stepFacts.ts`: the definition, the note's view, and its history's StepRun / FieldSet events).
- **Issue** (`/issue`): three ways in, start from a note (recently issued on the current engine, or ready-made), the
  product wizard, or describe it to the AI. Each ends on a review with the workflow diagram; custom workflows (saved or
  from the AI) review at `/issue?custom=<definition|ai>`. The advanced editor (`/issue/advanced`: BPMN canvas,
  Validate, Payoff, Template, Issue, AI assistant) opens only with a workflow loaded; empty, it points back to Issue.

- **Reads** come from the API (`services/api`): notes, portfolios, templates, and live updates over SSE. The app
  never scans chains itself.
- **Writes** go to the chain through the SDK's `EvmAdapter` with the connected wallet: issue, subscribe,
  transfer, withdraw, and waiting tasks. The wallet is switched to the note's network first.
- **Wallets** are injected browser wallets (MetaMask, Rabby, Coinbase Wallet…), found with EIP-6963 and shown
  through RainbowKit. Set `VITE_WC_PROJECT_ID` to add WalletConnect for mobile wallets.
- **Network** comes from the API's `/api/config`: Robinhood Chain testnet (or a local fork of it), where every note
  runs. With no chain configured yet (before the contracts are deployed) the app shows a short notice instead.
- **Agent badge:** each note shows who submitted its price reports, Chainlink CRE (via the KeystoneForwarder) or
  the fallback keeper, as classified by the indexer.
- **Cross-chain collateral** (planned, docs/CROSS-CHAIN.md): the lock/redeem components in `src/components/crosschain`
  stay dormant and hidden until a chain config carries `crossChain`.

```bash
npm run dev        # Vite on :5190; proxies /api to VITE_API_PROXY (default http://127.0.0.1:8787)
npm run build      # typecheck + production bundle in dist/
```

## Dev builds: the test wallet

With `VITE_TEST_WALLET=1`, which `scripts/dev-local.sh` sets, the app injects a "StratosNotes test wallet". It
signs with anvil's public test accounts and shows a **Test: Issuer · Investor A · Investor B** switch, so one
person or the headless e2e test can play every role. The code is loaded behind a build-time flag and is absent
from production bundles: `npm run build` output contains no trace of it.

## Run everything locally

```bash
bash scripts/dev-local.sh          # fork, contracts, Postgres, indexer, API, app, keeper; prints the URLs
E2E=1 bash scripts/dev-local.sh    # the same, then the end-to-end check in headless Chromium
KEEPER=cre E2E=1 bash scripts/dev-local.sh   # with Chainlink CRE (simulator --broadcast) as the keeper
```

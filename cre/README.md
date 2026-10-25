# CRE: the calculation agent

`notes-keeper-evm` is one Chainlink CRE workflow (TypeScript, `@chainlink/cre-sdk` 1.23). It is the
calculation agent for every note on every configured EVM chain: Robinhood Chain testnet, where notes run.

Each cron run does this for each chain in the config:

1. **Read the notes.** One `NotesLens.running` call at the last finalized block returns every running
   process. Each distinct definition's full bytes (`NotesLens.definitionBytes`) supply its oracle feeds.
2. **Decide what is due.** The shared logic in `packages/core/src/keeper.ts` picks strike fixings and
   observations whose date has come, plus plain timers to advance.
3. **Read prices.** Each due oracle step reads the Chainlink feed of every underlying it captures, on the
   chain that feed lives on, at a finalized block. A round older than the feed's heartbeat plus
   `finalityAllowanceSec` is refused. Feeds on a chain CRE has no EVM read capability for (Robinhood Chain
   mainnet, where the equity feeds live) are read over the HTTP capability instead; see below.
4. **Write a report.** It sends `abi.encode(uint256 pid, uint16 step, int256[] values)` with `writeReport`
   to the chain's FlowEngine, through the KeystoneForwarder. The engine bounds-checks every value, then runs
   the step and everything that follows (coupons, autocall, redemption) in the same transaction.

| Target | Chains written | Feeds read | Forwarder |
|---|---|---|---|
| `local-fork` | an anvil fork of Robinhood Chain testnet (`SN_FORK_PORT`) | Ethereum mainnet (crypto), Robinhood Chain mainnet over HTTP (equities) | MockKeystoneForwarder (`--broadcast`) |
| `staging-settings` | Robinhood Chain testnet | the same: the testnet has no feeds | MockKeystoneForwarder (`--broadcast`) or KeystoneForwarder once deployed |

There is no production target: CRE cannot write to Robinhood Chain mainnet yet.

Equity feeds (TSLA, AMZN, AMD, PLTR, NVDA, AAPL, SPY on Robinhood Chain mainnet) follow NYSE hours with a 24 h heartbeat; the products set
a 4-day staleness allowance for them so a weekend doesn't block an observation. A note observed on a Monday
morning before the open uses Friday's close.

CRE has no Robinhood Chain **mainnet** write support yet. Notes there would be run by `services/keeper-fallback`.

Cross-chain collateral (planned, docs/CROSS-CHAIN.md) adds optional `gateways` (flush reports) and `vaults` (backing
checks); both are absent from the config while nothing is deployed.

### Feeds over HTTP (Robinhood Chain mainnet)

The CRE simulator and DON have no EVM read capability for `robinhood-mainnet` (an `EVMClient` call fails with
`workflow execution failed: 6180753054346818345@1.0.0`, CLI 1.36 and 1.39). So feeds there are read with the
HTTP capability (`http-feeds.ts`, decoding in `packages/core/src/feed-rpc.ts`), per chain per run:

1. `eth_blockNumber`; the nodes agree on the median head.
2. ONE batched JSON-RPC request: `eth_call` `latestRoundData()` and `decimals()` for every feed due this run, at
   head − `lagBlocks`. Every node reads the same block and decodes its reply to plain decimal strings, so the DON
   reaches identical consensus on the readings (never on raw JSON). A failed call fails only its feed.
3. The same `checkRound` staleness and sanity checks as an EVM read; the engine then bounds-checks the value.

`lagBlocks` (600, ~1 min) instead of `finalized`: Robinhood Chain's `finalized` (~15 min) and `safe` (~13 min)
blocks are older than the state its public RPC keeps (~9 min, "historical state ... is not available").
Two HTTP calls per chain per run (CRE allows 15; replies ~0.4 KB per feed, cap 250 KB; consensus observation
~0.15 KB per feed, cap 25 KB). Trust: unlike the EVM capability, the RPC endpoint is named in the config and
every node asks that one endpoint, so its operator is trusted for these prices; point `rpc` at a provider you
trust (or your own node) for production.

## Config

Generate a target's config from `deployments/robinhood-testnet.json`:

```bash
npx tsx scripts/cre-config.ts staging
```

Until the engine is deployed the deployment file is a placeholder: staging then lists no chain, and the workflow
refuses to start (it needs at least one). A local fork without a deployment gets the zero address, which it also
refuses.

| Field | Meaning |
|---|---|
| `chains[].gasLimit` | Gas for one report (8M). A coupon to a full book of 62 holders measured 2.34M of execution and a default paying three escrow assets to 62 holders 5.01M (capped at what is owed, the rest to the issuer); the rest covers the L1 data gas Robinhood Chain (an Arbitrum Orbit chain) charges inside the limit. CRE allows 10M per write. |
| `chains[].fromPid` | First process id to scan, to skip finished history. |
| `chains[].scan` | How many process ids one lens call reads. |
| `chains[].maxProcesses` | How many running processes one lens call returns. Up to 4 pages per run. |
| `maxReportsPerRun` | Writes per run, across all chains. |
| `finalityAllowanceSec` | Extra staleness allowed for reads at a finalized block. |
| `feedRoutes` | Optional. Sends a recorded feed (lowercase address) to another source. |
| `httpFeedChains` | Optional. Feed chains read over HTTP JSON-RPC: `{ "robinhood-mainnet": { "rpc": "https://…", "lagBlocks": 600 } }` (or `"blockTag"`: `finalized`/`safe`/`latest`). Written by `cre-config.ts` from `HTTP_FEED_CHAINS`. |

## Run

From this directory (CLI logged in):

```bash
cre workflow simulate notes-keeper-evm --target staging-settings --non-interactive --trigger-index 0              # dry run
cre workflow simulate notes-keeper-evm --target staging-settings --non-interactive --trigger-index 0 --broadcast  # writes
```

- **Broadcasting** needs `CRE_ETH_PRIVATE_KEY`. `scripts/keeper-loop.sh` passes the keeper key
  (`.keys/keeper.json`) in a temporary env file it deletes after each run. That key pays gas on Robinhood Chain
  testnet.
- **Deploying** (`cre workflow deploy`) needs CRE deploy access, a linked funded wallet, and engines whose
  forwarder is the KeystoneForwarder (`FORWARDER_MODE=production` in `packages/evm-engine/script/Deploy.s.sol`).

The full life of a note on a Robinhood Chain testnet fork, driven by the simulator: `bash scripts/e2e-cre-evm.sh`.

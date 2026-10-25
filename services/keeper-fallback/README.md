# Fallback keeper

The CRE keeper's decisions, made by a signed Node service, for an EVM chain where Chainlink CRE cannot write
reports. Today that is **Robinhood Chain mainnet**: it has Chainlink feeds and CCIP but no CRE forwarder.

It runs the same logic as `cre/notes-keeper-evm`:
- **Decision:** `packages/core/src/keeper.ts`.
- **State:** read from the chain's NotesLens at a finalized block.
- **Prices:** Chainlink feeds (`latestRoundData`) under the same staleness rule.
- **Report payload:** the same, `abi.encode(pid, step, values)`.

It differs in one thing: it submits through `FlowEngine.fallbackReport` instead of the KeystoneForwarder.

## How the engine tells the two apart

- The engine owner chooses one **fallback reporter** address with `setFallbackReporter`. It is zero (off) by
  default. `fallbackReport` reverts with `InvalidSender` for anyone else.
- Every applied report emits `ReportProcessed(pid, step, values, reporter)`. The reporter is either the
  KeystoneForwarder (a DON-signed CRE report) or the fallback reporter. The indexer and app use this to show
  which agent fixed a strike or ran an observation.
- The engine checks fallback values exactly as it checks CRE values: the oracle bounds compiled into the note
  (min/max price per underlying), oracle steps only, and the timer must be due.

The trust difference matters. A CRE report is signed by a decentralized oracle network; a fallback report is
signed by one key. Run it only where CRE is unavailable:
- Keep the key in a KMS or HSM, not in a plain file.
- Make the engine owner a multisig.
- Turn the fallback off (`setFallbackReporter(0)`) once CRE supports the chain.

## Run

```bash
KEEPER_CONFIG=config.json KEEPER_KEY_FILE=/run/secrets/fallback-key npm start     # every intervalSec
KEEPER_CONFIG=config.json KEEPER_KEY_FILE=/run/secrets/fallback-key npm run once  # one pass
```

```json
{ "chain": { "name": "robinhood-mainnet", "chainId": 4663, "rpc": "https://rpc.mainnet.chain.robinhood.com",
             "engine": "0x...", "lens": "0x..." },
  "feedRpcs": { "ethereum-mainnet": "https://..." },
  "blockTag": "finalized", "finalityAllowanceSec": 1800, "maxReportsPerRun": 5, "gasLimit": "6000000",
  "intervalSec": 60, "feedRoutes": {} }
```

- **`feedRpcs`:** maps each feed chain named in a note's oracles (CRE chain-selector names) to an RPC.
  `robinhood-mainnet` (the equity feeds) defaults to its public RPC (`HTTP_FEED_CHAINS` in `@sn/core`).
- **`feedReadAt`:** optional, per feed chain: `{ "blockTag": "latest" }` or `{ "lagBlocks": 600 }`. Robinhood
  Chain mainnet defaults to 600 blocks below the head, the same block rule as the CRE workflow (its public RPC
  does not keep the finalized block's state).
- **`feedRoutes`:** optional. Redirects a recorded feed address (lowercase) to another feed, for example
  Robinhood mainnet's own equity feeds.

The process refuses to run unless its key is the engine's current fallback reporter.

End to end on a Robinhood testnet fork: `PARTS=fallback bash scripts/e2e-cre-evm.sh`.

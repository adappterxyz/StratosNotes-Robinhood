# @sn/evm-engine

`FlowEngine.sol` runs compiled StratosNotes workflows (structured notes as BPMN) on EVM chains: notes run on
Robinhood Chain testnet. It is a port of the hackathon's Solana engine (StratosNotes `solana/programs/flow_engine`),
with the same semantics. Chainlink CRE is its calculation agent: oracle values arrive as DON-signed reports
through the KeystoneForwarder (`onReport`).

## Setup

`lib/` is gitignored. Fetch the pinned dependencies:

```bash
git clone --depth 1 --branch v1.9.4 https://github.com/foundry-rs/forge-std lib/forge-std
git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
# Cross-chain collateral (src/crosschain, docs/CROSS-CHAIN.md): CCIP contracts and Chainlink Local for tests
git clone --depth 1 --branch contracts-ccip-v2.0.0 https://github.com/smartcontractkit/chainlink-ccip lib/chainlink-ccip
git clone --depth 1 --branch contracts-v1.5.0 https://github.com/smartcontractkit/chainlink-evm lib/chainlink-evm
git clone --depth 1 --branch v0.3.1 https://github.com/smartcontractkit/chainlink-local lib/chainlink-local
git clone --depth 1 --branch v4.8.3 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts-4.8.3
git clone --depth 1 --branch v5.3.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts-5.3.0
```

Then:

```bash
npm run fixtures   # compile every product with packages/core -> test/fixtures/products.json
forge test         # 13 tests: every product vs its reference payoff, plus the guards
forge test --isolate -vv --match-test test_gasWithManyHolders   # gas per report, each call its own transaction
```

## How a definition is stored

Its bytes are `CORE ‖ META` (packages/core/src/compile-evm.ts):
- **CORE** is what the engine executes: fixed-width big-endian records behind offset tables, a few KiB.
- **META** holds the names and term-sheet JSON.

`registerDefinition(bytes)`:
1. Computes the id as `sha256(bytes)`, the same id as on every chain.
2. Validates every offset and index in CORE (`DefCheck.check`, a linked library so its code is not part of the
   engine's 24 KiB; `forge script` and `forge test` link it automatically).
3. Stores CORE once as contract code (SSTORE2).
4. Emits META in `DefinitionRegistered` for the indexer.

Each transaction copies CORE into memory with one `EXTCODECOPY` and reads steps by offset. CORE may be up to
24,575 bytes; today's products are 3 to 10 KiB with the funding cycle drawn in (18 KiB for 12 observations).

## Escrow, balances and time (the note's economics)

A note raises funds against collateral (docs/NOTE-ECONOMICS.md), and the workflow draws the whole cycle; the engine
provides three generic mechanisms for it:

- **Escrow role.** A pool the definition marks escrow (role flag bit 0) is held by the engine at `ESCROW`, an
  address no key controls. `startProcess` refuses anything but `address(0)` for it; no step may act as it
  (`DefCheck`); units cannot be transferred to it. So pledged collateral and funded payments on its account cannot
  be withdrawn or moved except by the workflow's own operations (paying holders from escrow, the default
  distribution, the release to the issuer).
- **Expressions read accounts and time.** Op 18 `balance(role, asset)` reads a role's ledger balance (an open
  role has no account: the expression waits); op 19 `now` is `block.timestamp`. Gateways and guards use them:
  `balance(Escrow, cash) >= dueTotal`, `now >= payDate + grace`. Expression captures into date, int and bool fields
  are stored plain (a payment date computed as `obsDate1 + lag` is unix seconds).
- **Milestones.** A step can carry a business-event code (the high nibble of its flags); the engine emits
  `Milestone(pid, code, step, actor)` when it completes: 1 collateral pledged, 2 released, 3 funding deposited,
  4 margin call, 5 margin call cured, 6 payment made, 7 payment missed, 8 defaulted.

## Calls

| Call | Who | What |
|---|---|---|
| `registerDefinition(data)` | anyone | publish a workflow (idempotent) |
| `startProcess(def, ref, roles, assetTokens, startStep, inputs, name, symbol)` | the start step's role | a new issuance. `roles[i] = 0` makes an OPEN role (e.g. investors). `assetTokens[i]` is the ERC-20 behind a cash asset. Each issued asset gets its own ERC-20, a NoteToken clone (`name`, `symbol`, 6 decimals) |
| `executeStep(pid, step, choice, inputs)` | the step's role (anyone for OPEN) | user tasks, decisions, subscriptions. Deposits pull ERC-20 from the caller (approve first) |
| `poke(pid)` | anyone | run what is due |
| `onReport(metadata, report)` | KeystoneForwarder only | `report = abi.encode(uint256 pid, uint16 step, int256[] values)`. `step = 0xFFFF` only advances. `0xFFFE` is reserved for cross-chain payouts |
| `fallbackReport(report)` | the fallback reporter only | the same report, from a signed keeper where CRE cannot write (services/keeper-fallback). Off by default |
| `deposit` / `withdraw(pid, asset, base)` | holder | ERC-20 in and out of the process vault. `withdraw` works while paused |
| `NoteToken.transfer` / `transferFrom` / `permit` | holder | move note units: a standard ERC-20 transfer, to verified recipients only while the note runs (the token asks `beforeNoteTransfer`) |
| `pushPayouts(pid, asset, start, count)` / `pushTo(pid, asset, holders)` | anyone | pay accrued payouts to holders' wallets: `pushTo(pid, asset, [self])` is a holder's claim, with a receipt (the default); batches (`start = 2^256-1`: from the round's cursor) are for notes whose issuer opts in to push. A failed transfer stays claimable (`PayoutDeferred`) |
| `balanceOf` / `pendingOf(pid, owner, asset)`, `assetTokenOf(pid, asset)` | view | units (from the token) or cash (ledger + accrued); the accrued part; the ERC-20 behind an asset (the note token for issued units) |
| `pause` / `unpause`, `setForwarderAddress`, `setExpectedWorkflowId/Author/Name`, `setFallbackReporter` | owner (two-step) | admin |
| `ESCROW()` | view | the address the engine holds escrow roles at |

Inputs are `(uint8 tag, bytes32 data)`:
- tag 1 is a number: an int256, fixed point with 10 decimals, or a plain integer for dates.
- tag 2 is text: UTF-8, left-aligned.
- tag 3 is a party: an address, right-aligned.

`evmInput` in packages/core builds them.

## Events (the indexer's input)

| Event | When |
|---|---|
| `DefinitionRegistered(id, creator, pointer, meta)` | a workflow is published |
| `ProcessStarted(pid, definition, creator, ref, roles, assetTokens)` | an issuance starts |
| `StepRun(pid, step, kind, actor)` | a step completes (`actor` = 0 for straight-through and reports) |
| `FieldSet(pid, field, tag, value)` | a field is captured |
| `HoldingChanged(pid, asset, owner, balance)` | after every balance change: cash on the ledger, or a holder's units (token balance × 1e4), holder transfers included |
| `NoteTokenCreated(pid, asset, token)` | a note's ERC-20 is created (in `startProcess`) |
| `DistributionRecorded(pid, asset, period, holding, step, payer, perUnit, total, supplyAtPayment, retire, distributionHash)` | a payout (coupon, redemption, delivery, a default's distribution): O(1), an accumulator |
| `PayoutPaid(pid, asset, period, holder, amount, payoutId)` / `PayoutDeferred(…)` | a payout paid to a wallet (a claim or a push), with its receipt id / one that could not be sent |
| `DistributionSettled(pid, asset, period, paidCount, paidTotal, rollingHash)` | a push round reached the last holder (or was superseded) |
| `TokensUpdated(pid, status, stepsRun, tokens)` | once per transaction: the live BPMN tokens |
| `Deposited` / `Withdrawn(pid, asset, account, base)` | ERC-20 in or out |
| `UnitsTransferred(pid, asset, from, to, amount)` | secondary transfer (a note-token transfer, seen through the engine's hook) |
| `ReportProcessed(pid, step, values, reporter)` | a report is applied; `reporter` is the KeystoneForwarder (CRE) or the fallback reporter |
| `FallbackReporterUpdated(previous, next)` | the owner changed the fallback reporter |
| `Milestone(pid, code, step, actor)` | a step marked as a business event completes (collateral, funding, payments, margin calls, default) |
| `ProcessCompleted(pid)` | no tokens left |

## NotesLens

`NotesLens` (deployed with the engine) is what keepers read:
- **`publish(data)`** stores a registered definition's full bytes (CORE and META), content-addressed and
  checked against the engine. Keepers need META for the oracle feeds, and CRE reads state at a finalized
  block rather than from events.
- **`definitionBytes(id)`** returns them.
- **`running(from, scan, max)`** returns every running process's definition, status, tokens, captured values and
  every role's balance of every asset (escrow included) in one paged call, so a keeper sees what a "Funded?"
  check sees.
- **`position(pid, holder)`**, **`claimable(pid, asset, accounts)`** and **`holders(pid, asset, start, count)`**: a
  holder's tokens, balances and accrued payouts; what accounts can withdraw; the note token's holder set.

It holds no funds and has no owner.

## Caps and gas

Each cap bounds a loop:

| Cap | Value |
|---|---|
| Roles | 8 |
| Fields | 64 |
| Assets | 8 |
| Live tokens | 32 |
| Straight-through steps per transaction | 256 |
| ERC-20 pulls per step | 4 |

Holders are not capped: payouts are an accumulator (docs/ERC20-NOTES.md), so a coupon or a default costs the same
with 10 holders as with 1,000. Measured with `forge test --isolate` (each call priced as its own transaction, cold
storage), 2026-10-24:

| | 10 holders | 1,000 holders |
|---|---|---|
| Strike report with the margin check | 535k | 536k |
| Observation with the margin check | 355k | 356k |
| Payment date, coupon paid from escrow to every holder | 393k | 393k |
| Default (cap-at-owed), owed to every holder, rest to the issuer | 1.00M | 1.00M |
| Default (all-to-holders), cash + USDC + ETH collateral to every holder | 717k | 718k |
| Issuer funds a payment (deposit + move into escrow) | 266k | 266k |

Holders claim payouts with `pushTo(pid, asset, [self])`: 152k gas, with a receipt (the app's default; a plain
`withdraw` is 106k, without one). Pushing payouts to wallets, for notes whose issuer opts in, costs about 55k gas per
holder in batches of 100. A note-token transfer, which settles both sides, costs 176k–263k.

Robinhood Chain is an Arbitrum Orbit chain (Nitro, 32M gas per transaction). The CRE workflow's write gas limit is 8M (CRE
allows 10M per write).

The engine's runtime is 24,051 bytes (the EIP-170 limit is 24,576). `Units` (11,657 bytes: ledger, accumulator,
push), `DefCheck` and `EmailAttest` are separate linked libraries. The NoteToken implementation (5,800 bytes) is
created by the constructor.

## Security

Threat model, findings, static-analysis triage, invariants and coverage: [docs/SECURITY.md](../../docs/SECURITY.md).

```bash
forge test                                   # unit, fuzz (256 runs) and invariant suites (64 runs x 64 calls)
forge test --match-path test/Invariants.t.sol
forge coverage --ir-minimum --no-match-contract Invariants --report summary
```

## Deploying

```bash
CHAIN=robinhood-testnet FORWARDER_MODE=mock OWNER=<deployer> \
  forge script script/Deploy.s.sol --rpc-url <rpc> --private-key <key> --broadcast
```

- **Chains:** `robinhood-testnet` (where notes run) or `robinhood-mainnet`.
- **Output:** writes `deployments/<chain>.json` at the repo root.
- **Forwarder:** `FORWARDER_MODE=mock` trusts the MockKeystoneForwarder, which `cre workflow simulate --broadcast` writes through. `production` trusts the KeystoneForwarder. Robinhood mainnet has no CRE forwarder yet: pass `FORWARDER`.
- **Test tokens (retired):** notes use real tokens only (USDG, WETH, Robinhood's stock tokens). `TEST_TOKENS=1` still
  deploys the old tUSD, tETH, tBTC, tSOL, tTSLA, tNVDA, tAAPL and tSPY (`src/test-tokens/TestToken.sol`) and their
  `TokenFaucet`, for local rehearsals only; scripts/deploy-testnets.sh no longer does on testnets. The deployer must
  be `OWNER` for this (it sets the faucet as minter).
- **Gas:** the engine needs about 6.7M gas of execution; see docs/DEPLOY.md for per-chain funding.
- **EVM version:** the build targets the Paris EVM (no PUSH0 or MCOPY), so one bytecode runs on every target chain.

## Differences from the Solana engine

- **Processes** have numeric ids (`processCount`), not PDAs. Holders are addresses. There is no `open_vault`: the
  engine holds every process's ERC-20, and each process's vault balance is tracked (`vaultOf`).
- **Numbers** are int256 with Solidity's checked arithmetic. Solana uses checked i128, so values that overflowed
  there may succeed here. Truncation is identical: toward zero, `a*b/1e10` and `a*1e10/b`.
- **Distribute** debits the payer once for the whole distribution rather than once per holder. The outcome and
  the failure condition are the same.
- **Ledger cap:** 64 accounts per process (any assets). Solana allowed 64 (owner, asset) entries.
- **Deposits:** up to 4 ERC-20 pulls per step (Solana: 1). Fee-on-transfer tokens are refused.
- **Start step:** `startProcess` checks that cash assets are contracts and issued assets have no token.
- **Pause:** pausing stops new actions but not withdrawals or reports.
- **Not yet ported:** CCIP. `ccip_receive`, `withdraw_remote`, the outbox and payout reports (`0xFFFE`) come in
  Phase 5.

## Cross-chain collateral (planned)

`src/crosschain/`: `HomeGateway` (next to the engine on Robinhood Chain, the home chain), `RemoteVault` (on another
asset chain, e.g. Ethereum) and `RemoteReceipt` (the engine-only claim on locked collateral), over Chainlink CCIP. Not
deployed yet; the engine is unchanged. Design, message formats, trust and the deploy plan: [docs/CROSS-CHAIN.md](../../docs/CROSS-CHAIN.md).

```bash
forge test --match-contract CrossChainTest                    # mock routers: lifecycle, duplicates, forgeries, freezes
CCIP_FORK=true forge test --match-contract CrossChainForkTest # real routers: Robinhood testnet home + Ethereum Sepolia
```

# Security review: notes.markets contracts

Scope: `packages/evm-engine/src` (FlowEngine, its libraries Def / DefCheck / EmailAttest / SSTORE2 / Units,
NoteToken, CreReceiver, NotesLens) and the testnet-only TestToken / TokenFaucet. Engine v4 (note units as ERC-20s,
scale-free payouts, claimed by holders or pushed to wallets: docs/ERC20-NOTES.md) is reviewed in its own section below. Solidity 0.8.24, via-IR, optimizer 200 runs, EVM Paris.
This is an internal review with static analysis, fuzzing and invariant testing. **It is not an audit**; an
independent audit is required before any mainnet deployment that holds real value.

Reviewed 2026-10-24 at the commit that adds this file.

## Roles and trust

| Role | Who | Can | Cannot |
|---|---|---|---|
| Owner (Ownable2Step) | deployer today; a multisig before mainnet | pause/unpause; set the KeystoneForwarder; set the expected CRE workflow id/author/name; set the fallback reporter; set the email verifier and `requireEmail`; revoke an email binding | move, freeze or withdraw anyone's balance; change a registered definition; run a person's step |
| KeystoneForwarder | Chainlink CRE | deliver reports (`onReport`): oracle values for a due oracle step, or an advance | report values outside a definition's per-field bounds; act on a step that holds no token |
| Fallback reporter | off by default; a signed keeper where CRE can't write (Robinhood mainnet) | the same as the forwarder, recorded with its address in `ReportProcessed` | anything else |
| Verifier | the API's attestation key | sign EIP-712 email attestations; revoke them | anything about notes or funds |
| Issuer | a note's creator | start it, approve terms, pledge collateral, fund payments, withdraw its proceeds | withdraw pledged collateral or funded payments (they sit on the engine-held ESCROW account) |
| Holders / investors | anyone (with a verified email when `requireEmail` is on) | subscribe while the book is open, transfer units (v4: the note's ERC-20, to verified addresses only), withdraw what the ledger credits them | take another holder's balance, or units from escrow |
| Payout keeper (v4) | anyone: the issuer bot, a keeper, a holder | push payouts to holders' wallets (`pushPayouts`, `pushTo`), paying the gas | pay anyone but the holder its own accrual; sweep cash that isn't a payout; change amounts |

Trust assumptions:
- **Prices.** CRE reads Chainlink feeds and the engine bounds-checks every value against the definition's
  min/max. Within those bounds the forwarder (or fallback reporter) is trusted to deliver the true price: a
  compromised owner who swaps the forwarder could report any in-bounds price. Mitigation: owner multisig and a
  timelock on `setForwarderAddress`, `setFallbackReporter` and `setExpectedWorkflow*`.
- **Timing.** Steps run on `block.timestamp`; deadlines are hours to days apart, so sequencer timestamp drift
  (seconds) does not change outcomes.
- **Keepers are not trusted with outcomes.** Anyone can `poke` a note; the engine decides what is due.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-1 | **High** (latent) | `withdraw` converted base units to the 10-decimal ledger by truncation. For a token with more than 10 decimals (WETH, Robinhood's 18-decimal stock tokens), a withdrawal smaller than 10^(d−10) debited **nothing** while paying out the tokens, so a holder could drain other holders' share of that note's vault in dust withdrawals. | **Fixed**: the amount must convert exactly (`_toBase(_fromBase(base)) == base`) and debit > 0, else `BadInputs`. Fuzzed with an 18-decimal token. The live testnet engines use 6/8/9-decimal test tokens, where the conversion is exact, so they are not exploitable. |
| F-2 | Medium | `deposit()` let any address credit itself a dust amount, taking one of the note's 64 ledger slots (never released). 64 dust deposits would block every later subscription (`HoldingsFull`). | **Fixed**: only an account the note already holds may `deposit`. The app never calls it (payments are funded through workflow steps). Caught by the access-control invariant when the fix is reverted. |
| F-3 | Medium | The same slot exhaustion is possible with dust **subscriptions** or dust **transfers** to fresh addresses. | **Accepted, mitigated**: with `requireEmail` on, every new holder needs a verifier attestation (the API rate-limits verifications). Recommended for v2: a minimum lot in the subscribe step's guard, and reusing slots whose balances are all zero. |
| F-4 | Low | With a workflow id/author/name check configured, `onReport` decoded 62 bytes of metadata even when fewer were sent (reading past its end). The values read could not match, so it failed closed, but by accident. | **Fixed**: shorter metadata reverts `InvalidMetadata`. |
| F-5 | Low | Owner powers (forwarder, fallback reporter, verifier, pause). `setForwarderAddress(0)` accepts reports from anyone (Chainlink's template emits a `SecurityWarning`). | **Accepted by design**; documented. Before mainnet: multisig owner plus timelock. The owner has no path to user funds. |
| F-6 | Info | An asset's decimals come from the definition, not from `token.decimals()`. A mismatch mis-scales amounts for that note only (its ledger stays internally consistent). | **Accepted**; the app builds definitions from the token's own decimals. Recommended for v2: check `decimals()` at `startProcess`. |
| F-7 | Info | Reports keep running while paused. | **By design**: payment dates are honoured and holders can always withdraw. |
| F-8 | Info | Product limits: an issuer can choose to default (holders then recover only the collateral, capped at what they are owed); margin is checked at the strike and at each observation, not continuously; prices are trusted within each field's bounds. | Documented in docs/NOTE-ECONOMICS.md and the app. |

Checklist (all reviewed; findings above where any):
- **Reentrancy:** every state-changing entry point is `nonReentrant`; ERC-20 calls come last (CEI).
- **Access control:** checked on every external function, by role or owner.
- **Forwarder and metadata validation:** as Chainlink's ReceiverTemplate, plus the length check (F-4).
- **Integer bounds and decimal scaling:** 0.8 checked arithmetic, inputs ≤ int128, decimals ≤ 36 (F-1 fixed).
- **Payout rounding:** `_mul` truncates toward zero, so payouts round down and never overdraw escrow.
- **Loops:** bounded by MAX_HOLDERS / MAX_TOKENS / MAX_ADVANCE / MAX_DEPOSITS.
- **Front-running:** a funding window can't be "done" late (`WindowClosed`), and only the engine closes windows.
- **Attestation replay:** the domain includes chainId and the verifying contract, with a per-holder nonce bumped by every attestation and revocation (tested).
- **ERC-20 handling:** SafeERC20, and fee-on-transfer tokens refused by a balance delta check.
- **Pause:** blocks new actions only.
- **SSTORE2:** pointer code starts with STOP, so it can't be called, and has no selfdestruct or delegatecall.
- **Libraries:** external libraries take explicit storage pointers; no storage collisions.

## Engine v4: ERC-20 note tokens and pushed payouts (2026-10-24)

What changed (docs/ERC20-NOTES.md):

- Each note's units are a NoteToken clone, and the token is the only record of units.
- Payouts are an O(1) accumulator, settled whenever units move.
- Holder transfers go through `beforeNoteTransfer`: verified recipients only, and only while the note runs.
- Holders claim their payouts (`pushTo` for themselves, the default), and anyone may push payouts to wallets in
  batches (for notes whose issuer opts in). Either way each payment carries a receipt id.
- `MAX_HOLDERS`, `transferUnits` and `holdersOf` are gone.

| ID | Severity | Finding | Status |
|---|---|---|---|
| V4-1 | Medium | **Return bomb in a push.** The first version of `_send` used `token.call{gas: 150k}` with Solidity's return-data copy (Slither `return-bomb`). A cash token returning a huge buffer would make the copy burn the batch's gas, so one issuer-chosen token could block pushes. | **Fixed**: `_tryTransfer` calls in assembly and copies at most 32 bytes; it accepts what SafeERC20 accepts. Claims were never affected. |
| V4-2 | Low | **Holder-set reordering.** Swap-and-pop moves the last holder into a seller's slot. If that slot is behind a round's cursor, `pushPayouts` can skip that holder. | **Mitigated**: nothing is lost. The skipped holder's payout stays accrued and claimable. The keeper sweeps each finished round with `pushTo` for every holder still owed (`scripts/issuer-bot.ts`), and the next round pushes it too. |
| V4-3 | Low | **Gas griefing of pushes.** Dust holders make a push walk more addresses. A holder whose wallet burns the 150k gas cap gets deferred. | **Accepted**: a push is permissionless and paid by the caller, and a holder owed nothing costs about 10k gas to skip. Recipients need an email attestation (rate-limited), and deferral never blocks the batch. F-2 and F-3 no longer apply: nothing is capped, so dust deposits or holders block nobody. |
| V4-4 | Info | **External call before state in the token.** `NoteToken._userMove` calls the engine's hook before moving the balances (Slither `reentrancy-no-eth`). | **By design**: the engine must settle at the old balances. The engine is set once at `initialize`, and the hook is `nonReentrant`, so a cash token can't re-enter a transfer mid-push (tested). |
| V4-5 | Info | **Push sweeps only payouts.** `pushTo` could have swept any cash on an account, such as an issuer's raised funds that a later workflow step spends. | **Designed out**: `Book.unpushed` tracks which part of a ledger balance came from payouts (settled or deferred), capped by the balance on every debit. Only that part is pushed (tested). |
| V4-6 | Info | **Read model.** An accumulator credits holders without per-holder events. | **Covered**: `DistributionRecorded` carries payer, perUnit, supply and retire. Every later cash `HoldingChanged` is absolute and includes all accruals, because workflow credits now settle first. The indexer reproduces balances exactly (sdk `payouts.test.ts`; the e2e checks the portfolio against the chain). |
| V4-7 | Info | **Units after redemption.** Retiring is one write: `balanceOf` and `totalSupply` read zero, but the raw balances stay. Payouts made in the retiring step use the raw balances. | **By design**: a redemption must pay in full in the same step that retires (tested). Transfers are refused afterwards. |

Checklist additions:

- **Rounding.** Accumulator floors, so holders' shares never exceed a payout's total. The fuzz test bounds the dust
  at one engine unit per holder per payout, plus under one token base unit per push.
- **No double pay.** Push and claim both move the same checkpoint.
- **Only the engine mints, burns or moves.** The hook answers only the note's own token.
- **Clone initialisation.** `initialize` runs once, in the same transaction as the clone's creation.

## Static analysis

**Slither 0.11.6**, engine v4 (`slither . --filter-paths "^lib/|/lib/openzeppelin|/lib/chainlink|/lib/forge-std|test/|script/"`).
The earlier `lib/` filter also hid `src/lib`, i.e. DefCheck, EmailAttest and Units; they are analysed now.
88 results, triaged:

| Detector | Count | Triage |
|---|---|---|
| return-bomb (`Units._send`) | 1 → 0 | **Fixed** (V4-1) |
| shadowing-local (NotesLens parameters) | 2 → 0 | Fixed (renamed) |
| arbitrary-send-erc20 (`Units._pull`) | 1 | False positive: `from` is always `msg.sender` (a deposit, or the signer of the step that deposits) |
| reentrancy-no-eth / reentrancy-benign / reentrancy-events | 15 | False positive or by design: the calls go to the note's own NoteToken clone or to the cash ERC-20 after the state change; every entry point is `nonReentrant`; the token's hook-first order is V4-4 |
| calls-loop | 31 | Accepted: NotesLens views are read-only; Units loops over at most 8 holdings × 8 assets on our own clones; a push batch is sized by the caller and failure-safe |
| incorrect-equality (`_core`: `id == 0`) | 1 | False positive: an unset sentinel, not a balance |
| uninitialized-local | 6 | False positive: zero-initialised accumulators by intent |
| unused-return (NotesLens, `tryRecover`) | 5 | False positive: deliberate partial destructuring |
| missing-zero-check | 5 | By design: zero means "off" (fallback reporter, verifier, expected author); receipts' constructor arguments are set by the deploy script |
| timestamp | 8 | Accepted: dates are the product (permit deadlines included); seconds of drift don't matter |
| assembly / cyclomatic-complexity / low-level-calls / naming (`DOMAIN_SEPARATOR`) / unindexed-event-address | 16 | Informational. Assembly reviewed and annotated `memory-safe`; the cross-chain low-level calls are the failure-safe transfers documented in docs/CROSS-CHAIN.md |

**Aderyn 0.6.8**:

| Finding | Triage |
|---|---|
| H-1 `abi.encodePacked` collision (SSTORE2) | False positive: it builds creation code and is not hashed |
| H-2 state change after external call (NotesLens.publish) | False positive: a view call to the immutable engine |
| H-3 unsafe casts (FlowEngine) | False positive: each bounded by DefCheck at registration and annotated |
| Lows: centralization, loops, literals, pragma | Documented above, or style |

## Tests

| Suite | What it checks |
|---|---|
| `test/Products.t.sol` (22) | Every product end to end against the reference payoff: funded, missed coupons, cures in grace, half-funded redemption, margin calls cured or not, both default rules, physical delivery, worst-of. It runs twice, once with holders claiming and once with a keeper pushing every payout to wallets. Plus escrow custody, closed windows, oracle bounds, roles, pause, two-step ownership, CRE identity checks, email attestation and gating on the note token (`transfer` and `transferFrom`), and gas with 10 and 1,000 holders (O(1) payouts). |
| `test/NoteTokens.t.sol` (14) | v4: the ERC-20 (clone, 6 decimals, permit, engine-only mint/burn/move, holder set). **Fuzz**: random transfers interleaved with real coupon, default and redemption timelines pay each holder Σ(balance at payment × perUnit); claimable + pushed ≤ distributed; dust bounded. Also: totalSupply == sold − burned; the issuer's unsold units never accrue; 1,000 holders pushed in uneven batches, with every payoutId and the rolling hash recomputed from the logs; frozen recipients deferred, then claimable; no double pay between push and claim; a transfer between a distribution and its push leaves that payout with the seller; `pushTo` never sweeps workflow cash; redemption retires but still pays; transfers refused after completion; 18-decimal physical delivery; no re-entry through a hooked cash token; the lens's `position`/`claimable`/`holders`; gas of transfer, push and claim. |
| `test/CrossChain.t.sol` (16) | Remote collateral (CCIP receipts) through every default rule, with v4 payouts. |
| `test/Invariants.t.sol` | **Invariants** on three notes (paid in full; missed coupon → default; mixed collateral → capped default). Each runs **64 runs × 64 calls = 4,096 calls**, with the timeline interleaved with random note-token transfers, payout pushes of any batch size, withdrawals, deposits, attempts on escrow and stranger reports. The invariants: <ul><li>solvency (the vault covers the ledger and the accrued payouts; the engine holds its vaults);</li><li>units conserved by transfers and never exceeding issuance; the token's supply equals the sum of its holder set's balances, and the set lists only non-zero balances;</li><li>escrow only moved by the workflow;</li><li>only the forwarder reports; a stranger's deposit comes back in full and moves nobody else's balance;</li><li>holders never paid more than the reference, counting what was pushed to their wallets.</li></ul> **Fuzz** properties, 256 runs each: oracle bounds, exact withdrawals with an 18-decimal token, random subscriptions and transfers, funding only while a window is open, email gating for random addresses, only the forwarder reports. |
| `test/TestTokens.t.sol` (6) | Faucet and test token permissions |

Mutation check: removing the F-2 fix makes `invariant_accessControl` fail at once.

Coverage (`forge coverage --ir-minimum`, unit and fuzz suites):

| File | Lines | Branches | Functions |
|---|---|---|---|
| FlowEngine.sol | 94.7% | 63.1% | 95.1% |
| CreReceiver.sol | 93.9% | 81.8% | 100% |
| EmailAttest.sol | 100% | 100% | 100% |
| Def.sol | 92.7% | 100% | 100% |
| DefCheck.sol | 98.5% | 18.8% (one revert per malformed field; the happy path is covered) | 100% |
| NotesLens.sol | 88.7% | 100% | 71.4% |

Bytecode: FlowEngine **24,051 / 24,576** bytes in v4 (23,384 in v3). Units (11,657), DefCheck and EmailAttest are
linked libraries, and the NoteToken implementation (5,800) is created by the constructor. Marking the assembly blocks
memory-safe saved about 1.1 KB.

## Token risk: the cash token can be paused or frozen

Notes settle in **USDG** (Paxos' Global Dollar) on Robinhood Chain testnet,
`0x7E955252E15c84f5768B83c41a71F9eba181802F`. Checked on 2026-10-24:

- It behaves as a plain ERC-20 for the engine: `transfer` and `transferFrom` delivered
  the full amount (no fee on transfer), and `approve` set the allowance.
- It is an upgradeable proxy (EIP-1967), and its admin roles (AccessControl) can call `pause()`, `freeze(address)`
  and `wipeFrozenAddress(address)`. Both are currently unpaused.

What that means for a note: if Paxos pauses USDG, or freezes the engine's address, a holder or the escrow, then
subscriptions, funding, payouts, withdrawals and default distributions in USDG revert until it is lifted. Ledger
balances are kept, so nothing is lost on-chain, but payments stall, and a frozen issuer cannot fund a payment, so the
note could default on schedule. A wiped address loses its USDG outright; if that address is the engine, the engine
would no longer be solvent in USDG. The engine cannot prevent any of this. It is the normal issuer risk of a
regulated stablecoin: disclose it on the term sheet, and prefer collateral in assets with no freeze authority if that
risk matters.

**The stock tokens carry the same risk.** Robinhood's TSLA, AMZN, AMD, PLTR (and NFLX) on Robinhood Chain are
upgradeable proxies (BeaconProxy) whose issuer can pause, freeze or take back tokens; their admin powers were not
audited here. Pledged as collateral or held in a delivery reserve, they sit in the engine's escrow: a freeze of the
engine or a holder stalls withdrawals and deliveries of that token, and a seizure from the engine leaves it short of
what its ledger owes in that token. The engine cannot prevent it; the haircut and the collateral ratio the issuer sets
are the only buffer. Disclose it on the term sheet of any note that pledges or delivers a stock token.

## Before mainnet

1. An independent audit of `packages/evm-engine`.
2. Owner = a multisig, with a timelock on the forwarder, fallback-reporter, workflow-identity and verifier setters.
3. Production KeystoneForwarder with the workflow id, author and name checks set.
4. Verifier, fallback reporter and keeper keys in a KMS or HSM, not files.
5. An on-chain decimals check (F-6), and a minimum lot in the subscribe guard against dust holders that make pushes walk further (V4-3).
6. Real stablecoins and stock tokens, re-tested with their actual decimals.

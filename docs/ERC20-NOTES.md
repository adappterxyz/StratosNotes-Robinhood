# Note units as ERC-20s, with scale-free payouts claimed with a receipt (engine v4)

Each note's units are a standard ERC-20 (`NoteToken`): wallets show them, explorers index them, and holders send
them with `transfer` / `transferFrom` / `permit`. Coupons, redemptions, physical delivery and a default's
distribution cost the same with 10 holders as with 10,000. Chainlink CRE pays each payout into the note on its
payment date; each holder then claims it to their wallet whenever they like (claim by default, §5), and every
payment carries a receipt id that anyone can recompute from the logs. An issuer can opt a note in to pushing
payouts to every wallet at its own cost.

Code: `packages/evm-engine/src/NoteToken.sol` (the token), `src/lib/Units.sol` (ledger, accumulator and push, an
external linked library), `src/FlowEngine.sol` (wiring and the transfer hook). Tests: `test/NoteTokens.t.sol`,
plus every product suite rerun against the reference payoff in claim mode and in push mode.

## 1. The token

| | |
|---|---|
| Deployment | One EIP-1167 clone per issued asset, created by `startProcess` (45 bytes of code each). The implementation is deployed by the engine's constructor. |
| Name / symbol | Passed to `startProcess`, e.g. `notes.markets ETH/BTC Phoenix 26-10` / `nmETHBTC1` (`sdk noteTokenMeta`). |
| Decimals | **6**. The engine's fixed point has 10 decimals, so 1 token base unit = 1e4 engine units. The engine mints, burns and moves only whole token base units (`InexactUnits` otherwise), so the mapping is exact. |
| Balances | Stored in the token (standard ERC-20 storage). **The token is the single source of truth for units.** The engine keeps no unit balances of its own. |
| Supply | `totalSupply == sold − burned`. Subscriptions mint, the issuer's unsold units are burned at the strike, and the redemption retires the rest (see §4). |
| Mint / burn / workflow moves | `engineMint`, `engineBurn`, `engineMove`, `engineRetire`: callable only by the engine. |
| Holder transfers | `transfer`, `transferFrom` and EIP-2612 `permit`. Each calls `engine.beforeNoteTransfer` first (§3). |
| Holder set | Enumerable (`holderCount`, `holderAt`, `holders(start, count)`): the addresses with a non-zero balance, maintained with swap-and-pop. This is what a push walks. |

`FlowEngine.assetTokenOf(pid, 0)` returns the token, `NoteTokenCreated(pid, asset, token)` announces it, and the
API and the app expose it ("Add to wallet" calls `wallet_watchAsset`).

## 2. Payouts: one accumulator per (note, holding, asset)

A workflow's `DISTRIBUTE` used to loop over every holder (with a cap of 64 ledger accounts). It now does one O(1)
update:

```
eligible = token.supply x 1e4 − payer's units        (0 once the units are retired)
total    = floor(eligible x perUnit / 1e10)          debited from the payer at once
acc     += floor(total x 1e30 / eligible)            MAG = 1e30
```

A holder's share is settled lazily, on each holding × asset pair:

```
owed        = floor(units x (acc − checkpoint[holder]) / 1e30)
checkpoint := acc
```

Settlement runs before any change to the holder's units: a mint, a burn, a workflow move, a holder transfer. It
also runs on a withdrawal, on a workflow debit or credit of the account, and when a push reaches the holder. So
**each payout goes to whoever held the units when it was made**, however the units move afterwards.

- **Rounding is in the protocol's favour.** Every step floors, so the holders' shares never add up to more than
  `total`. The remainder stays in the vault as dust: under one engine unit (1e-10) per holder per payout on the
  ledger, and under one token base unit per payment when claimed or pushed (§5). The fuzz test bounds both.
- **The payer's own units take no share.** The payer is settled first, then excluded from `eligible`, and its
  checkpoint is moved past the payout. An issuer holding unsold units, or paying a coupon on units it bought
  back, never needs cash for its own book.
- **Defaults.** Both rules work unchanged on top of this. `cap-at-owed` distributes each escrow asset at
  `take_a / sold` and transfers the remainder to the issuer. `all-to-holders` distributes `balance(ESCROW, a) / sold`.
  Collateral held as cross-chain receipts (`RemoteReceipt`; planned, docs/CROSS-CHAIN.md) is an ordinary cash asset here: holders withdraw the
  receipts and redeem them on the asset chain (`test/CrossChain.t.sol`, every remote-collateral run).
- **Physical delivery** distributes the delivered token per unit through the same accumulator. Tested with an
  18-decimal deliverable.
- **Expressions.** `balance(role, asset)` reads the token for issued assets (zero once retired). For cash it reads
  the ledger plus the accrued payouts, so "Funded?" and the default arithmetic see exactly what the old loop left
  on each account.

## 3. Verified-only transfers

`beforeNoteTransfer(pid, asset, from, to, amount)` is the only entry the token calls.

- It answers only the note's own token.
- It is `nonReentrant` and `whenNotPaused`.
- It refuses `to` = ESCROW or the engine.
- It requires the note to be running (`NotTransferable` once it has completed).
- With `requireEmail` on, it requires a current verified-email attestation for `to`
  (`RecipientEmailNotVerified(to)`).
- There is no allow-list of contracts. A smart wallet or a marketplace contract can hold units if it has an
  attestation, like anyone else.
- It then settles both sides at their current balances. It emits `HoldingChanged` for both, with the balances the
  token is about to write, and `UnitsTransferred`.

`transferFrom` through an approved spender, and `permit`, go through the same hook. The engine's old
`transferUnits` is gone: a transfer is a token transfer (the SDK's `transferUnits` sends it, after checking the
recipient's attestation so the app can explain a refusal).

**Why the indexer needs no token logs.** Every unit balance change (mint, burn, workflow move, holder transfer)
appears as an engine `HoldingChanged`. A holder transfer also logs `UnitsTransferred`, so the read model gets
transfers from the engine's own logs. It doesn't have to discover and index one `Transfer` stream per note token.

## 4. Phases

| Phase | Transfers | Payouts |
|---|---|---|
| Book open, live | allowed (verified recipients) | accrue to holders at each payment |
| Redeemed (a `DISTRIBUTE` with retire) | refused: `balanceOf` and `totalSupply` read 0 | the redemption made in the same step is still paid in full (the engine reads the raw balances, `heldOf`); nothing accrues afterwards |
| Completed (a default, or after redemption) | refused (`NotTransferable`) | what was accrued stays claimable |

Retiring is one write (`engineRetire`) whatever the number of holders. The units stay recorded (`heldOf`,
`supplyHeld`) for the payouts they earned.

## 5. Getting paid: claim by default, push if the issuer opts in

The accumulator is the source of truth. A claim or a push only moves what it says a holder is owed.

The payment itself is automatic either way: on the payment date Chainlink CRE (or the fallback reporter) runs the
step that pays the coupon or the redemption into the note, in one O(1) `DISTRIBUTE`, whatever the number of
holders. Only the last hop, from the note to the holder's wallet, is a choice:

- **Claim (the default).** The holder claims from the portfolio (or the note page) whenever they like and pays
  their own gas. Payouts accrue in the note until then: one claim at maturity collects every coupon and the
  redemption, with a receipt.
- **Push (opt-in).** The issuer chooses it at issuance ("Paid to your wallet automatically, issuer covers gas"),
  and the issuer's bot sends each payment to every holder. Holders can still claim at any time.

| Function | Who | What |
|---|---|---|
| `pushTo(pid, asset, [self])` | **the holder: this is the claim** (the app's "Claim", SDK `claimPayouts`) | Pays the caller-named addresses their accrual **plus payouts already on their account** (a holder who sold since, or a deferred payment). Permissionless, so a holder names itself. It logs `PayoutPaid` with the payment's receipt id. Cash the workflow put on an account (an issuer's raised funds) is never swept: the engine tracks which ledger balance came from payouts. |
| `withdraw(pid, asset, base)` | the holder | Settles, then pays what is on the account, payouts or not, with **no receipt** (only `Withdrawn`). The app uses it for what is not a payout: an issuer's proceeds, delivered tokens, collateral received on a default, cash left after a claim, and every v3 note. |
| `pushPayouts(pid, asset, start, count)` | anyone (the caller pays gas) | Pays holders `[start, start + count)` of the token's holder set. With `start = type(uint256).max` it continues from the round's cursor ("push the next N"). Returns how many holders remain after the cursor. Used by the issuer bot for notes that opted in to push. |

- **One claim covers every period.** A claim pays the latest period of that asset, and that includes everything
  still accrued from earlier periods. The receipt (`PayoutPaid`) carries the latest period.
- **Failure-safe.** Each transfer runs with a 150k gas cap and copies at most 32 bytes of return data. If it fails
  (a frozen or paused stablecoin, a blocked address, a reverting token), the amount stays on the holder's account
  (claimable later) and `PayoutDeferred` is logged; a push batch carries on with the next holder.
- **No double pay.** A claim and a push move the same checkpoint. Whatever one pays, the other sees as zero
  (tested both ways), and a `withdraw` settles first.
- **Order.** A transfer after a distribution but before the claim settles the seller first, so the seller keeps
  that payout and the buyer gets none of it (tested). The seller claims it with the same `pushTo`.
- **Who pushes, when a note opts in.** `scripts/issuer-bot.ts` pushes nothing by default. It pushes notes whose
  term sheet says `payouts: 'push'` (the definition's META; chosen in the issue form), or every note it looks after
  with `PUSH=1`. `PUSH=0` turns pushing off entirely. `PUSH_MIN` skips holders owed less than a minimum (they stay
  claimable), `PUSH_BATCH` (100) sets the holders per transaction, and `PUSH_ONLY=1` runs it as a payout keeper
  for every note under the same policy. Without `PUSH_MIN` it walks the round's cursor, then sweeps with `pushTo`
  any holder the cursor missed (swap-and-pop can reorder the holder set mid-round). The CRE report path never
  pushes: a report's gas would then grow with the book, and the engine has 525 bytes left.

### Why claim by default

Pushing makes the issuer pay about **55k gas per holder per payment** (§6), for every holder, however small the
holding. That cost doesn't scale with what each holder is paid, so:

- **The subsidy runs from large holders to small ones.** The issuer prices its gas into the note's terms, so every
  holder pays for it, but a 1-unit holder costs as much to pay as a 100,000-unit holder.
- **It can be griefed.** Splitting units across many verified addresses multiplies the issuer's cost on every
  payment, for a one-off cost to the holder (the transfers).
- **Dust.** Pushing a payment smaller than the gas it costs wastes money for everyone.

A claim makes each holder pay for their own payment once, when they choose: **~152k gas** for `pushTo` for
themselves (a whole transaction), against **~106k** for a plain `withdraw`. The extra ~46k buys the receipt: the
claim emits `PayoutPaid` with its payoutId, so the per-payment hash receipt (below) survives. A holder who waits
until maturity pays that once for every coupon and the redemption together. No contract change was needed:
`pushTo` was already permissionless. An issuer who wants holders paid without any action on their part opts in and pays the gas.

### Receipts: the hash log

| Event | Fields | Hash |
|---|---|---|
| `DistributionRecorded` | pid, asset, **period**, holding, step, payer, perUnit, total, supplyAtPayment, retire, distributionHash | `keccak256(abi.encode(chainid, engine, pid, asset, period, perUnit, supplyAtPayment))` |
| `PayoutPaid` | pid, asset, period, holder, amount (token base units), payoutId | `keccak256(abi.encode(chainid, engine, pid, asset, period, holder, amount))` |
| `PayoutDeferred` | pid, asset, period, holder, amount | none |
| `DistributionSettled` | pid, asset, period, paidCount, paidTotal, rollingHash | `r_0 = 0`, `r_i = keccak256(abi.encode(r_{i-1}, payoutId_i))`, in push order |

- **Period.** `period` counts the distributions of one cash asset on one note, starting at 1. Coupons, the
  redemption, a delivery and each asset of a default are all distributions. The `step` field says which BPMN step
  made it (Task_Pay2, Task_Default, …), and `retire` marks the redemption.
- **A claim or a push pays the latest period.** A holder's payment in period P includes anything still accrued from earlier
  periods of that asset.
- **Superseded rounds.** A round ends with `DistributionSettled` when a push's cursor passes the last holder, or
  when the next distribution of that asset supersedes it. Its count, total and rolling hash then cover what was
  claimed or pushed in it. Under claim, the latest round usually stays open until the next distribution; its
  receipts are still checked one by one.
- **Checking it.** The SDK's `payoutId`, `distributionHash`, `rollingHash` and `verifyPayouts(events)` recompute
  every value from the logs alone (rounds not settled yet are returned with `settled: false`). `packages/sdk/test/payouts.test.ts` checks them against Solidity's
  `abi.encode`. `test_pushThousandHoldersInBatchesWithReceipts` recomputes 1,000 payoutIds and the rolling hash
  from the logs, and the local e2e does the same against a running stack.

### What a holder sees

- **"Claimable"** (portfolio): what each note owes the holder now, read from the chain (`balanceOf`: payouts not
  claimed yet, plus an issuer's raised cash), with a **Claim** button per note (one transaction: `pushTo` for
  themselves, then a plain `withdraw` of any other cash left) and **Claim all** (one claim per note in turn).
  Issuers **Withdraw** their proceeds there. The note page has the same Claim button, and says how the note pays.
- **"Paid to your wallet"** (portfolio): every `PayoutPaid` to the address (the holder's claims, or pushes on an
  opted-in note), with the payoutId linking to the transaction (`/api/portfolio/:address` returns `payouts`).
- **The read model** (indexer and D1) credits each holder at `DistributionRecorded`, from the unit balances it
  tracks. Every later `HoldingChanged` for that cash account is absolute and already includes everything accrued.
  A claim or a push logs `PayoutPaid`, then the account's new balance. So the model stays exact without per-holder
  payout events. The notifier's "you were paid" amounts come from the same fold (`txDeltas`).

## 6. Gas

`forge test --isolate` prices each call as its own transaction, with cold storage and the 21k base, which is what a
chain charges.

| Report (CRE or fallback) | 10 holders | 1,000 holders |
|---|---|---|
| Coupon paid to every holder | 393,001 | 393,344 |
| Default: cash, USDC and ETH collateral distributed to every holder (cap-at-owed) | 1,000,808 | 1,001,323 |
| Default, all-to-holders | 716,712 | 717,722 |
| Strike, with the margin check | 535,470 | 536,412 |

The v3 engine cost 2.34M gas for a coupon to its maximum of 62 holders, and 5.01M for a default.

| Holder-side operation | Gas (isolated) |
|---|---|
| Note token transfer to a new holder (settles both sides) | 263,054 |
| Note token transfer to an existing holder | 175,929 |
| **Claim with a receipt**: `pushTo` for oneself (a whole transaction) | 152,205 |
| Plain `withdraw` of a settled payout (no receipt) | 106,200 |
| Push, **per holder** inside a batch (1,000 holders, 10 transactions of 100; each wallet's first payment) | 55,251 |

Under claim, the issuer pays none of these: each holder pays ~152k once per claim, whenever they claim. On an
opted-in note, a push of 100 holders is about 5.6M gas, well inside a block. A holder owed nothing costs about 10k gas to
skip. (The per-holder push figure is measured inside one test transaction, with the round's own storage warm and
each holder's storage cold, as it is in a real batch.)

## 7. Trade-offs

- **Claim vs push.** The payment is O(1) either way (the CRE report stays small and fixed). Claim, the default,
  leaves each holder to collect, at their own gas and with a receipt; nothing grows with the book. Push, for notes
  that opt in, moves money to wallets in separate permissionless batches at the issuer's cost (O(n), about 55k gas
  per holder per payment), and claim stays available. A push inside the payment itself would be O(n) and fail as a
  whole if one holder were blocked. See "Why claim by default" in §5.
- **The cost of a transfer.** A holder transfer settles both sides and asks the engine, so it costs 176k–263k gas,
  against 35k–52k for a plain ERC-20. That is the price of exact payouts per holder at payment time, and of
  verified-only transfers.
- **Dust.** A claim or a push rounds each payment down to a whole token base unit (1e-6 USDG). What is left, under
  one base unit, stays on the account and goes out with the next claim.
- **Engine size.** FlowEngine is 24,051 / 24,576 bytes. Units (11.7 KB), DefCheck and EmailAttest are linked
  libraries, and the NoteToken implementation is created by the constructor (it is in initcode, not runtime).
  `transferUnits`, `holdersOf` and `MAX_HOLDERS` were removed.

## 8. Compatibility and upgrade path

- **New events:** `NoteTokenCreated`, `DistributionRecorded`, `PayoutPaid`, `PayoutDeferred`, `DistributionSettled`.
- **Changed ABI:** `startProcess(…, name, symbol)`; `transferUnits` and `holdersOf` removed; `pushPayouts`, `pushTo`,
  `pendingOf` and `beforeNoteTransfer` added.
- **Unchanged:**
  - `withdraw`, `deposit`, `executeStep`, `poke`, reports (CRE and fallback), funding windows, margin, email gating
    and the cross-chain gateway.
  - `balanceOf(pid, owner, asset)` (units from the token; cash = ledger + accrued) and `assetTokenOf` (now also the
    note token).
  - `NotesLens.snapshot` / `running`. The lens adds `position`, `claimable` and `holders`.
- **v3 notes stay on the v3 engine.** Engines aren't upgradeable, and nothing migrates. The indexer keys notes by
  engine address, so v3 notes keep their history and pages. Once the app moves to v4 they take no new
  subscriptions, but holders still withdraw, transfer (the v3 ledger `transferUnits`) and settle them on the v3
  engine. New issuance goes to v4.
- **Old read-model rows are unaffected.** A v3 note never emits the new events.

## 9. v4 deployment on Robinhood Chain testnet

This build deploys v4 fresh on Robinhood Chain testnet, the only note chain (docs/DEPLOY.md): no earlier engine is
kept running next to it, so the legacy-engine path above has no entries today. (The earlier build ran v4 next to v3 on
two testnets; its records are in `deployments/archive/arbitrum-build/`.)

| Chain | Gas | At ~0.01 gwei |
|---|---|---|
| Robinhood Chain testnet | Units 2.62M + FlowEngine 6.62M (with the NoteToken implementation) + NotesLens 1.67M + setEmailPolicy ≈ **11.0M** | ≈ 0.00011 ETH |

DefCheck and EmailAttest are reused at their deterministic addresses when already deployed. Gas was measured by the
local fork deployment of `scripts/dev-local-d1.sh`.

1. **Rehearse.** `REHEARSAL=1 SEED=1 CHAINS=robinhood-testnet bash scripts/deploy-testnets.sh` against a local fork.
2. **Deploy.** `CHAINS=robinhood-testnet bash scripts/deploy-testnets.sh` deploys the engine and lens with the
   verifier and `requireEmail`, the MockKeystoneForwarder, and the fallback reporter off. It writes
   `deployments/robinhood-testnet.json` and the CRE and server configs.
3. **Read model.** Reset the D1 read model (`web/reset/0000_robinhood_reset.sql`), so the indexer starts from the new
   engine's deployment block under the chain key `robinhood-testnet`.
4. **Workers and bots.** Deploy the Worker (`npm run deploy`). Start the CRE keeper and the issuer bot
   (`ops/ecosystem.config.cjs`): it pushes nothing by default (claim), only notes whose terms opt in to push (or set
   `PUSH=1` with `PIDS` to push chosen notes). Add a `PUSH_ONLY=1` payout keeper only if an opted-in note's issuer
   bot isn't running.
5. **Seed and verify.** Seed notes (`scripts/seed.sh`), subscribe two investors, let a coupon run, then check:
   - each investor claims it from the portfolio and the wallet receives it (`PayoutPaid`, one per claim);
   - `verifyPayouts` passes on the note's history;
   - the portfolio shows "Paid to your wallet";
   - "Add to wallet" shows the units.

   Record the transactions in docs/evidence.json.

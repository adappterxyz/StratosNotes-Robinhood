# Planned: collateral on other chains (home = Robinhood Chain)

**Status: planned, not deployed.** Notes run on **Robinhood Chain testnet**, and today every collateral asset is a
token on Robinhood Chain pledged straight into the note (USDG, WETH, TSLA, AMZN, AMD, PLTR). This document is the
design for the next step: **collateral that stays on another chain** (an "asset chain", e.g. USDC or WETH on Ethereum
or another L2) while the note runs on Robinhood Chain, the **home chain**. Chainlink **CCIP** would carry the two
value commands between the chains and Chainlink **CRE** would check every run that each vault still backs what the
note counts. Nothing is bridged and no wrapped token can be traded.

What exists today:
- The contracts and their tests: `HomeGateway`, `RemoteReceipt` (home side) and `RemoteVault` (asset side) in
  `packages/evm-engine/src/crosschain/`, `script/DeployCrossChain.s.sol`, and the Foundry suites `CrossChain*.t.sol`
  (Chainlink Local, mock routers, and fork tests).
- The off-chain decisions (pure, unit-tested) in `packages/core/src/crosschain.ts`, the keeper's flush and vault
  checks in `cre/notes-keeper-evm`, and the app's cross-chain panels.
- **Nothing is wired:** there is no `deployments/crosschain-testnet.json`, so the served config has no `crossChain`
  entry, the app hides every cross-chain panel (lock, redeem, release tracking), the keeper's `gateways` and `vaults`
  lists are empty, and core's `REMOTE_COLLATERAL` is empty (a term sheet naming a remote collateral chain is refused).

The mechanism is proven: the earlier Arbitrum build ran it live, the other way round (home Arbitrum Sepolia, vault on
Robinhood Chain), with one lock and one release delivered by Chainlink CCIP and a TSLA-backed note run start to finish
([Evidence](#evidence-from-the-earlier-arbitrum-build-home-arbitrum-sepolia-vault-on-robinhood-chain-2026-10-24)).

**Principle: collateral stays on its own chain; Robinhood Chain is the anchor.** The note's single home (FlowEngine on
Robinhood Chain) decides who gets the collateral; the collateral itself never leaves its chain. When a note pays
collateral out (to holders on a default, back to the issuer at maturity), the receipts are burned on Robinhood Chain in
that same transaction and the release is sent automatically over CCIP; the vault pays the real token on the asset
chain to the same address. Nobody holds a receipt after a note, and nobody has to redeem one.

## How it works

```
          Asset chain (e.g. Ethereum)                          Robinhood Chain (home chain)
 ┌────────────────────────────────────────┐         ┌──────────────────────────────────────────────────┐
 │ RemoteVault                            │  LOCKED │ HomeGateway ──mints──► RemoteReceipt (USDC.eth)   │
 │  lock(USDC, 1000, issuer) ────────────────CCIP──►│                          │  pledged as collateral │
 │  locked[USDC] += 1000                  │         │                          ▼                        │
 │                                        │         │ FlowEngine: escrow, coverage (price x haircut,     │
 │                                        │         │   summed over local + remote collateral), margin, │
 │                                        │         │   release at maturity, default (cap-at-owed)      │
 │  pay USDC to issuer / holder ◄──────────CCIP────│ receipts leave the engine → burned, queued        │
 │  locked[USDC] -= amount        RELEASE │         │ flush (CRE report / anyone; fee pool) ──► RELEASE │
 └────────────────────────────────────────┘         └──────────────────────────────────────────────────┘
          ▲                                                       ▲
          └──────── Chainlink CRE reads both every run ───────────┘
                    (vault balance vs locked vs receipts outstanding)
```

1. **Lock.** The issuer locks the real token in the vault on the asset chain (`lock(token, amount, beneficiary)`,
   CCIP fee in native gas). The vault sends **LOCKED**; the gateway on Robinhood Chain mints the same amount of
   receipts (e.g. `USDC.eth`) to the beneficiary.
2. **Pledge.** The issuer pledges the receipts into the note at Approve Terms (or a margin top-up), exactly like a
   local collateral token. The note values them with the token's Chainlink price and the haircut the issuer set, and
   coverage sums every collateral asset, local (TSLA, USDG on Robinhood Chain) or remote, on any number of asset
   chains.
3. **Run.** Observations, coupons, margin calls, the grace period and the default rule are the engine's
   unchanged, reference-tested paths.
4. **Paid in full.** The engine credits the receipts to the issuer's ledger in the note. When they leave the
   engine (the issuer's withdraw), the receipt burns them and the gateway **queues a RELEASE** to the issuer's
   address on the asset chain. The issuer bot does that withdraw automatically once the note has ended (below).
5. **Default.** The engine pays the receipts to the holders as a payout (cap-at-owed: what they are owed, the
   excess to the issuer's ledger). Each holder's share leaves the engine on a `pushTo`: burned and queued the same
   way, to the holder's address on the asset chain. The issuer bot pushes every holder's receipts automatically; a
   holder's own claim does the same.
6. **Flush.** Chainlink CRE writes a report to the gateway (`onReport` through the KeystoneForwarder on Robinhood
   Chain) that sends the queued RELEASEs, paying each CCIP fee from the gateway's ETH **fee pool**; anyone can call
   `flush` too (the issuer bot does, as a late fallback), and anyone can send one queued release with their own fee
   (`sendQueued`). The vault pays the real token; the app shows "Released to your wallet on <asset chain>" with the
   CCIP message.

### Automation: receipts never wait inside the engine

The engine is unchanged, so a receipt only burns and queues when something moves it OUT of the engine. Left alone,
a paid-in-full note's collateral would sit on the issuer's ledger and a default's on the holders' accounts (the
live proof in the earlier build needed a manual withdraw). The issuer bot (`scripts/issuer-bot.ts`) closes that
gap, with the decisions in pure, unit-tested functions in packages/core/src/crosschain.ts:

| Case | What the bot does | Decision |
|---|---|---|
| Note paid in full (or a capped default's excess), note no longer running | `withdraw(pid, asset, base)` of every receipt asset on the issuer's ledger: burned, RELEASE queued to the issuer | `planReceiptWithdrawals` (whole base units only, `withdrawableBase`; nothing while the note runs) |
| Default: receipts distributed to holders | `pushTo(pid, asset, holders)` for every holder owed at least one base unit, `RECEIPT_BATCH` (25) per transaction, gas set to 200k + 250k per holder (each transfer gets the engine's full 150k push cap; the receipt hook takes ~102k) | `planReceiptPush`, `receiptPushGas` |
| Releases queued | `flush` only for releases waiting longer than `FLUSH_AFTER` (180 s): CRE is primary (about every minute) | `overdueReleases` + `planFallbackFlush` |

- **Receipts only.** A receipt is a token the gateway's registry knows (`receiptInfo(token)` non-zero; the
  gateway must report `VERSION() >= 2`). Cash payouts (USDG) stay claim-by-default under the bot's `PUSH` policy;
  receipt payouts are pushed whatever `PUSH` says (`RECEIPTS=0` turns the receipt automation off). With
  `PUSH_ONLY=1` the bot does the receipt pushes for every note (or `PIDS`), with any funded key.
- **Explicit push gas.** The engine gives each pushed transfer at most 150k and a transfer that runs out is
  deferred, not reverted, so a gas estimate that merely avoids a revert could defer every holder. One pass per
  payout round; a holder whose transfer was deferred stays claimable and is logged, not retried.
- **Queued time.** The gateway does not store when a release was queued; the bot takes the block time of the
  release's first `ReleaseQueued` event (scanned from `GATEWAY_FROM_BLOCK`, default the config's `gatewayBlock`, in
  `LOG_CHUNK` blocks) and skips releases already sent (`ReleaseSent`). A release whose event it cannot find counts
  from when the bot first saw it: never flushed ahead of CRE on a guess.
- **Gateway.** `GATEWAY`, or `home.gateway` of `CROSSCHAIN_CONFIG` (default deployments/crosschain-testnet.json, absent
  today) when its chain id and engine are the bot's (`GATEWAY=` empty or no file: none).
- **Other automation.** The CRE keeper (cre/notes-keeper-evm) flushes; it does not withdraw or push (it writes
  reports only). services/keeper-fallback stands in for CRE's engine reports where CRE cannot write (Robinhood Chain
  mainnet today); a home gateway there would need the flush (planFlush, no delay) and the same receipt pushes from
  it.
- **End to end on a fork** (earlier build): `bash scripts/e2e-xc-autorelease.sh` ran on an anvil fork of the then
  live home chain (engine v4 and gateway v2, receipts minted by impersonating the gateway): a note paid in full -> the bot withdraws ->
  `ReleaseQueued` to the issuer; a note that defaults -> the bot pushes the holders -> `ReleaseQueued` per holder;
  both flushed by the bot only after `FLUSH_AFTER` (the real router on the fork emits `ReleaseSent`).

Receipts a locker holds and never pledged are ordinary: pledge them into a note, or `redeem` them at the gateway
(burn + RELEASE, the caller pays the fee) to unlock the tokens on the asset chain.

### Design decisions

- **No engine change.** The first design put a "remote collateral" hook in the engine. It is not needed: a
  receipt is an ERC-20 the engine already handles as collateral, so pledging, coverage, margin, release and both
  default rules run on code that every product test already checks against the reference payoff. The engine
  (23,384 / 24,576 bytes) stays as deployed and audited-in-progress.
- **Receipts are not a bridge.** `RemoteReceipt` moves only into the engine (pledge in); out of it, it is burned.
  It cannot be sent between people, so there is no tradable wrapped token. It is minted only for a CCIP-verified
  lock and burned only on redemption or on leaving the engine.
- **Auto-release in the receipt, not in the engine (v2).** The burn-and-queue is the receipt's own transfer hook
  (`_update`: from the engine to anyone → burn, `gateway.queueRelease(to, amount)`), so the engine stays unchanged
  and every exit path (withdraw, a holder's claim, `pushPayouts`/`pushTo`, the issuer's release) is covered by
  the same few lines. Queueing is cheap and makes no external call: 2 storage slots per new release (measured in
  the table below), well under the 150k gas the engine gives each pushed transfer, so a push never defers.
- **Queue, then flush; one message per release.** The transfer cannot send CCIP itself: it would need the fee
  inside a capped push and would make every withdraw depend on CCIP. Queueing decouples them: the release is
  recorded atomically with the burn, and sending happens later in batches. Each release is still its own CCIP
  message, so every execution on the vault stays small and bounded (~82k gas) whatever the number of holders, and
  one frozen recipient never blocks the others (out-of-order execution; the vault records it as `unclaimed`).
- **Fee pool, permissionless flush, CRE automation.** The gateway holds native ETH (`fundFees` or a plain
  transfer: the issuer at pledge, the protocol). `flush(maxItems)` sends queued releases oldest first, at most 25
  per call, and stops at the first one the pool cannot pay for (`FlushStalled`): it stays queued and goes on the
  next flush. A CRE report triggers the same flush, so releases go out without anyone acting; the issuer bot
  flushes as a late fallback (releases older than `FLUSH_AFTER`, 180 s). `sendQueued(index)` lets anyone (the holder) send one release paying the fee
  themselves: no release ever depends on the pool or the queue order.
- **Dust cannot drain the pool.** Releases to the same (receipt, recipient) that are not sent yet add up into one
  queue entry, so many small withdrawals between two flushes cost the pool one message, not one each.
- **Smart wallets.** A release goes to the same address on the asset chain. A contract wallet that does not
  exist there sets `setReleaseAddress(dest)` first (applies to releases queued afterwards).
- **Authorisation without per-note registration.** The vault does not need to know which note a lock is for: the
  receipts go to the locker (or a beneficiary they name), and only a note's issuer can pledge into that note (the
  engine's role checks). So a lock can never be credited to someone else's note.
- **Many asset chains.** The gateway keeps an allow-list per (CCIP chain selector, vault), and one receipt per
  (chain, token). Adding a chain is configuration: deploy a vault there, `setRemote`, `registerReceipt`. The
  tests run one note with collateral on two remote chains at once (stablecoin on one, ETH on another).
- **Stablecoins and stocks can be frozen.** Paxos USDG and tokenized-stock issuers can pause, freeze or seize.
  A release to a frozen account does not revert (which would leave a stuck CCIP message): the amount is recorded
  as `unclaimed` and the account `claim`s it later. A seizure from the vault itself makes the vault's backing
  fall below `locked`; CRE reports it (see Trust).

## Message formats

Both are `abi.encode(uint8 kind, bytes32 id, address account, address remoteToken, uint256 amount)`, sent as
data-only CCIP messages (no CCIP token transfer), fee in native gas, `GenericExtraArgsV2{gasLimit,
allowOutOfOrderExecution: true}`:

| kind | Direction | `id` | `account` | Effect |
|---|---|---|---|---|
| 1 LOCKED | vault → gateway | `keccak(chainid, vault, lockNonce)` | receipt beneficiary | mint receipts (once per id) |
| 2 RELEASE | gateway → vault | `keccak(chainid, gateway, redeemNonce)` (redeem) or `keccak(chainid, gateway, "release", queueIndex)` (auto-release) | recipient on the asset chain | pay the locked token (once per id) |

The two id forms have different preimage lengths, so a redeem id never equals a queued release's id. The vault's
`released[id]` check is unchanged: it enforces at most once for both.

The gateway accepts LOCKED only from the vault configured for the message's source chain selector, and only
through its CCIP router; the vault accepts RELEASE only from the home chain selector and the configured gateway.

## State machines

- **Lock** `id`: (sent on the asset chain, `locked` already increased) → **credited** at home (receipts minted).
  A duplicate delivery of the same id is acknowledged and ignored. A lock of a token with no receipt yet reverts
  at home and stays executable: register the receipt, then execute the message manually.
- **Redemption** `id`: receipts **burned** at home → **paid** on the asset chain (`locked` decreased, token
  transferred) or **unclaimed** (recipient frozen; `claim` later). A duplicate is ignored. A release larger than
  what is locked reverts (cannot happen while the invariant holds) and stays executable.
- **Auto-release** `index`: receipts **burned** leaving the engine → **queued** at the gateway (`ReleaseQueued`;
  joins an unsent release to the same recipient) → **sent** exactly once (`ReleaseSent` with the CCIP
  `messageId`, by `flush` from the pool or `sendQueued` with the caller's fee; `sent` is set before the send) →
  **paid** or **unclaimed** on the asset chain, as a redemption. While the pool is short, the chain has no vault
  configured or the gateway is paused, it stays queued; nothing is ever dropped.
- **Invariant:** `locked[token]` ≥ receipts outstanding at home, with equality when nothing is queued or in
  flight; the vault's balance minus unclaimed ≥ `locked[token]` unless the token took tokens back.

## Trust and failure modes

- **What you trust:** Chainlink CCIP to deliver the authenticated message once (plus our id check), the gateway
  and vault owners to configure the right peer (they cannot move anyone's tokens; the gateway owner can withdraw
  the fee pool, never a release), and the token issuers (USDG/stock tokens can freeze or seize: that is the
  asset's own risk and CRE reports it). Liveness of auto-releases needs someone to pay the CCIP fee: the pool
  (funded by the issuer or the protocol) through CRE or any flusher, or the holder through `sendQueued`.
- **Who can queue.** Only a receipt the gateway created (`queueRelease` checks `receiptInfo[msg.sender]`), and a
  receipt queues only for what it just burned leaving the engine. The CRE report is accepted only from the
  configured KeystoneForwarder (the engine's own; optionally pinned to a workflow id/owner, as on the engine); it
  can only trigger a flush, which can only send what is queued, to whom it is queued for.
- **Latency.** A CCIP message executes after its source chain is final. Robinhood Chain is an Arbitrum Orbit chain,
  so a message from it waits for the L1 (Ethereum) finality of its batch, and a message to it waits for the asset
  chain's own finality: roughly 15–25 minutes per message on these lanes. Measured in the earlier build: 21.5 min
  Robinhood Chain testnet → Arbitrum Sepolia and 17.5 min back (see Evidence); on the Solana build, 35–40 min
  Sepolia → Solana and about 1 min Solana → Sepolia. So: lock collateral well before the strike; size the
  grace period of a note with remote collateral at a few hours, not minutes; a margin top-up from a remote
  chain arrives ~20 minutes after it is sent (the test suite replays exactly this: the top-up fails until the
  message lands, then succeeds inside grace).
- **Retries and manual execution.** A message that reverts on the destination (e.g. a token not registered yet)
  stays in CCIP and can be executed manually from the CCIP Explorer after the cause is fixed; ids make that safe.
- **Stuck messages.** Out-of-order execution is on, so one failed message never blocks another lock or
  redemption.
- **Shortfall.** CRE reads `locked`, `unclaimedTotal` and the token balance of each vault and the receipts'
  `totalSupply` at home every run, and logs `[collateral shortfall]` (packages/core/src/crosschain.ts). In stage 1
  that is a report for operators and the app; stage 2 can let CRE write it into the note so coverage drops and a
  margin call opens.
- **Pause.** Pausing the gateway stops outbound messages (redeem, flush, sendQueued; a CRE flush report is then a
  no-op rather than a revert), never queueing: holders can still withdraw from the engine while it is paused, and
  their releases wait in the queue. Pausing a vault stops new locks. Neither stops a release already sent, and
  holders can always claim.

## Fees and gas

- CCIP fees are paid in the native token (ETH on Robinhood Chain; LINK also accepted by the routers). The caller of
  `lock`, `redeem` or `sendQueued` pays; `quoteLock` / `quoteRedeem` return the fee, excess is refunded.
  Auto-releases are paid from the gateway's fee pool: about one RELEASE fee (≈ 0.00005 ETH measured on Arbitrum Sepolia in the earlier build)
  per holder paid collateral plus one for the issuer, so an issuer funding ~0.005 ETH at pledge covers a full
  book with room to spare. `releaseQueue()` returns the pool and the next fee.
- Destination gas limits: 200,000 for LOCKED (measured ~118k: decode, check, mint) and 300,000 for RELEASE
  (measured ~82k: decode, check, transfer; headroom for tokens with transfer hooks). Both configurable.
- Fees quoted by the real routers on forks in the earlier build (2026-10-24): lock on Robinhood Chain testnet ≈
  0.000067 ETH, redeem or a queued release on Arbitrum Sepolia ≈ 0.000051 ETH per message.
- Auto-release gas (measured, `forge test --match-path "test/CrossChain*"`; the fork rows in the earlier build):

  | What | Gas | Bound |
  |---|---|---|
  | Receipt leaving the engine, burned + new release queued (worst case: first release ever, all cold) | ~102,000 | engine push cap 150,000 per transfer (a call with exactly 150k succeeds in the tests) |
  | Same, joining an unsent release to the same recipient | ~9,500 | |
  | `pushTo` of a default's collateral to 2 holders, both queued (engine + receipts + gateway) | ~295,000 | |
  | `flush` of 1 release on the real Arbitrum Sepolia router (fork, Chainlink Local) | ~270,000 | report gas: 150k + 300k per release |
  | CRE flush report of 2 releases incl. their RELEASE execution on the vault (Chainlink Local, same chain) | ~239,000 | |
  | CRE flush report through the real MockKeystoneForwarder (`cre workflow simulate --broadcast`, Arbitrum Sepolia fork, real router), 1 / 2 releases | ~395,000 / ~580,000 | keeper config: 250k + 300k per release |
  | RELEASE execution on the vault (unchanged) | ~82,000 | destination gas limit 300,000 |

- Bytecode: HomeGateway v2 17,837 B (was 10,678; it creates the receipts and is now a CRE receiver),
  RemoteReceipt v2 3,588 B, RemoteVault 6,734 B (unchanged); all under 24,576. The engine is unchanged.

## Chainlink CRE: the flush report (for the keeper workflow)

The gateway is a CRE receiver exactly like the engine (`CreReceiver`: only the configured KeystoneForwarder may
call `onReport`; optional workflow id / owner / name checks, off by default). The keeper needs one read and, when
it says so, one write per run, on the home chain (Robinhood Chain):

- **Read** (at `latest` is fine: the gateway re-checks everything) `HomeGateway.releaseQueue()` →
  `(uint256 pending, uint256 head, uint256 queued, uint256 pool, uint256 nextFee)`: releases waiting, the index
  flush starts at, the last index, the fee pool (wei) and the CCIP fee of the oldest waiting release (0 when
  nothing waits, or its chain has no vault configured). ABI fragment: `releaseQueueAbi` in
  packages/core/src/crosschain.ts.
- **Decide** with `planFlush(reading, { maxItems?, baseGas?, gasPerItem? })` (packages/core/src/crosschain.ts):
  no write when `pending == 0`, when `pool < nextFee` (`pool-short`: log it, the issuer or protocol tops up) or
  when `nextFee == 0` with something pending (`no-vault`: an operator issue). Otherwise
  `maxItems = min(pending, pool / nextFee, cap)` (cap default 10, the gateway never sends more than 25) and
  `gasLimit = 150,000 + 300,000 × maxItems`.
- **Write** `encodeFlushReport(maxItems)` = `abi.encode(uint8 kind = 1, uint256 maxItems)` (64 bytes) through
  `runtime.report(prepareReportRequest(hex))` and `evm.writeReport({ receiver: <gateway>, report, gasConfig: {
  gasLimit } })`, the same calls the engine reports use. The report never reverts on an empty queue, an empty
  pool or a paused gateway (it is a no-op); it reverts only for a kind other than 1 or a sender other than the
  forwarder. Releases sent emit `ReleaseSent(index, releaseId, to, receipt, amount, messageId, fee, fromPool)`.
- **Config** the keeper needs per home chain: the gateway address (deployments/crosschain-testnet.json
  `home.gateway`) and its gas settings. The issuer bot's fallback flush only sends releases that have waited more
  than `FLUSH_AFTER` (180 s), so CRE sends them first; a race is harmless anyway: whoever is second finds less (or
  nothing) to send.
- **Wired, empty today** (cre/notes-keeper-evm/main.ts): config `gateways: [{ chainSelectorName, gateway, maxItems,
  baseGas, gasPerItem, stateBlock }]`, emitted by `scripts/cre-config.ts staging` from `home.gateway` when
  `home.version >= 2` (`keeperGateways`; base gas 250k: one release through the forwarder measured ~395k). Each run,
  after the engine reports: one read per gateway (skipped when the run's 15 reads are spent), one log line (`<chain>
  gateway flush: N release(s) waiting … -> flush up to n (gas g)` or `-> no report (empty | pool-short | no-vault)`),
  and the report, which counts against `maxReportsPerRun`. The run's result lists it under `flushed`. With no
  deployments/crosschain-testnet.json, `gateways` and `vaults` are left out and the keeper does none of this. Verified
  in the earlier build on a fork of its home chain against the live gateway: the simulator's flush report emitted
  `ReleaseSent` with CCIP message ids from the real router.

## Turning it on (home = Robinhood Chain)

1. Pick the asset chain and its tokens (a token there with a Chainlink feed CRE can read; a CCIP lane to Robinhood
   Chain testnet in both directions).
2. Robinhood Chain testnet: `ROLE=gateway CHAIN=robinhood-testnet ENGINE=<engine> OWNER=… FEE_POOL=…` → HomeGateway
   (the CCIP router for Robinhood Chain testnet, CRE forwarder = the engine's).
3. Asset chain: `ROLE=vault` → RemoteVault (home selector = Robinhood Chain testnet's), allow the tokens.
4. Robinhood Chain testnet: `ROLE=wire` → `setRemote(<asset selector>, vault)`, receipts per token (e.g. `USDC.eth`).
5. Record them in `deployments/crosschain-testnet.json` (`home.chain: robinhood-testnet`, `home.gateway`,
   `home.version: 2`, `remotes[]` with receipts); add the receipts to core's `REMOTE_COLLATERAL` under the
   collateral-chain key the app offers; regenerate the server config (`scripts/server-config.ts`: `crossChain` on the
   chain, receipts as tokens) and the CRE config (`scripts/cre-config.ts staging`: `gateways` and `vaults`, plus a
   CRE chain name for the asset chain in `CRE_NAMES`); run the issuer bot with the gateway as the flush fallback.

Later stages:
- Subscriptions from the asset chain: an investor pays a stablecoin there, the vault sends SUBSCRIBE, the gateway
  subscribes for them on Robinhood Chain (units held for the same address).
- Payments to the asset chain: coupons and redemptions funded by the issuer there and paid to holders there, with the
  engine as the ledger of who is owed what.
- Shortfall enforcement: CRE writes the vault backing into the note, so a seized vault opens a margin call.

## Evidence from the earlier Arbitrum build (home Arbitrum Sepolia, vault on Robinhood Chain, 2026-10-24)

History, kept as evidence that the mechanism works. In the earlier build notes ran on **Arbitrum Sepolia** (the home
chain, HomeGateway) and stock collateral stayed in a **RemoteVault on Robinhood Chain testnet**, credited as `.rh`
receipts. Those contracts are not used by this build; their records are in `deployments/archive/arbitrum-build/`
(`v4/crosschain-testnet.json`, `xc-1/`, `v3/`). The texts below are as written then.

### Testnet deployment (live)

| Contract | Network | Address |
|---|---|---|
| HomeGateway | Arbitrum Sepolia | `0xcdee38dEbC2eE59Ae486c0829ff6a0028a5eFaEC` (deploy tx `0x7540437a…899e59c`, block 322236840) |
| RemoteVault | Robinhood Chain testnet | `0xfB8b030FF7C059665daB3aF2D77F72445E341300` |
| USDG.rh / TSLA.rh / AMZN.rh / NFLX.rh | Arbitrum Sepolia | `0x62f28cF2…1B67` / `0xcDb6f71F…AAc2` / `0x67c475C9…FDD9` / `0xD07f12Fa…48e9` |
| tTSLA.rh (our test token, for the live proof) | Arbitrum Sepolia | `0x4A201075…de9B` |

Full record: `deployments/crosschain-testnet.json`. Checked on-chain: code present (gateway 10,678 B, vault 6,734 B),
owner is the deployer, the vault's home selector and gateway and the gateway's remote vault (gas limit 300k) match,
the five tokens are allowed in the vault, and each receipt has the right decimals, gateway and remote token. Routers
match Chainlink's CCIP API (`/api/ccip/v1/chains`).

#### Live CCIP proof

The deployer acted as a temporary demo issuer and used our own test token (tTSLA, 9 decimals) on Robinhood, since
the faucet-only tokens need a browser.

| Leg | Source tx | CCIP message | Delivered | Time |
|---|---|---|---|---|
| LOCK 10 tTSLA, Robinhood → Arbitrum | `0x9d40acc3bc4e1707db95d6b48535e19e7a7f84ff824bb471dc037e9e08fd2d37` (block 141642720) | [`0x8111a057…3248`](https://ccip.chain.link/msg/0x8111a05781382b60b8ac56118a77c4a23e0536b8ed34978abe8cb7b97b8f3248) | `0xa960b6c3128d9879a62e69580cf9dee75a3c8680dbcbadcf04fb762ac882b8bc`: 10 tTSLA.rh minted | **1,292 s (21 min 32 s)**, executed automatically by the CCIP network |
| RELEASE 10 tTSLA.rh, Arbitrum → Robinhood | `0x1506ac86d61d3e5639b34e14cdeef8cb7eb682cbc67ad19a79ff228cf643efc5` (block 322242530) | [`0x48755825…a7cd3`](https://ccip.chain.link/msg/0x487558251499ae682ba78305d4355a6bd42fcae05277e4a17e0974be96fa7cd3) | `0x488a6fe75a57936c7123abc49d13025c1a1efecdbaa00cedd8d2d378a64ba39a`: vault released 10 tTSLA to the sender | **1,047 s (17 min 27 s)**, executed automatically |

Times are source-block to destination-block timestamps. Neither message needed manual execution. Fees paid in native ETH: lock 0.0000674 ETH (Robinhood), release 0.0000504 ETH (Arbitrum Sepolia).

#### Live v2 proof: TSLA locked on Robinhood backs an Arbitrum note, then comes home (2026-10-24)

Gateway v2 `0x4C393Ed28Cc1825CfBA5A4d6F2223589249C3a89` (Arbitrum Sepolia), vault `0x6a11Ff8DD08d63Dc2a7C7AB6116d1F40Bf20d1C2`
(Robinhood Chain testnet). The earlier pair (`0x3551…372A` / `0xE7a7…8846`) still holds 100 USDG for receipts already in a
wallet, so it was left in place (deployments/archive/xc-1) rather than re-pointed.

| Step (UTC) | Chain | Transaction |
|---|---|---|
| 14:56 lock 3 TSLA (Robinhood's own token) in the vault | Robinhood | `0xf4c7638f209771458a1899f63bea18d6a7d1f23f3b0f22b42e716c1661af90a4`, CCIP `0x5748e6f558f8c7c329c28891b8e18dd2d8772c4eb5fb5aa5172c065c7c33712a` |
| 15:17 3 TSLA.rh credited by CCIP (about 21 min) | Arbitrum | — |
| 15:18 note pid 2 issued, its only collateral the 3 TSLA.rh (60% haircut) | Arbitrum | `0x56ac84f32956e1934539c0dd30bed9d948222bc9517b149c428d278fd81beb99` |
| 15:23 strike: CRE reads TSLA 372.07 from Robinhood Chain mainnet's Chainlink feed (HTTP) | Arbitrum | `0xe184aa4cd6b5531e47d69706c26c5a4c7f8f07f84c7f42eac641f000480a4f5b` |
| 15:28 / 15:33 observations by CRE | Arbitrum | `0xfc82d555760e061e84565a7ac8b89bd68de92c13323eb5ae06d8e80783efd309`, `0xf1bdd91324ceb560562baeb72b128cba9026b07cf4aa32720e0bfacec19a34fe` |
| ~15:35 coupon and redemption funded by the issuer bot; note redeemed | Arbitrum | — |
| 15:38 issuer withdraws the collateral: TSLA.rh burned, release queued | Arbitrum | `0x48a13e1cf311c9c87ea7d24ed3a3ac5015576070326a2e711f3fc99460a5f11f` |
| 15:38 release sent over CCIP from the fee pool (by the issuer bot's fallback flush) | Arbitrum | `0x924d033572f5a6561c8e674ffa27a53c52e217ec19c271264111a32fdd193a29`, CCIP `0xc42011d623aebeda428e368e605ac4480ee6cc32b6dca65decc2e18bc7f30b99` |
| 15:56 vault pays the 3 TSLA back to the issuer (about 18 min) | Robinhood | `0x9f7f323d9b8f4dd76c7eda3e2c135a62ba81715ad795c3969ce0171eeba92496` |

Found on the way (fixed in the bots): the issuer's released collateral had to be withdrawn by hand, and the bot's
fallback flush beat CRE to the release. The bots now withdraw released receipts for the issuer, push receipt payouts
to holders on a default, and leave flushing to CRE for the first few minutes.

### v2 deploy plan (auto-release; run 2026-10-24 with a fresh vault, see below)

The vault is kept: `setHomeGateway` is owner-settable at any time, and the vault itself does not change (the
RELEASE format and its id check are the same). Switching it is only safe when nothing is locked under the old
gateway, otherwise the old gateway's receipts could never be redeemed (the vault accepts RELEASE from one gateway).
Checked on-chain 2026-10-24: `locked` is 0 for TSLA, AMZN, NFLX, AMD and PLTR, but **100 USDG** is locked, backing
100 USDG.rh (old receipt `0xd3Bc…4daA`) held unpledged by `0xf420b79be456724cf7fa0ca25c029c070ee945af`. That
wallet must redeem them through the old gateway (`0x3551…372A`, "Redeem on Robinhood Chain" in the app) and the
RELEASE must land (~20 min) before step 2; the `repoint` run refuses otherwise. If that is not possible, deploy a
new vault instead (ROLE=vault) and keep the old pair serving the old receipts.

```bash
cd packages/evm-engine
export ARB=https://sepolia-rollup.arbitrum.io/rpc RH=https://rpc.testnet.chain.robinhood.com
export OWNER=0x298afB9424188C7eA7c01556D8CAE6ff4768de0a DEPLOYER_KEY=...   # the deployer key, from your key store
# 0. Preconditions: nothing locked in the vault (all must print 0)
for t in 0x7E955252E15c84f5768B83c41a71F9eba181802F 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93; do
  cast call 0xE7a70743263554eb4D7A5599F4bAd05d2A7E8846 'locked(address)(uint256)' $t --rpc-url $RH; done
# 1. Gateway v2 next to the v4 engine, CRE forwarder = the engine's, 0.005 ETH in the release fee pool
ROLE=gateway CHAIN=arbitrum-sepolia ENGINE=0x7d36Da43724b09Bb03ED98a4574685070073020b OWNER=$OWNER FEE_POOL=5000000000000000 \
  forge script script/DeployCrossChain.s.sol --rpc-url $ARB --broadcast
export GATEWAY=0x...   # printed by step 1
# 2. Point the existing vault at it; allow AMD and PLTR
ROLE=repoint CHAIN=robinhood-testnet VAULT=0xE7a70743263554eb4D7A5599F4bAd05d2A7E8846 GATEWAY=$GATEWAY \
  TOKENS=0x7E955252E15c84f5768B83c41a71F9eba181802F,0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E,0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02,0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93 \
  ALLOW=0x71178BAc73cBeb415514eB542a8995b82669778d,0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0 \
  forge script script/DeployCrossChain.s.sol --rpc-url $RH --broadcast
# 3. Wire the gateway and create the v2 receipts
ROLE=wire CHAIN=arbitrum-sepolia GATEWAY=$GATEWAY REMOTE=robinhood-testnet VAULT=0xE7a70743263554eb4D7A5599F4bAd05d2A7E8846 \
  TOKENS=0x7E955252E15c84f5768B83c41a71F9eba181802F,0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E,0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02,0x71178BAc73cBeb415514eB542a8995b82669778d,0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0 \
  DECIMALS=6,18,18,18,18 SYMBOLS=USDG.rh,TSLA.rh,AMZN.rh,AMD.rh,PLTR.rh \
  forge script script/DeployCrossChain.s.sol --rpc-url $ARB --broadcast
# 4. Verify
cast call $GATEWAY 'VERSION()(uint256)' --rpc-url $ARB                     # 2
cast call $GATEWAY 'getForwarderAddress()(address)' --rpc-url $ARB          # = the engine's forwarder
cast call $GATEWAY 'releaseQueue()(uint256,uint256,uint256,uint256,uint256)' --rpc-url $ARB
cast call 0xE7a70743263554eb4D7A5599F4bAd05d2A7E8846 'homeGateway()(address)' --rpc-url $RH   # = $GATEWAY
```

Then: record the gateway and the five receipts in deployments/crosschain-testnet.json (`home.gateway`,
`gatewayBlock`, `remotes[0].receipts`; the old pair under a retired entry), regenerate the served config
(scripts/server-config.ts) and the CRE config (scripts/cre-config.ts: `vaults` with the new receipts, and the
gateway for the flush report), and run the issuer bot with `GATEWAY=$GATEWAY` as the flush fallback. The engine's
forwarder on Arbitrum Sepolia is currently the CRE simulation forwarder (`0xD412…ca5d`); if the keeper moves to
the production KeystoneForwarder (`0x76c9…5E62`), call `setForwarderAddress` on the engine and the gateway.

### Testnet deploy plan (as approved and run)

Order (script: `packages/evm-engine/script/DeployCrossChain.s.sol`):

1. Arbitrum Sepolia: `ROLE=gateway` → HomeGateway (router `0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165`,
   engine = the v3 engine).
2. Robinhood Chain testnet: `ROLE=vault` → RemoteVault (router `0x30D197C6F5bE050D5525dD94d01760FaCdB67e7C`,
   home selector `3478487238524512106`), allow USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F`, TSLA, AMZN, NFLX.
3. Arbitrum Sepolia: `ROLE=wire` → `setRemote(2032988798112970440, vault)`, receipts USDG.rh (6), TSLA.rh (18),
   AMZN.rh (18), NFLX.rh (18).
4. App and core: add the receipts as collateral options (valued with each stock's Chainlink feed), a "Lock on
   Robinhood" step in the issue flow and "Redeem on Robinhood" for holders; CRE staging config gets `vaults`.
5. A demo note on Arbitrum Sepolia with TSLA collateral locked on Robinhood: lock at least 30 minutes before the
   strike; grace period of a few hours.

Funding (estimates at testnet gas prices of ~0.01–0.02 gwei; CCIP fees quoted at run time):

| Address | Arbitrum Sepolia | Robinhood testnet |
|---|---|---|
| Deployer `0x298a…de0a` (deploy + wire) | ~0.001 ETH | ~0.001 ETH |
| Demo issuer (a few redeems; locks on Robinhood) | ~0.001 ETH | ~0.002 ETH |
| Demo holders (redeem after a default, ~0.00005 ETH each) | ~0.0005 ETH each | — |

Plus real Robinhood testnet stock tokens and USDG for the demo issuer (faucet.testnet.chain.robinhood.com).
CCIP lanes Arbitrum Sepolia ↔ Robinhood testnet are listed as live in both directions in Chainlink's CCIP API
(`/api/ccip/v1/lanes`, CCIP 2.0 on-ramps/off-ramps), checked 2026-10-24.

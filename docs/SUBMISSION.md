# notes.markets: Arbitrum Founder House submission

**One line:** structured notes on Arbitrum, backed by collateral that stays on its own chain. Anyone issues a note
on stocks or crypto and raises stablecoins against collateral: Robinhood's real TSLA, for example, stays locked in a
vault on Robinhood Chain, credited on Arbitrum over Chainlink CCIP and released home automatically. Chainlink CRE
fixes every price; the contract enforces every payment. Live on testnet: the notes run on **FlowEngine v4 on
Arbitrum Sepolia**, with collateral vaults on **Robinhood Chain testnet**.

- **Site:** https://notes.markets · **App:** https://notes.markets/app
- **Code:** https://github.com/adappterxyz/StratosNotes-Arbitrum
- **Pitch video script:** [PITCH.md](PITCH.md) · **Demo video script:** [DEMO-SCRIPT.md](DEMO-SCRIPT.md) ·
  **Product and GTM canvas:** [GTM-CANVAS.md](GTM-CANVAS.md) · **Milestones:** [MILESTONES.md](MILESTONES.md)
- **Live cross-chain proof (2026-10-24):** 3 TSLA locked on Robinhood Chain backed note pid 2 on Arbitrum Sepolia,
  CRE strike from Robinhood Chain's Chainlink TSLA feed, redeemed, TSLA back on Robinhood one hour after the lock:
  [CROSS-CHAIN.md](CROSS-CHAIN.md) ("Live v2 proof").
- **How the money works:** [NOTE-ECONOMICS.md](NOTE-ECONOMICS.md) · **ERC-20 notes and claims:**
  [ERC20-NOTES.md](ERC20-NOTES.md) · **Alerts and email binding:** [NOTIFICATIONS.md](NOTIFICATIONS.md) ·
  **Runbook:** [DEPLOY.md](DEPLOY.md)
- **Team:** Kwang, solo founder; involved in the MAS Project Guardian tokenized structured note pilot at Marketnode.
  Canton Network validators, from the Canton accelerator (a later path to institutions). Raising a USD 500k pre-seed for audits and in-house issuance.
- **Earlier build:** Solana, TOKEN2049, won Best Use of Chainlink CRE: https://sp.stratoslab.app

> Sections below the criteria table still describe the earlier v3 deployments and the first CRE runs; the current
> engine and the cross-chain proof are in [CROSS-CHAIN.md](CROSS-CHAIN.md) and [ERC20-NOTES.md](ERC20-NOTES.md).

## Tracks targeted

| Track | Why we fit |
|---|---|
| **Robinhood Chain Founder-in-Residence** | Robinhood Chain holds the tokenized stocks and their Chainlink prices; we make them work as collateral without moving them. We're building a company on it: plan in [MILESTONES.md](MILESTONES.md), go-to-market in [GTM-CANVAS.md](GTM-CANVAS.md). |
| **Robinhood Chain Innovation Award** | Robinhood's TSLA locked in our vault on Robinhood Chain testnet backed an Arbitrum note start to finish: credited over Chainlink CCIP, strike from Robinhood Chain's Chainlink TSLA feed, redeemed, and the TSLA released home automatically ([CROSS-CHAIN.md](CROSS-CHAIN.md), "Live v2 proof"). |
| **General track** (Robinhood Chain slot) | Notes on Arbitrum Sepolia; collateral vault (RemoteVault) on Robinhood Chain testnet. |
| **Arbitrum Foundation grants** | Milestones tied to an audit, stock-collateralised notes on Arbitrum (stocks locked on Robinhood Chain), the first issuers and a compliance layer; mainnet once Chainlink CRE production access and the audit are in place. |

**Eligibility:** notes on Arbitrum Sepolia (chain 421614), FlowEngine v4 `0x7d36Da43724b09Bb03ED98a4574685070073020b`;
collateral vault on Robinhood Chain testnet (chain 46630), RemoteVault `0x6a11Ff8DD08d63Dc2a7C7AB6116d1F40Bf20d1C2`
(gateway v2 `0x4C393Ed28Cc1825CfBA5A4d6F2223589249C3a89` on Arbitrum); addresses below. We stay on testnets for now: Chainlink runs through the CRE simulator, and mainnet waits on production CRE
access and an audit.

## How we meet the criteria

| Criterion | Where to look |
|---|---|
| **Smart contract quality** | `packages/evm-engine`: one engine (`FlowEngine.sol`, v4) runs every note from a content-addressed definition. Note units are ERC-20s (`NoteToken`, verified-only transfers). Payouts through one accumulator: claim by default with a hash receipt per claim, push opt-in; a coupon report costs about 393k gas for 10 or 1,000 holders. Cross-chain collateral (`HomeGateway`, `RemoteVault`, `RemoteReceipt`) over Chainlink CCIP. Custom errors, `ReentrancyGuard`, `SafeERC20`, `Ownable2Step`, `Pausable`. Reports accepted only from the forwarder, every oracle value bounds-checked. 344 automated tests (252 unit, 92 contract), every product timeline checked against the reference payoff. Not audited yet (milestone 1). |
| **Product-market fit** | Two sides with a clear job each (see the canvas): issuers raise funding against collateral; investors get defined outcomes on stocks and crypto. Beachhead: crypto-native issuers and investors, then Robinhood Chain's stock holders (raising against their stock without selling) through a licensed partner. |
| **Innovation and creativity** | Notes as BPMN workflows compiled to one on-chain engine; collateral that stays on its own chain (Robinhood's TSLA locked on Robinhood Chain backs a note on Arbitrum, released home automatically); Chainlink CRE as calculation agent and automation; payments enforced by escrow, funding deadlines, grace and default; a verified email bound on-chain as a salted hash. |
| **Real problem solving** | Bank-only issuance, a calculation agent you have to trust, and notes locked to one venue. |
| **Pitch quality** | [PITCH.md](PITCH.md) (1:50 pitch video, each beat tagged with its criterion), [DEMO-SCRIPT.md](DEMO-SCRIPT.md) (1:50 demo video). |
| **Product and GTM canvas** | [GTM-CANVAS.md](GTM-CANVAS.md): one-page canvas produced during Founder House, with segments, pricing, channels, risks and milestones tied to the pre-seed. |

## The problem

A structured note turns a market view into an outcome agreed upfront: yield while prices stay in a range, capital
protection with some upside, exposure to a stock or a basket on defined terms, or a hedge. Banks issue them with a
calculation agent and a paying agent and weeks of structuring; investors buy where the bank sells. DeFi's yield
products are mostly vaults with rolling strategies, with no fixed term sheet or independent calculation agent.

## What it does

1. **Design** (Issue workspace): a template (ten seeded, four of them on stocks, all issued on Arbitrum), a term sheet
   (fixed coupon note, reverse convertible, phoenix with memory, snowball, principal-protected; one underlying or a
   worst-of basket; cash settlement, or physical delivery of WETH), a sentence to the AI, or a blank BPMN canvas. Every edit passes the validator and
   compiler.
2. **Issue**: this issuance's size, dates, settlement lag and grace period (0-7 days), the collateral ratio and
   haircuts, and the collateral itself: USDG or WETH locked in the note's escrow on Arbitrum, or USDG, TSLA, AMZN,
   AMD or PLTR locked on Robinhood Chain (their receipts pledged), valued by Chainlink after a haircut. The book opens on the marketplace.
3. **Sell**: anyone swaps stablecoins for units in one transaction until the strike date; the stablecoin is the
   issuer's at once (the funds the note raises). Holders transfer units.
4. **Observe, fund and pay**: CRE fixes the strike and observes every date, pricing the collateral too (margin call
   below the requirement). Each observation fixes what is owed; the issuer funds it into escrow before the payment
   date (it sees "Payment due" with a Fund button on the note page); funded, holders are paid from escrow; not
   funded through grace, the note defaults and the holders are paid from escrow pro rata: what they are owed (the
   missed payment plus par), the rest back to the issuer (or everything, under the `all-to-holders` default rule). After the final payment the collateral is
   released to the issuer. Below a knock-in, a physical note delivers units ÷ strike of the (worst) underlying's
   token, funded the same way.

All of it is drawn in each note's BPMN (Fund Payment windows, payment dates, "Funded?" checks, grace, default and
release), and the validator refuses any payment that isn't paid from escrow behind a funding check, so canvas edits
and AI drafts can't create an unfunded payment. Worked example: [NOTE-ECONOMICS.md](NOTE-ECONOMICS.md).

## Architecture

```
template / term sheet / AI / canvas -> BPMN -> compiler -> definition (bytes, content-addressed)
                                                                  |
                FlowEngine on Arbitrum Sepolia (one contract, every note); RemoteVault on Robinhood Chain (collateral)
   issuer: pledge, fund, top up -> escrow (engine-held) -> pay holders | default: escrow to holders | release
   verified email -> salted-hash attestation (EIP-712, verifier) -> required to issue, subscribe, receive units
                                   ^ onReport via KeystoneForwarder
Chainlink feeds (crypto on Ethereum; equities on Robinhood Chain) -> CRE notes-keeper-evm (observations,
                                   collateral prices, deadlines)
notes.markets = one Cloudflare Worker: landing, app, AI, email (Cloudflare Email Service); API and indexer
                                   (moving from Postgres on our server to Cloudflare D1 in the Worker)
```

## Evidence

**Earlier contracts (v3: collateral, funding calls, email requirement on, security fixes from [SECURITY.md](SECURITY.md)).**
Notes are now issued on Arbitrum Sepolia only (FlowEngine v4 `0x7d36Da43724b09Bb03ED98a4574685070073020b`). The
engines on Robinhood Chain testnet (v3 below, and v4 `0xf1a1Fa45770582d1EeBC173d9076E95f9cFA0244`) are legacy: the
notes issued on them run to maturity there and are no longer listed; nothing new is issued there.

| Network | FlowEngine | NotesLens | TokenFaucet | Forwarder |
|---|---|---|---|---|
| Robinhood Chain testnet | `0xCbF6eeC598b8f3b4a4082f5583Db6bD6f488b22D` | `0x0969cCc3e714A3Ac5a49b1cD8e07989B8C7CaA41` | `0xAF8425A4b2d8994796e019D9b42Cd99D40297e10` | MockKeystoneForwarder `0x0b93082D9b3C7C97fAcd250082899BAcf3af3885` |
| Arbitrum Sepolia | `0xAF8425A4b2d8994796e019D9b42Cd99D40297e10` | `0x7544378876D780E69968CD67c3FEf9a294C23A0B` | `0x02BA09FB3409d310C1C8d145144c84e5bC5D09EE` | MockKeystoneForwarder `0xD41263567DdfeAd91504199b8c6c87371e83ca5d` |

**Cross-chain collateral (live on testnet).** A note runs on Arbitrum Sepolia while its collateral stays locked on
Robinhood Chain: HomeGateway `0xcdee38dEbC2eE59Ae486c0829ff6a0028a5eFaEC` (Arbitrum Sepolia), RemoteVault
`0xfB8b030FF7C059665daB3aF2D77F72445E341300` (Robinhood testnet), receipts USDG.rh / TSLA.rh / AMZN.rh pledged as
collateral. Chainlink CCIP carried a lock Robinhood → Arbitrum in **21 min 32 s**
([`0x8111a057…`](https://ccip.chain.link/msg/0x8111a05781382b60b8ac56118a77c4a23e0536b8ed34978abe8cb7b97b8f3248))
and the release back in **17 min 27 s** ([`0x48755825…`](https://ccip.chain.link/msg/0x487558251499ae682ba78305d4355a6bd42fcae05277e4a17e0974be96fa7cd3)), both executed automatically by the CCIP network. CRE checks every run that the vault still backs the receipts. Details:
[CROSS-CHAIN.md](CROSS-CHAIN.md).

**A note settled in real USDG.** `arbitrum-sepolia:0xaf84…7e10:2`: ETH/BTC worst-of phoenix, 100 units at 1 USDG,
60 sold to two demo investors, 50 USDG collateral (ratio 50%), Paxos testnet USDG
`0xFFC95faa3d63Cde504a05B567C600B78C0b41892`; strike 26 Oct 2026 12:00 UTC. Its issuer is the deployer key, as a
temporary demo issuer.

Earlier engines are archived in `deployments/archive/` (v1: the two completed CRE runs below; v2: before the
security fixes).

Email verifier (both chains): `0xBbAb30Cf49862BAfEb37a405D08949E81045093f`. Demo notes are seeded on Arbitrum Sepolia
only (ETH/BTC and TSLA/NVDA, cash-settled).

**Two notes run start to finish on the live testnets, every price and payment by Chainlink CRE** (v1 engines, before
the email requirement and before notes became Arbitrum-only; records in `deployments/archive/`). The first ran on
an early, now-retired engine on Robinhood Chain testnet; today the same TSLA exposure is an Arbitrum note with TSLA
locked on Robinhood Chain as collateral ([CROSS-CHAIN.md](CROSS-CHAIN.md), "Live v2 proof"):

**Demo Worst-of Phoenix on TSLA, NVDA on Robinhood Chain testnet (legacy v1 engine, retired): autocalled at observation 2, 1.050 per unit** (engine v1 `0x4532fca7aa4dd54fc981d62836d3852ce7bdb7b2`, pid 1)

| Step | Detail | Transaction | Gas |
|---|---|---|---|
| Issuer pledges collateral | 2,000 tUSD locked in the note | [`0x9c013b8b…`](https://explorer.testnet.chain.robinhood.com/tx/0x9c013b8b9b1799b3ac37a933890ad8c576e5f637bb197f3275142b069e95e912) |  |
| Investor A subscribes | 600 tUSD for 600 units | [`0x0e64d8d3…`](https://explorer.testnet.chain.robinhood.com/tx/0x0e64d8d3b6cbbc032ab6c257ded9a28219450ab0e6b8c46d844b2957c6b1285c) |  |
| Investor B subscribes | 400 tUSD for 400 units | [`0x1fdcd93d…`](https://explorer.testnet.chain.robinhood.com/tx/0x1fdcd93d1177eefae4c453732a72d2219c0a7ccc414b81059f034accb518658d) |  |
| Chainlink CRE fixes the strike | TSLA 374.93, NVDA 212.54 | [`0x77e678a3…`](https://explorer.testnet.chain.robinhood.com/tx/0x77e678a32a097b58818f7df64fc50204fe714cb4caaac392dd267c61bdcc196d) | 495,894 |
| Chainlink CRE observes | TSLA 374.93, NVDA 212.54 | [`0xf08f46e8…`](https://explorer.testnet.chain.robinhood.com/tx/0xf08f46e872208a7301b740facfb6038e4e371677099a86bf73bff4ae43c4a94e) | 482,658 |
| Issuer funds a payment | 25 tUSD deposited before the payment date | [`0x38014481…`](https://explorer.testnet.chain.robinhood.com/tx/0x38014481a1a150fb44470ab2d41cdf19cb0df1d59f7b36b0a10bacfbc6c44f5e) |  |
| Chainlink CRE pays holders | Coupon of 25 tUSD to every holder (2.5% of 1,000 units) | [`0x9c5fc80d…`](https://explorer.testnet.chain.robinhood.com/tx/0x9c5fc80d68f6698b10fd5ba5cf07364dbc3e5c0c95355c77bca444d81f67bdab) | 393,101 |
| Chainlink CRE observes | TSLA 374.93, NVDA 212.54 | [`0xb83049ce…`](https://explorer.testnet.chain.robinhood.com/tx/0xb83049ce774fc5af87f207c943a128bbfed6d5d604ba1fd79748469738251014) | 462,435 |
| Issuer funds a payment | 1,025 tUSD deposited before the payment date | [`0x22b5a7af…`](https://explorer.testnet.chain.robinhood.com/tx/0x22b5a7af29b452d5f38596bfe6387153cd044964ae564a65e095082db820a8fd) |  |
| Chainlink CRE pays holders | Redemption plus last coupon, 1,025 tUSD, to every holder; collateral released to the issuer | [`0x493d5939…`](https://explorer.testnet.chain.robinhood.com/tx/0x493d5939676afac1a3eedd1164cf059b99a018a01483d982ee7b8e78f1ec11c7) | 506,609 |

Paid: Investor A (0xace9…aa02), 600 units → **630 tUSD**; Investor B (0x30d8…36d5), 400 units → **420 tUSD**

**Demo Worst-of Phoenix on ETH, BTC on Arbitrum Sepolia: held to maturity, 1.075 per unit** (engine v1 `0x83f653e5843ffd39a3ac1de856d838f651225ab4`, pid 1)

| Step | Detail | Transaction | Gas |
|---|---|---|---|
| Issuer pledges collateral | 2,000 tUSD locked in the note | [`0x9b1fdd3f…`](https://sepolia.arbiscan.io/tx/0x9b1fdd3f5ca48a437d31978cda60765690a66680f21bb926d96e148bd7b1c9f1) |  |
| Investor A subscribes | 600 tUSD for 600 units | [`0x9ef14cd0…`](https://sepolia.arbiscan.io/tx/0x9ef14cd0ccb8450a967a5f78cda8f3581ec708c112f65d2d0d752dd919ec59c9) |  |
| Investor B subscribes | 400 tUSD for 400 units | [`0x3c8532f6…`](https://sepolia.arbiscan.io/tx/0x3c8532f65347f51b35ad384b0bfdc4a4c921eb8feedbba86954c188abd138fd5) |  |
| Chainlink CRE fixes the strike | ETH 2,399.09, BTC 81,603.43 | [`0x2ccc63ae…`](https://sepolia.arbiscan.io/tx/0x2ccc63aea85885f3ee70e67ddfc072cbf8efd0b143a00feae5ba4117f1e9f08f) | 495,814 |
| Chainlink CRE observes | ETH 2,399.09, BTC 81,603.43 | [`0xd5fb295f…`](https://sepolia.arbiscan.io/tx/0xd5fb295fadded9f9631494a6205ffd101fb01b0d09c3760494af52dcdef1c392) | 482,578 |
| Issuer funds a payment | 25 tUSD deposited before the payment date | [`0x9df55d4f…`](https://sepolia.arbiscan.io/tx/0x9df55d4f21bdddd6ee77b0911dc52d5500e0ba02b5f25706ae94634c730ccae4) |  |
| Chainlink CRE pays holders | Coupon of 25 tUSD to every holder (2.5% of 1,000 units) | [`0x3d563e80…`](https://sepolia.arbiscan.io/tx/0x3d563e80bab2f6d7deb8f47cf478943d1c3ec3b587e171ed046a5295d7141aed) | 393,069 |
| Chainlink CRE observes | ETH 2,396.08, BTC 81,603.43 | [`0xb5b79041…`](https://sepolia.arbiscan.io/tx/0xb5b790419541a07fa9237a565884c673a693398953b183147f2243a53254f06c) | 501,188 |
| Issuer funds a payment | 25 tUSD deposited before the payment date | [`0x24be72fb…`](https://sepolia.arbiscan.io/tx/0x24be72fb9ddca431c14d2f5c1245f32c4e0fe5a64bc711f4f4aeb08ffad305eb) |  |
| Chainlink CRE pays holders | Coupon of 25 tUSD to every holder (2.5% of 1,000 units) | [`0x91b3b574…`](https://sepolia.arbiscan.io/tx/0x91b3b574a9bd3f620e74602817343f596feed63132c016a75f9e4cc5a918440b) | 318,785 |
| Chainlink CRE observes | ETH 2,396.08, BTC 81,603.43 | [`0x07afc004…`](https://sepolia.arbiscan.io/tx/0x07afc0049f7ab9ba81a101cead28f563f4d2dbd2031aaba3cbdc10aef5a0598f) | 463,321 |
| Issuer funds a payment | 1,025 tUSD deposited before the payment date | [`0xb704c4f8…`](https://sepolia.arbiscan.io/tx/0xb704c4f871b72fb357652407e36874047af220895dbdcdd8200ef7f2e3865b9d) |  |
| Chainlink CRE pays holders | Redemption plus last coupon, 1,025 tUSD, to every holder; collateral released to the issuer | [`0x74338b79…`](https://sepolia.arbiscan.io/tx/0x74338b79bf95596f0c80e6328363adad3309a04f4500c5a6f42f4ba84d23ee0c) | 494,678 |

Paid: Investor A (0xace9…aa02), 600 units → **645 tUSD**; Investor B (0x30d8…36d5), 400 units → **430 tUSD**

**Verified before deployment, on local forks of the real testnets** (anvil, with the chains' real
MockKeystoneForwarders; `scripts/e2e-cre-evm.sh`):

| Run | Reports (by the Arbitrum Sepolia MockKeystoneForwarder) | Payouts vs reference |
|---|---|---|
| Worst-of phoenix on ETH, BTC, CRE simulator | strike ETH 2,406.36 / BTC 81,852.64 (206k gas), observations (366k, 388k gas) | 630 and 420 for 600 and 400 units = 1.05 per unit: match |
| Worst-of phoenix on TSLA, NVDA, CRE simulator, prices from Arbitrum One | strike TSLA 374.93 / NVDA 212.54 (206k gas), observations (366k, 388k gas) | 630 and 420: match |
| Same ETH/BTC note on a Robinhood Chain testnet fork, fallback keeper (engine rehearsal; notes are now issued on Arbitrum only) | strike (160k gas), observations (320k, 342k gas), reported by the fallback reporter | 630 and 420: match |

**Issuer behaviour, on the engine** (`forge test`; each timeline replayed and every holder's cash, delivered
tokens and collateral checked against the reference `simulateNote`):

| Scenario | Outcome |
|---|---|
| Funds every payment (13 product timelines; one funds in two deposits, all fund early) | the reference payoff; collateral released |
| Misses coupon 3 (phoenix) | default at the end of grace; owed 1,075 > 1,000 USDC collateral: all of it to the holders pro rata |
| Funds coupon 3 late, inside grace | cured: paid, runs to maturity |
| Half-funds the redemption (FCN, knocked in) | default; holders share the half and the collateral |
| ETH collateral falls 40%, margin call topped up | cured; continues; collateral released |
| ETH collateral falls 40%, not topped up | default; holders receive the ETH in kind |
| USDC + ETH collateral (1.2x), misses coupon 2, `cap-at-owed` | default; holders take the coupon + par (USDC first, then ETH at its price), the rest of the ETH back to the issuer |
| The same, `all-to-holders` | default; both distributed in kind, pro rata |

**Tests:** 128 unit tests (core 85, SDK 6, indexer 8, notifier 14, API 15) and 26 Foundry tests: 20 product timelines
against the reference, both default rules, a late funding call refused, escrow can't be claimed or withdrawn,
out-of-range terms refused, access control, gas with 30/62 holders, faucet, email attestation (valid, wrong signer,
expired, wrong holder, replay, revoked; requirement off vs on). A local end-to-end run: the issuer and investors
verify email and attest on-chain, then issue, subscribe, fund and get paid through the app.

## Honest limits

- **Not audited.** The engine is at 23,384 of 24,576 bytes; new features go into libraries or separate contracts.
- **Cross-chain timing.** A CCIP message waits for the source chain's finality: about 21 minutes measured per message
  between Robinhood testnet and Arbitrum Sepolia. Collateral must be locked well before a strike, and notes with
  remote collateral need a grace period of hours, not minutes.
- **CRE in the simulator.** CRE runs in Chainlink's simulator with `--broadcast`, writing real testnet transactions
  through the MockKeystoneForwarder, until we have DON deploy access. On public testnet RPCs the keeper reads note
  state at the latest block; the engine re-checks every step on-chain.
- **No CRE on Robinhood mainnet** yet; it matters only for the collateral leg there (CRE reads Robinhood Chain's
  feeds and checks the vault); a fallback keeper (off by default, labelled on every report) exists for chains CRE
  doesn't reach.
- **Testnet assets.** Only real tokens: cash is Paxos testnet USDG; ETH collateral and delivery is each chain's
  canonical WETH (the only physically deliverable underlying on Arbitrum); Robinhood's TSLA, AMZN, AMD and PLTR are
  collateral locked on Robinhood Chain (NFLX is held only: no feed); stock notes settle in cash. BTC is synthetic
  (priced, cash-settled). Our own test tokens and faucet are retired.
- **Equity feeds** follow NYSE hours with a 24 h heartbeat; notes accept a 4-day-old round so weekends don't block
  them.
- **Margin** is checked at each observation, not continuously.
- **Email checks can be bypassed in principle.** The email requirement is on-chain, but the attestation is signed by
  our verifier key: whoever holds it can attest addresses. It needs a KMS or multisig before mainnet.
- **Limits per note:** up to 64 holders, 12 observations, 3 underlyings, 3 collateral assets.
- **Not cleared for retail.** Structured notes are securities in most jurisdictions; the testnet product isn't cleared
  for retail distribution (see the canvas).

## What's next

[MILESTONES.md](MILESTONES.md):
1. Audit and hardening on testnet.
2. Stock-collateralised notes on Arbitrum at scale: Robinhood's stock tokens locked on Robinhood Chain.
3. First issuers.
4. Compliance layer and distribution partners.

Mainnet (notes on Arbitrum One, collateral vault on Robinhood Chain) comes after, once Chainlink CRE production access and the audit are in place.

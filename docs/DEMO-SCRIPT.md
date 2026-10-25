# notes.markets: 1:50 demo video

The demo for the Founder House submission. It shows one note end to end: issued on Arbitrum Sepolia, backed by
Robinhood's real TSLA locked on Robinhood Chain testnet, priced by Chainlink CRE, claimed with a receipt, and the
TSLA released home over Chainlink CCIP. The pitch video ([PITCH.md](PITCH.md)) reuses these cuts.

Cross-chain steps take real time (about 21 minutes for a lock, 18 for a release). Record each step as its own take
and cut them together. Say on screen that waits were cut.

## Live URLs

| What | URL |
|---|---|
| Landing | https://notes.markets |
| Live section (what is running now) | https://notes.markets/#live |
| Marketplace | https://notes.markets/app |
| Issue | https://notes.markets/app/issue |
| Portfolio (claims, receipts, released collateral) | https://notes.markets/app/portfolio |
| Alerts (email subscriptions) | https://notes.markets/app/alerts |
| The recorded proof note (pid 2, engine v4) | https://notes.markets/app/note/arbitrum-sepolia:0x7d36da43724b09bb03ed98a4574685070073020b:2 |
| Arbitrum Sepolia explorer | https://sepolia.arbiscan.io |
| Robinhood Chain testnet explorer | https://explorer.testnet.chain.robinhood.com |
| CCIP explorer | https://ccip.chain.link |

Contracts: FlowEngine v4 `0x7d36Da43724b09Bb03ED98a4574685070073020b` and HomeGateway v2
`0x4C393Ed28Cc1825CfBA5A4d6F2223589249C3a89` on Arbitrum Sepolia; RemoteVault
`0x6a11Ff8DD08d63Dc2a7C7AB6116d1F40Bf20d1C2` on Robinhood Chain testnet.

## Setup

- **Issuer wallet** (desktop browser): test ETH on Arbitrum Sepolia and Robinhood Chain testnet (chain 46630);
  Robinhood's TSLA from faucet.testnet.chain.robinhood.com; a little USDG from faucet.paxos.com to fund the coupon.
  The app's **Get testnet tokens** menu links each faucet.
- **Investor:** the demo investor autopilot on the server buys 20 units within ~15 s of the book opening and claims each payout (see [DEMO-AUTOMATION.md](DEMO-AUTOMATION.md)). A phone wallet over WalletConnect works too, if you want to show it.
- **Both wallets email-verified** before recording, with inboxes you can show. Subscribe both to alerts at
  `/app/alerts`.
- **CRE** running through the simulator with `--broadcast` (it writes the strike, observations, collateral checks
  and release flushes). The issuer bot running (it funds payments for the demo issuer, withdraws released
  receipts and is the late fallback flush).
- A terminal in `packages/evm-engine` for `forge test`.

## Prep timeline

| When | Do |
|---|---|
| T−90 min | Check the wallets, faucets, email codes, CRE simulator and issuer bot. Run `forge test` once so the cache is warm. |
| T−60 min | **Take A: lock.** Issue → Structured product → **Collateral held on: Robinhood Chain**, pick TSLA. **Lock collateral on Robinhood Chain**: the wallet switches chain, approves and locks (CCIP fee in ETH). Keep the CCIP message link. |
| T−40 min | The TSLA.rh receipts show as credited on Arbitrum (about 21 minutes after the lock). |
| T−35 min | **Take B: issue.** A short schedule: book open about 10 minutes, strike a few minutes after it closes, two observations 5 minutes apart, short payment lag. Pledge the TSLA.rh at Approve Terms. Grace of a few hours. |
| T−25 min | **Lock 1 TSLA on Robinhood Chain** from the issue page (off camera), so the recording never waits for CCIP. |
| Strike time | **Take D: strike.** Wait for the CRE strike report; open it on Arbiscan. |
| After the last observation | **Take E: claim.** The issuer bot funds the payments; the note redeems. The investor clicks **Claim** in Portfolio; show the receipt id. |
| Right after | **Take F: release.** The bot withdraws the issuer's receipts: TSLA.rh burned, release queued, CRE flushes over CCIP. About 18 minutes later Portfolio shows "Released to your wallet on Robinhood Chain" with the CCIP link. |
| Any time | **Take G:** `forge test` green; the Alerts emails in the inbox (strike fixed, payment made, collateral released). |

Total wall time is about two hours for one take of each step. If anything stalls, use the recorded proof below.

## Script

| Time | Take | Screen | Say |
|---|---|---|---|
| 0:00 | — | https://notes.markets/app, the marketplace | "This is notes.markets. Every note here runs on Arbitrum. Its collateral can sit on another chain." |
| 0:10 | B | Issue: template, terms, collateral list showing TSLA locked on Robinhood Chain | "I'm the issuer. I pick a template, set the terms, and pledge 3 TSLA. Robinhood's real TSLA, locked in a vault on Robinhood Chain testnet." |
| 0:22 | A | The lock panel, then the CCIP explorer message | "The lock went over Chainlink CCIP. Arbitrum credited a receipt that only the note can hold. Nothing is bridged or tradable." |
| 0:32 | C | Note page: the book fills, 20 sold | "An investor buys in with USDG. The note is an ERC-20 token, and only verified wallets can hold it." |
| 0:45 | D | Note page: strike; Arbiscan report transaction | "At the strike date Chainlink CRE reads TSLA from Robinhood Chain's own Chainlink feed and writes it to the note." |
| 0:58 | E | Portfolio: **Claim**, then the receipt id | "Coupons and the redemption accrue in the note. The investor claims them in one transaction, with a receipt anyone can recompute from the logs." |
| 1:12 | F | Portfolio: "Released to your wallet on Robinhood Chain", CCIP link; Robinhood explorer transfer | "At redemption the receipt is burned and CRE sends the release over CCIP. The TSLA is back on Robinhood Chain. No one had to redeem anything." |
| 1:30 | G | Terminal: `forge test` passing | "Every product is tested against a reference payoff. A coupon costs the same gas for ten holders or a thousand." |
| 1:40 | G | Inbox: Alerts emails | "Issuers and investors get an email at every step." |
| 1:50 | — | End | |

## Fallback: the recorded live proof (2026-10-24)

If a live step stalls, show these instead. Note pid 2 on FlowEngine v4, Arbitrum Sepolia; its only collateral was
3 TSLA.rh. Full table in [CROSS-CHAIN.md](CROSS-CHAIN.md) ("Live v2 proof").

| Step (UTC) | Chain | Link |
|---|---|---|
| 14:56 lock 3 TSLA in the vault | Robinhood | [tx `0xf4c7638f…`](https://explorer.testnet.chain.robinhood.com/tx/0xf4c7638f209771458a1899f63bea18d6a7d1f23f3b0f22b42e716c1661af90a4), [CCIP `0x5748e6f5…`](https://ccip.chain.link/msg/0x5748e6f558f8c7c329c28891b8e18dd2d8772c4eb5fb5aa5172c065c7c33712a) |
| 15:17 3 TSLA.rh credited (about 21 min) | Arbitrum | — |
| 15:18 note pid 2 issued, TSLA.rh only collateral | Arbitrum | [tx `0x56ac84f3…`](https://sepolia.arbiscan.io/tx/0x56ac84f32956e1934539c0dd30bed9d948222bc9517b149c428d278fd81beb99) |
| 15:23 CRE strike, TSLA 372.07 from Robinhood Chain mainnet's Chainlink feed | Arbitrum | [tx `0xe184aa4c…`](https://sepolia.arbiscan.io/tx/0xe184aa4cd6b5531e47d69706c26c5a4c7f8f07f84c7f42eac641f000480a4f5b) |
| 15:28 observation by CRE | Arbitrum | [tx `0xfc82d555…`](https://sepolia.arbiscan.io/tx/0xfc82d555760e061e84565a7ac8b89bd68de92c13323eb5ae06d8e80783efd309) |
| 15:33 observation by CRE | Arbitrum | [tx `0xf1bdd913…`](https://sepolia.arbiscan.io/tx/0xf1bdd91324ceb560562baeb72b128cba9026b07cf4aa32720e0bfacec19a34fe) |
| ~15:35 payments funded, note redeemed | Arbitrum | — |
| 15:38 issuer withdraws: TSLA.rh burned, release queued | Arbitrum | [tx `0x48a13e1c…`](https://sepolia.arbiscan.io/tx/0x48a13e1cf311c9c87ea7d24ed3a3ac5015576070326a2e711f3fc99460a5f11f) |
| 15:38 release sent over CCIP | Arbitrum | [tx `0x924d0335…`](https://sepolia.arbiscan.io/tx/0x924d033572f5a6561c8e674ffa27a53c52e217ec19c271264111a32fdd193a29), [CCIP `0xc42011d6…`](https://ccip.chain.link/msg/0xc42011d623aebeda428e368e605ac4480ee6cc32b6dca65decc2e18bc7f30b99) |
| 15:56 3 TSLA paid back to the issuer (about 18 min) | Robinhood | [tx `0x9f7f323d…`](https://explorer.testnet.chain.robinhood.com/tx/0x9f7f323d9b8f4dd76c7eda3e2c135a62ba81715ad795c3969ce0171eeba92496) |

In that run the issuer withdrew by hand and the bot's fallback flush sent the release. Both are automated now (the
bot withdraws; CRE flushes first). Say so if asked.

Other fallbacks:
- **The book doesn't fill:** the investor autopilot only picks up an Arbitrum note named "TSLA Reverse Convertible"; issue from the demo link.
- **Email code is slow:** show the dialog and say the contract refuses unverified wallets.
- **Site is down:** play the recorded takes; open the proof links above directly on the explorers.

## Shot list

1. Marketplace at `/app` (desktop).
2. Issue: template, terms, collateral with "Collateral held on: Robinhood Chain".
3. The lock panel and the CCIP message page (Robinhood → Arbitrum).
4. The note page as the book fills (20 sold).
5. Note page after subscribing: holders, collateral coverage, schedule.
6. The CRE strike transaction on Arbiscan (`onReport` through the forwarder).
7. Portfolio: Claim, then the payout row with its receipt id.
8. Portfolio: "Released to your wallet on Robinhood Chain" with the CCIP link; the TSLA transfer on the Robinhood
   explorer.
9. Terminal: `forge test` all passing.
10. Inbox: the Alerts emails.

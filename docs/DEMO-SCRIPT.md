# notes.markets: 1:50 demo video

It shows one note end to end on Robinhood Chain testnet: issued with Robinhood's real TSLA pledged straight into the
note as collateral, priced by Chainlink CRE from Robinhood Chain's TSLA feed, a coupon claimed with a receipt, and the
TSLA released to the issuer on the same chain. The pitch video ([PITCH.md](PITCH.md)) reuses these cuts.

Nothing crosses chains, so there is no CCIP wait: the whole run fits in about 15 minutes of wall time. Record each
step as its own take anyway and cut the waits; say on screen that waits were cut.

## Live URLs

| What | URL |
|---|---|
| Landing | https://notes.markets |
| Marketplace | https://notes.markets/app |
| Issue (the demo note, pre-filled) | https://notes.markets/app/issue?product=reverse-convertible&demo=tsla&step=0 |
| Portfolio (claims, receipts) | https://notes.markets/app/portfolio |
| Alerts (email subscriptions) | https://notes.markets/app/alerts |
| Robinhood Chain testnet explorer | https://explorer.testnet.chain.robinhood.com |

Contracts: the FlowEngine and NotesLens in `deployments/robinhood-testnet.json` (Robinhood Chain testnet, chain 46630).

## Setup

- **Issuer wallet** (desktop browser): test ETH on Robinhood Chain testnet; Robinhood's TSLA from
  faucet.testnet.chain.robinhood.com; about 25 USDG from faucet.paxos.com (Robinhood Chain testnet) to fund the
  payments. The app's **Get testnet tokens** menu links each faucet.
- **Investor:** the demo investor autopilot on the server buys 20 units within ~15 s of the book opening and claims
  each payout (see [DEMO-AUTOMATION.md](DEMO-AUTOMATION.md)). A phone wallet over WalletConnect works too, if you want
  to show it.
- **Both wallets email-verified** before recording, with inboxes you can show. Subscribe both to alerts at
  `/app/alerts`.
- **CRE** running through the simulator with `--broadcast` to Robinhood Chain testnet (it writes the strike,
  observations and collateral checks). The issuer bot running if you want it to fund payments instead of the
  presenter.
- A terminal in `packages/evm-engine` for `forge test`.

## Prep timeline

| When | Do |
|---|---|
| T−30 min | Check the wallets (ETH, TSLA, USDG on Robinhood Chain testnet), email codes, CRE simulator and issuer bot. Run `forge test` once so the cache is warm. |
| T−10 min | **Take A: issue.** Open the demo link; Continue through Product, Terms, Schedule and Collateral (TSLA 60% haircut and USDG, pledged into the note); on Review & issue pledge 1 TSLA, strike in 5 minutes, issue. |
| Book open | **Take B: subscribe.** The autopilot investor buys 20 units. |
| Strike time | **Take C: strike.** Wait for the CRE strike report; open it on the Robinhood Chain explorer. |
| After the last observation | **Take D: claim.** The issuer funds the payments; the note redeems. The investor clicks **Claim** in Portfolio; show the receipt id. |
| Right after | **Take E: release.** Paid in full: the issuer withdraws the TSLA from the note; the explorer shows the transfer at once. |
| Any time | **Take F:** `forge test` green; the Alerts emails in the inbox (strike fixed, payment made, collateral released). |

## Script

| Time | Take | Screen | Say |
|---|---|---|---|
| 0:00 | — | https://notes.markets/app, the marketplace | "This is notes.markets. Every note here runs on Robinhood Chain, next to the stocks it's written on." |
| 0:10 | A | Issue: template, terms, collateral with TSLA | "I'm the issuer. I pick a template, set the terms, and pledge TSLA: Robinhood's real tokenized Tesla, straight into the note's escrow. No bridge, no wrapped token." |
| 0:25 | B | Note page: the book fills, 20 sold | "An investor buys in with USDG. The note is an ERC-20 token, and only verified wallets can hold it." |
| 0:40 | C | Note page: strike; explorer report transaction | "At the strike date Chainlink CRE reads TSLA from Robinhood Chain's own Chainlink feed and writes it to the note." |
| 0:55 | D | Portfolio: **Claim**, then the receipt id | "Coupons and the redemption accrue in the note. The investor claims them in one transaction, with a receipt anyone can recompute from the logs." |
| 1:10 | E | Note page: Paid in full; withdraw; explorer transfer | "Paid in full, the TSLA goes back to the issuer, on the same chain, in one transaction. Had the issuer missed a payment, the holders would have received it instead." |
| 1:30 | F | Terminal: `forge test` passing | "Every product is tested against a reference payoff. A coupon costs the same gas for ten holders or a thousand." |
| 1:40 | F | Inbox: Alerts emails | "Issuers and investors get an email at every step." |
| 1:50 | — | End | |

## Fallbacks

- **The book doesn't fill:** the investor autopilot only picks up a Robinhood Chain note named "TSLA Reverse
  Convertible"; issue from the demo link.
- **Strike not written yet:** CRE reads feeds at a finalized block; a report lands a minute or two after its time.
- **Equity prices look stale:** outside NYSE hours the feeds hold the last close; that's expected.
- **Email code is slow:** show the dialog and say the contract refuses unverified wallets.
- **Site is down:** play the recorded takes; open the transactions directly on the Robinhood Chain explorer.

## Shot list

1. Marketplace at `/app` (desktop).
2. Issue: template, terms, collateral with TSLA pledged into the note.
3. The note page as the book fills (20 sold).
4. Note page after subscribing: holders, collateral coverage (TSLA in escrow), schedule.
5. The CRE strike transaction on the Robinhood Chain explorer (`onReport` through the forwarder).
6. Portfolio: Claim, then the payout row with its receipt id.
7. Note page: Paid in full; the TSLA withdrawal on the explorer.
8. Terminal: `forge test` all passing.
9. Inbox: the Alerts emails.

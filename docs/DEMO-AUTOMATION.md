# Recording the product demo (presenter signs, an agent drives the browser)

The presenter's own browser is driven by Claude in Chrome (or any browser agent on the presenter's machine). **The
presenter signs every MetaMask prompt themselves.** The agent never clicks inside MetaMask and never sees a seed
phrase or private key. Nothing runs from this repo on the presenter's machine; this file is only the brief.

## The story the demo tells (edit to 1:50)

Every note runs on **Robinhood Chain testnet**, next to Robinhood's tokenized stocks. The issuer pledges real TSLA
(and USDG) straight into the note: no bridge, no lock on another chain, no wait. Chainlink CRE fixes the strike from
Robinhood Chain's own TSLA feed and runs the schedule; the issuer funds the payments; the investor's coupons are
claimed with receipts; when the note ends, the TSLA is released to the issuer on the same chain.

## Already running on the server

| Service | Role in the demo |
|---|---|
| Chainlink CRE keeper | Writes the strike and observations when due (checks every minute) |
| Investor autopilot (`scripts/demo-investor.ts`) | Demo investor `0xAce9…aA02` buys **20** units of the next Robinhood Chain note named **TSLA Reverse Convertible** within ~15 s of the book opening, and claims every payout (a receipt per claim) |

The presenter is the **issuer**; nothing on the server signs for them, so they fund the payments (step R5).

## Presenter wallet

`0xf420…45af` on Robinhood Chain testnet needs, before recording: a little ETH for gas, at least **1 TSLA**
(faucet.testnet.chain.robinhood.com) and about **25 USDG** (faucet.paxos.com, Robinhood Chain testnet), plus an email
verified on-chain. Check the balances on the explorer before you start.

## Before recording (a few minutes ahead; not on camera)

1. Open `https://notes.markets/app/issue?product=reverse-convertible&demo=tsla&step=0` (every field pre-filled: a TSLA
   reverse convertible on Robinhood Chain, cash-settled in USDG, secured by TSLA and USDG pledged into the note).
2. Connect MetaMask on Robinhood Chain testnet. Nothing has to be locked or waited for: the collateral is pledged in
   the same transaction flow as the issue.

## The recording (about 15 minutes raw)

Start the screen recorder (full screen, so MetaMask popups are captured). Reload the page first.

| Step | On screen | Who | Wait after |
|---|---|---|---|
| R1 | Open the demo link; pause ~2 s on each step while clicking **Continue**: Product (TSLA, Robinhood Chain testnet, Cash) → Terms (2 observations, 2.5% coupon, 70% knock-in) → Schedule (size 20, book closes in 5 min, every 3 min) → Collateral (TSLA 60% haircut and USDG, ratio 100%, 60 s to pay, 120 s grace) | agent | — |
| R2 | **Review & issue**: set **TSLA pledged: 1**, **Strike in: 5** → **Issue** | agent clicks, **presenter signs** each MetaMask step (approvals, issue with the pledge) | ~1 min |
| R3 | The note page opens; the collateral panel shows the TSLA in escrow; the book fills (**20 sold**) when the demo investor buys in | autopilot | ~5 min to the strike |
| R4 | **Strike** appears: written by Chainlink CRE, TSLA from Robinhood Chain's Chainlink feed; open its transaction link | agent | ~3 min |
| R5 | Observation 1 → **Fund payment** → presenter signs (0.5 USDG). Observation 2 (maturity) ~3 min later → **Fund payment** → presenter signs (20.5 USDG) | agent clicks, **presenter signs** | ~1 min |
| R6 | History shows each coupon **claimed with a receipt** by the investor | autopilot | — |
| R7 | **Paid in full** → the collateral is released to the issuer; on the TSLA collateral row click **Withdraw** → presenter signs: the TSLA is back in the wallet at once, same chain | agent clicks, **presenter signs** | — |
| R8 | **Alerts → Emails sent → Show my emails** (presenter signs a free message); scroll the run's emails | agent clicks, **presenter signs** | — |
| R9 | The presenter's address on `https://explorer.testnet.chain.robinhood.com/address/0xf420b79be456724cf7fa0ca25c029c070ee945af` → token balances: the TSLA is back | agent | — |

Stop recording. Cut every wait; the edit plan is in [DEMO-SCRIPT.md](DEMO-SCRIPT.md).

## Prompt to paste into Claude in Chrome

> Drive this browser to record the notes.markets demo. I sign every MetaMask prompt myself — never click inside
> MetaMask; when a step opens it, stop and tell me what to check and sign, then wait for the page to confirm. Move
> slowly and pause about 2 seconds on each screen.
> 1. Open https://notes.markets/app/issue?product=reverse-convertible&demo=tsla&step=0. Click Continue on each step
>    (Product, Terms, Schedule, Collateral), pausing on each.
> 2. On Review & issue, set "TSLA pledged" to 1 and "Strike in (minutes)" to 5, then click Issue. I sign each step.
> 3. Stay on the note page. Show the TSLA in the collateral panel. Wait until 20 units are sold, then until the
>    strike appears (about 5 min); open the strike's transaction link and come back.
> 4. When "Fund payment" appears (twice, about 3 minutes apart), click it; I sign.
> 5. When the note shows Paid in full, click "Withdraw" on the TSLA collateral row; I sign.
> 6. Open Alerts → Emails sent → Show my emails; I sign. Scroll the list slowly.
> 7. Open https://explorer.testnet.chain.robinhood.com/address/0xf420b79be456724cf7fa0ca25c029c070ee945af and show
>    the TSLA balance.

## Checkpoints (public; no keys)

- `GET https://notes.markets/api/notes` → the note `TSLA Reverse Convertible` on the engine in
  `deployments/robinhood-testnet.json`; `view.phase`: `book` → `live` → `redeemed`.

## If something goes wrong

- **A transaction is refused:** the app shows the reason in plain words (wrong network in MetaMask, not enough USDG
  or TSLA…).
- **A funding window is missed:** after the 120 s grace the note defaults and the TSLA goes to the investor in kind,
  on Robinhood Chain: show that instead ("what if the issuer misses a payment").

# Recording the product demo (presenter signs, an agent drives the browser)

The presenter's own browser is driven by Claude in Chrome (or any browser agent on the presenter's machine). **The
presenter signs every MetaMask prompt themselves.** The agent never clicks inside MetaMask and never sees a seed
phrase or private key. Nothing runs from this repo on the presenter's machine; this file is only the brief.

## The story the demo tells (edit to 1:50)

Every note runs on **Arbitrum Sepolia**. Robinhood Chain testnet only holds the **collateral**: real TSLA locked in a
vault there, which never leaves that chain. Chainlink CRE fixes the strike from Robinhood Chain's own TSLA feed and
runs the schedule; the issuer funds the payments; the investor's coupons are claimed with receipts; when the note
ends, the TSLA goes back to Robinhood Chain automatically (Chainlink CCIP, sent by Chainlink CRE).

## Already running on the server

| Service | Role in the demo |
|---|---|
| Chainlink CRE keeper | Writes the strike and observations when due (checks every minute); sends queued collateral releases |
| Investor autopilot | Demo investor `0xAce9…aA02` buys **20** units of the next Arbitrum note named **TSLA Reverse Convertible** within ~15 s of the book opening, and claims every payout (a receipt per claim) |

The presenter is the **issuer**; nothing on the server signs for them, so they fund the payments (step R5).

## Presenter wallet (checked 24 Oct, 18:45 UTC)

`0xf420…45af`: 0.145 ETH and 100 USDG on Arbitrum Sepolia; 0.018 ETH and 10 TSLA on Robinhood Chain testnet; email
verified on-chain until 2027. Enough for several runs.

## Part 1 · Before recording (about 25 minutes ahead; not on camera)

Lock the collateral early so the recording never waits for CCIP:

1. Open `https://notes.markets/app/issue?product=reverse-convertible&demo=tsla&step=0` (every field pre-filled).
2. Click **Continue** four times to reach **Review & issue**. Connect MetaMask if asked.
3. In **Lock on Robinhood Chain**: token **TSLA**, amount **1** → **Lock**. MetaMask switches to Robinhood Chain
   testnet; the presenter signs the approval and the lock (small CCIP fee in ETH).
4. Leave it. About 21 minutes later the panel shows **"1 TSLA locked on Robinhood Chain, ready to pledge"**.
   Do not click Issue yet.

## Part 2 · The recording (about 30 minutes raw)

Start the screen recorder (full screen, so MetaMask popups are captured). Reload the page first.

| Step | On screen | Who | Wait after |
|---|---|---|---|
| R1 | Open the demo link again; pause ~2 s on each step while clicking **Continue**: Product (TSLA, Arbitrum Sepolia, Cash) → Terms (2 observations, 2.5% coupon, 70% knock-in) → Schedule (size 20, book closes in 5 min, every 3 min) → Collateral (held on Robinhood Chain, TSLA, ratio 100%, 60 s to pay, 120 s grace) | agent | — |
| R2 | **Review & issue**: point at "1 TSLA locked on Robinhood Chain, ready to pledge"; set **TSLA pledged: 1**, **Strike in: 5** → **Issue** | agent clicks, **presenter signs** each MetaMask step | ~1 min |
| R3 | The note page opens; the book fills (**20 sold**) when the demo investor buys in | autopilot | ~5 min to the strike |
| R4 | **Strike** appears: written by Chainlink CRE, TSLA ≈ $372.07 from Robinhood Chain's feed; open its transaction link | agent | ~3 min |
| R5 | Observation 1 → **Fund payment** → presenter signs (0.5 USDG). Observation 2 (maturity) ~3 min later → **Fund payment** → presenter signs (20.5 USDG) | agent clicks, **presenter signs** | ~1 min |
| R6 | History shows each coupon **claimed with a receipt** by the investor | autopilot | — |
| R7 | **Paid in full** → on the TSLA collateral row click **Release to Robinhood Chain** (or Withdraw) → presenter signs. Within ~1 min CRE sends it: **Portfolio** shows "Released to your wallet on Robinhood Chain" with the CCIP link | agent clicks, **presenter signs**; CRE sends | ~18 min (cut) |
| R8 | **Alerts → Emails sent → Show my emails** (presenter signs a free message); scroll the run's emails | agent clicks, **presenter signs** | — |
| R9 | The presenter's address on `https://explorer.testnet.chain.robinhood.com/address/0xf420b79be456724cf7fa0ca25c029c070ee945af` → token balances: the TSLA is back | agent | — |

Stop recording. Cut every wait; the edit plan is in [DEMO-SCRIPT.md](DEMO-SCRIPT.md).

## Prompt to paste into Claude in Chrome (Part 2)

> Drive this browser to record the notes.markets demo. I sign every MetaMask prompt myself — never click inside
> MetaMask; when a step opens it, stop and tell me what to check and sign, then wait for the page to confirm. Move
> slowly and pause about 2 seconds on each screen.
> 1. Open https://notes.markets/app/issue?product=reverse-convertible&demo=tsla&step=0. Click Continue on each step
>    (Product, Terms, Schedule, Collateral), pausing on each.
> 2. On Review & issue, show "1 TSLA locked on Robinhood Chain, ready to pledge". Set "TSLA on Robinhood Chain
>    pledged" to 1 and "Strike in (minutes)" to 5, then click Issue. I sign each step.
> 3. Stay on the note page. Wait until 20 units are sold, then until the strike appears (about 5 min); open the
>    strike's transaction link and come back.
> 4. When "Fund payment" appears (twice, about 3 minutes apart), click it; I sign.
> 5. When the note shows Paid in full, click "Release to Robinhood Chain" (or Withdraw) on the TSLA collateral row;
>    I sign. Then open Portfolio and show "Released to your wallet on Robinhood Chain" and its CCIP link.
> 6. Open Alerts → Emails sent → Show my emails; I sign. Scroll the list slowly.
> 7. Open https://explorer.testnet.chain.robinhood.com/address/0xf420b79be456724cf7fa0ca25c029c070ee945af and show
>    the TSLA balance (about 18 minutes after step 5; tell me when it changes).

## Checkpoints (public; no keys)

- `GET https://notes.markets/api/notes` → the note `TSLA Reverse Convertible` on engine
  `0x7d36da43724b09bb03ed98a4574685070073020b`; `view.phase`: `book` → `live` → `redeemed`.
- Release queue: `eth_call releaseQueue()` on gateway `0x4C393Ed28Cc1825CfBA5A4d6F2223589249C3a89`
  (`https://sepolia-rollup.arbitrum.io/rpc`).

## If something goes wrong

- **A transaction is refused:** the app shows the reason in plain words (wrong network in MetaMask, not enough USDG…).
- **A funding window is missed:** after the 120 s grace the note defaults and the TSLA goes to the investor,
  released to their address on Robinhood Chain: show that instead ("what if the issuer misses a payment").
- **Backup footage:** the live run of 24 Oct, transactions in [CROSS-CHAIN.md](CROSS-CHAIN.md) ("Live v2 proof").

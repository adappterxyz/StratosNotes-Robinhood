# Demo script (4 minutes)

A note's life takes longer than a pitch, so one is issued before you present and its strike lands while you talk;
a second is issued live.

## Before you present

1. **Services up:** `pm2 status` shows `sn-arb-indexer`, `sn-arb-api`, `sn-arb-tunnel`, `sn-arb-keeper` and the
   issuer bots (`sn-arb-issuer-<chain>`) online; `curl -s https://notes.markets/api/health` lists both chains
   with a moving cursor.
2. **Two notes in flight** (about 20 minutes ahead), strikes ~3 minutes into the talk: one the issuer bot funds,
   and one whose first payment it leaves unfunded, to show a default:
   ```bash
   CHAIN=arbitrum-sepolia NOTE=crypto STRIKE_IN=1380 OBS_EVERY=120 npx tsx scripts/seed-note.ts   # note A
   CHAIN=arbitrum-sepolia NOTE=crypto STRIKE_IN=1400 OBS_EVERY=120 npx tsx scripts/seed-note.ts   # note B
   MISS=<pid of B>:1 pm2 restart sn-arb-issuer-arbitrum-sepolia --update-env
   ```
3. **Wallet:** MetaMask (or Rabby) on Arbitrum Sepolia with a little testnet ETH; USDG from Paxos's faucet (faucet.paxos.com; the app's top bar, **Get testnet tokens**, links every faucet).
4. **Tabs:**
   1. https://notes.markets (landing)
   2. https://notes.markets/app (marketplace)
   3. The in-flight note's page
   4. https://notes.markets/app/issue
   5. Terminal: `pm2 logs sn-arb-keeper --lines 0`

## The talk

**0:00 Why notes (30 s).** Tab 1, the "Why structured notes" section: yield, capital protection, exposure, hedging.
"Banks sell these with a calculation agent and a paying agent. Here the contract is the note and Chainlink CRE is
the agent."

**0:30 Why Arbitrum (20 s).** "Every note lives on Arbitrum. Robinhood Chain, built on Arbitrum, has the stocks and
their Chainlink prices; the stocks stay locked there as collateral. So notes on Tesla or NVIDIA belong here."

**0:50 Marketplace and subscribe (50 s).** Tab 2, then tab 3: underlyings and feeds, the schedule, the collateral
panel (ratio, coverage, the payment schedule), the workflow with its current step lit. Subscribe 100 units and
approve in the wallet: one transaction, USDG for units. "That USDG goes to the issuer: a note raises money. The
issuer's collateral sits in escrow, and it must fund every payment before its date."

**1:40 Issue (60 s).** Tab 4: open **12M Worst-of Phoenix on TSLA, NVDA** under Published templates: the BPMN
canvas with the issuer's "Fund Payment" windows and each period's "Funded?" gateway, its default branch to "Default:
Collateral to Holders"; Validate. Payoff: the issuer's funding calls along a what-if path, and what holders get on a
default. Issue stage: network Arbitrum Sepolia (the only one), TSLA collateral locked on Robinhood Chain, ratio and pledge, lag and grace, strike in 5
minutes, observations every 3 minutes. Publish only if time allows (approvals).

**2:40 CRE fixes the strikes (50 s).** Tab 5: `… Task_FixStrike [ETH, BTC] -> written 0x…`. Back on tab 3, without
refreshing: strikes set, book closed, the highlight on observation 1. "Every report came through Chainlink's
forwarder; the page shows it as reported by Chainlink CRE."

**3:15 The issuer pays, or defaults (30 s).** Note A: the schedule shows period 1 *Paid*. Note B: *Payment 1 in
grace*, then **Defaulted**: holders hold their share of the collateral and withdraw it.

**3:45 Close (15 s).** "One contract on Arbitrum runs every note as a workflow; the issuer's collateral (stock tokens
stay locked on Robinhood Chain) and funding are part of it; one CRE workflow observes them all, on stocks and crypto."

## If something goes wrong

- **Strike not written yet:** CRE reads feeds at a finalized block; a report lands a minute or two after its time.
- **Equity prices look stale:** outside NYSE hours the feeds hold the last close; that's expected.
- **Faucet says already claimed:** Paxos and Robinhood rate-limit their faucets; switch to another wallet.
- **API unreachable:** `pm2 logs sn-arb-api` and `pm2 logs sn-arb-tunnel`.
- **A demo note defaulted by surprise:** the issuer bot was down or short of USDG: `pm2 logs sn-arb-issuer-<chain>`
  (top up the issuer from faucet.paxos.com; notes.markets mints nothing).

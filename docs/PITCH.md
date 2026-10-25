# notes.markets: 1:50 pitch video

Structured notes on Arbitrum, backed by collateral that stays on its own chain. Everything in this script is live on
testnet today (2026-10-24). Nothing is on mainnet and nothing is audited yet.

Delivered Loom-style: the speaker talks over seven background slides. During slide 4 the demo screen recording is
cut in (or the slide stays as the backdrop). Demo takes come from [DEMO-SCRIPT.md](DEMO-SCRIPT.md).

Judging criteria, and the slide that serves each:

| Criterion | Slide |
|---|---|
| Real problem solving | 1 Problem, 2 Why it matters |
| Innovation and creativity | 3 Solution, 4 Demo |
| Smart contract quality | 5 Smart contracts (and the demo's on-chain receipts) |
| Product-market fit | 2 Why it matters, 6 Product and GTM canvas |
| Product and GTM canvas | 6 Product and GTM canvas |
| Pitch quality | The whole script: problem, why it matters, solution, demo, in order |

## Script

| Time | Slide | Criterion | Backdrop | Say |
|---|---|---|---|---|
| 0:00–0:15 | 1 Problem | Real problem | Slide 1 | "Structured notes are a staple of private banking: you agree the outcome before you invest, like income while a stock holds up, or your money back with upside. But only banks issue them, and each takes weeks." |
| 0:15–0:25 | 2 Why it matters | Real problem, PMF | Slide 2 | "That leaves two groups out: people who hold assets and want to raise money against them on clear terms, and on-chain investors, who get variable vault yields instead of a term sheet." |
| 0:25–0:40 | 3 Solution | Innovation | Slide 3 | "notes.markets lets anyone issue a note in minutes. The note lives on Arbitrum, and the collateral stays where it is, like TSLA on Robinhood Chain. Chainlink fixes the prices and runs the schedule. The issuer funds each payment; miss one, and holders get the collateral." |
| 0:40–1:15 | 4 Demo | Pitch quality, innovation | Slide 4 (or cut to the screen recording) | "Here's one we ran this week. An issuer locks TSLA on Robinhood Chain and issues a note on Arbitrum. An investor buys in with USDG. Chainlink fixes the strike from Robinhood Chain's own TSLA price feed. The investor claims each coupon, with a receipt. When the note is paid, the TSLA goes back to Robinhood Chain. No bridge, no back office." |
| 1:15–1:25 | 5 Smart contracts | Smart contract quality | Slide 5 | "It's built to be checked: one engine runs every note, only Chainlink can move a price, and 344 automated tests confirm each note type pays what its term sheet says. An audit is next." |
| 1:25–1:40 | 6 Product and go-to-market | GTM canvas, PMF | Slide 6 | "We start with crypto-native issuers raising against what they hold, and investors who want yield with a term sheet. Retail comes later, through a licensed partner. Pricing is 50 basis points to issue and 25 a year to service, shown upfront." |
| 1:40–1:50 | 7 Team and raise | Team and ask | Slide 7 | "I'm Kwang. I was involved in the MAS Project Guardian tokenized note pilot at Marketnode and won Best Use of Chainlink CRE at TOKEN2049. We're Canton Network validators too, our path to institutions. We're raising 500 thousand dollars for the audit and our first notes." |

Total: about 290 words: 1:50 at a brisk, natural 2.6–2.7 words a second. One story: banks only → two groups left out → anyone can issue, Chainlink runs it → it works (demo) → you can check it (contracts) → how it grows (GTM) → who and what we need (team, raise). Record the demo takes first, then
the voice-over.

### Slide text

**1 Problem.** Bank-only issuance. Weeks to structure. A calculation agent you must trust. Sold only where the bank
sells.

**2 Why it matters.** Tokenized stocks are on-chain, but holders can't raise against them without selling.
On-chain investors get variable-yield vaults, not term sheets.

**3 Solution.** Notes on Arbitrum. Collateral stays on its own chain (Chainlink CCIP). Chainlink CRE fixes every
price and automates every step. Released home automatically.

**4 Demo.** Backdrop if the recording isn't cut in: the live proof timeline (lock 14:56, strike 372.07, redeemed,
TSLA home 15:56).

**5 Smart contracts.**
- One engine (`FlowEngine` v4) runs every note from a content-addressed workflow definition.
- Note units are ERC-20 tokens. Transfers only to wallets with a verified email, bound on-chain as a salted hash.
- Payouts: one accumulator per note. Claim by default with a hash receipt per claim. The issuer can opt in to push.
- Coupon report gas: 393,001 for 10 holders, 393,344 for 1,000.
- Every product checked against a reference payoff. 344 automated tests (252 unit, 92 contract), all passing.
- Custom errors, reentrancy guards, SafeERC20, two-step ownership, reports only from the Chainlink forwarder,
  every oracle value bounds-checked.
- Not audited yet.

**6 Product and GTM canvas.** The one-page table at the top of [GTM-CANVAS.md](GTM-CANVAS.md). Pricing line:
"50 bps to issue, 25 bps a year to service, every fee on the term sheet, versus roughly 1–3% embedded in a bank
note." The 1–3% is an approximate industry range, not a sourced figure; say "roughly".

**7 Team and raise.**
- Kwang, solo founder.
- Involved in the MAS Project Guardian tokenized structured note pilot at Marketnode.
- Best Use of Chainlink CRE, TOKEN2049.
- Canton Network validators, from the Canton accelerator: a path to institutional take-up later (the workflow
  engine already compiles notes to Daml for Canton).
- Raising USD 500k pre-seed: audit, and in-house issuance to bootstrap liquidity.

## Likely questions

**Aren't these securities?**
In most places, yes, when sold to retail. We start with professional and crypto-native participants. Retail comes
through a licensed distribution partner, with per-note allowlists, KYC and legal review per market. The testnet
product is not cleared for retail. `[[LEGAL]]`

**Why Arbitrum, if the stocks are on Robinhood Chain?**
Arbitrum is the anchor. Every note lives in one engine there: its schedule, holders, payments and default rule.
Collateral stays on the chain where it lives. Robinhood's TSLA is locked in a vault on Robinhood Chain and credited
on Arbitrum over Chainlink CCIP. A note can count collateral from several chains at once. Investors and DeFi
liquidity are on Arbitrum; the stocks are on Robinhood Chain. We don't make either move.

**Is the collateral bridged? Can the receipt be traded?**
No. The vault on Robinhood Chain holds the real TSLA. Arbitrum gets a receipt (TSLA.rh) that the note holds as
collateral. When the note pays collateral out, the receipt is burned in the same transaction and a release is
queued. CRE flushes the queue over CCIP and the vault pays the real token on Robinhood Chain. Nobody holds a
receipt after a note ends. In the live run the TSLA was locked at 14:56 and back at 15:56.

**Why trust the price?**
Prices are Chainlink feeds. Crypto comes from Ethereum mainnet feeds. Stocks come from Robinhood Chain's own
Chainlink feeds. CRE has no EVM read for Robinhood Chain yet, so it reads those feeds with an HTTP JSON-RPC call:
every node asks the RPC itself and the DON must agree on the decoded readings. That adds trust in the RPC endpoint,
which a direct EVM read would not need; we switch when CRE supports the chain. The engine accepts reports only from
the forwarder and bounds-checks every value. Each report shows whether CRE or our fallback keeper wrote it.

**Is CRE really running?**
Yes, through Chainlink's simulator with `--broadcast`, writing real testnet transactions (strike, observations,
collateral checks, release flushes). Production needs CRE deploy access to the DON. That and the audit gate
mainnet.

**What if the issuer defaults?**
The collateral is in the note's escrow and priced at every observation. A shortfall opens a margin call. A missed
payment, after a grace period of up to seven days, sends the collateral to holders pro rata, up to what they are
owed; the rest goes back to the issuer. Holders are only as safe as the collateral ratio the issuer sets, and the
app shows it on every note.

**How do investors get paid?**
They claim. Payments accrue in the note and one claim collects all of them, with a receipt id anyone can recompute
from the logs. The investor pays their own gas. An issuer can opt a note in to push payments to every wallet and
pay that gas instead.

**Why ERC-20 units?**
Wallets show them, explorers index them and DeFi can integrate them. Transfers are verified-only: the receiver
needs a current email attestation. Payout cost doesn't grow with the number of holders.

**How do you make money?**
50 bps of notional sold at book close, taken from the subscription proceeds. A servicing fee of 25 bps a year on
outstanding notional, charged each payment period pro rata, minimum USD 50 per period. A USD 1M 12-month note
earns USD 7,500. Our own bootstrap issuance pays no platform fee. The servicing fee maps to the servicing-fee step
the templates already have; the issuance fee step is not built yet.

**Where does the first supply come from?**
From us. Part of the pre-seed funds in-house issuance, so the marketplace has notes to buy on day one. External
issuers follow.

**How is this different from options vaults or RWA platforms?**
Options vaults run rolling strategies with variable outcomes. A note has a fixed term sheet and schedule agreed
upfront. RWA platforms mostly tokenize existing off-chain assets. Here the note is created and serviced on-chain,
with collateral enforcement and Chainlink as calculation agent. We don't name competitors without data.

**Is the contract audited?**
Not yet. The audit is the first use of the pre-seed.

**Who is the team?**
Kwang, solo founder. Involved in the MAS Project Guardian tokenized structured note pilot at Marketnode. The
earlier Solana build of this engine won Best Use of Chainlink CRE at TOKEN2049.

**Why mention Canton?**
We are Canton Network validators, from the Canton accelerator. Our workflow engine already compiles notes to Daml
for Canton. That is a later path to institutional take-up, not part of this product today.

## Placeholders to fill

`[[LEGAL]]`.

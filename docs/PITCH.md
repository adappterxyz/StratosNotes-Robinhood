# notes.markets: 1:50 pitch video

Structured notes on Robinhood Chain, next to the stocks they are written on. Everything in this script runs on
Robinhood Chain testnet. Nothing is on mainnet and nothing is audited yet.

Delivered Loom-style: the speaker talks over seven background slides. During slide 4 the demo screen recording is
cut in (or the slide stays as the backdrop). Demo takes come from [DEMO-SCRIPT.md](DEMO-SCRIPT.md).

## Script

| Time | Slide | Backdrop | Say |
|---|---|---|---|
| 0:00–0:15 | 1 Problem | Slide 1 | "Structured notes are a staple of private banking: you agree the outcome before you invest, like income while a stock holds up, or your money back with upside. But only banks issue them, and each takes weeks." |
| 0:15–0:25 | 2 Why it matters | Slide 2 | "That leaves two groups out: people who hold assets and want to raise money against them on clear terms, and on-chain investors, who get variable vault yields instead of a term sheet." |
| 0:25–0:40 | 3 Solution | Slide 3 | "notes.markets lets anyone issue a note in minutes, on Robinhood Chain, right next to the tokenized stocks. The issuer pledges collateral, like real TSLA, straight into the note. Chainlink fixes the prices and runs the schedule. The issuer funds each payment; miss one, and holders get the collateral." |
| 0:40–1:15 | 4 Demo | Slide 4 (or cut to the screen recording) | "Here's one end to end. An issuer pledges TSLA and issues a note on Robinhood Chain. An investor buys in with USDG. Chainlink fixes the strike from Robinhood Chain's own TSLA price feed. The investor claims each coupon, with a receipt. When the note is paid, the TSLA goes straight back to the issuer. No bridge, no back office." |
| 1:15–1:25 | 5 Smart contracts | Slide 5 | "It's built to be checked: one engine runs every note, only Chainlink can move a price, and hundreds of automated tests confirm each note type pays what its term sheet says. An audit is next." |
| 1:25–1:40 | 6 Product and go-to-market | Slide 6 | "We start with crypto-native issuers raising against what they hold, and investors who want yield with a term sheet. Retail comes later, through a licensed partner. Pricing is 50 basis points to issue and 25 a year to service, shown upfront." |
| 1:40–1:50 | 7 Team and raise | Slide 7 | "I'm Kwang. I was involved in the MAS Project Guardian tokenized note pilot at Marketnode and won Best Use of Chainlink CRE at TOKEN2049. We're Canton Network validators too, our path to institutions. We're raising 500 thousand dollars for the audit and our first notes." |

Total: about 290 words: 1:50 at a brisk, natural 2.6–2.7 words a second. One story: banks only → two groups left out → anyone can issue, Chainlink runs it → it works (demo) → you can check it (contracts) → how it grows (GTM) → who and what we need (team, raise). Record the demo takes first, then
the voice-over.

### Slide text

**1 Problem.** Bank-only issuance. Weeks to structure. A calculation agent you must trust. Sold only where the bank
sells.

**2 Why it matters.** Tokenized stocks are on-chain, but holders can't raise against them without selling.
On-chain investors get variable-yield vaults, not term sheets.

**3 Solution.** Notes on Robinhood Chain. Robinhood's stock tokens as collateral and as delivery, on the same chain.
Chainlink CRE fixes every price and automates every step.

**4 Demo.** Backdrop if the recording isn't cut in: the demo note's timeline (issue with TSLA pledged, strike from
Robinhood Chain's TSLA feed, coupons claimed, TSLA released to the issuer).

**5 Smart contracts.**
- One engine (`FlowEngine` v4) runs every note from a content-addressed workflow definition.
- Note units are ERC-20 tokens. Transfers only to wallets with a verified email, bound on-chain as a salted hash.
- Payouts: one accumulator per note. Claim by default with a hash receipt per claim. The issuer can opt in to push.
- Coupon report gas: 393,001 for 10 holders, 393,344 for 1,000.
- Every product checked against a reference payoff; unit and Foundry tests all passing.
- Custom errors, reentrancy guards, SafeERC20, two-step ownership, reports only from the Chainlink forwarder,
  every oracle value bounds-checked.
- Not audited yet.

**6 Product and GTM canvas.** The one-page table at the top of [archive/GTM-CANVAS.md](archive/GTM-CANVAS.md) (written for the
earlier build; the segments and pricing still hold). Pricing line:
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

**Why Robinhood Chain?**
That's where the tokenized stocks are, with their Chainlink prices. A note on TSLA can hold TSLA as collateral and
deliver it below the barrier without anything moving between chains: no bridge, no wrapped token, no CCIP wait. The
note's schedule, holders, payments, escrow and default rule all live in one engine there.

**Can collateral come from other chains?**
Planned, not live. The design keeps Robinhood Chain as the home: collateral locked in a vault on another chain, a
receipt credited on Robinhood Chain over Chainlink CCIP, released home automatically when the note pays it out. The
contracts and tests are in the repo, and the mechanism ran live in our earlier build
([CROSS-CHAIN.md](CROSS-CHAIN.md)).

**Why trust the price?**
Prices are Chainlink feeds. Crypto comes from Ethereum mainnet feeds. Stocks come from Robinhood Chain's own
Chainlink feeds. CRE has no EVM read for Robinhood Chain yet, so it reads those feeds with an HTTP JSON-RPC call:
every node asks the RPC itself and the DON must agree on the decoded readings. That adds trust in the RPC endpoint,
which a direct EVM read would not need; we switch when CRE supports the chain. The engine accepts reports only from
the forwarder and bounds-checks every value. Each report shows whether CRE or our fallback keeper wrote it.

**Is CRE really running?**
Yes, through Chainlink's simulator with `--broadcast`, writing real Robinhood Chain testnet transactions (strike,
observations, collateral checks). Production needs CRE deploy access to the DON. That and the audit gate
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

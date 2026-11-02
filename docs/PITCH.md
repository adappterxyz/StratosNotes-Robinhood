# notes.markets: investor deck

Pre-seed deck for notes.markets, the Robinhood Chain build. Twelve slides, written to read on their own; the speaker
notes are the voice-over for a live pitch. The visual deck is an Artifact built from this text (landing-page look,
1600x900, N for notes, F to present). Everything here runs on Robinhood Chain testnet. Nothing is on mainnet and
nothing is audited yet. No users, volume or revenue are claimed.

Tone follows the landing page: describe terms and risks, never promise outcomes. Payments are funded by the issuer
and run by Chainlink CRE; a missed payment sends the pledged collateral to holders, up to its value.

## Slides

**1 · Title.** *A bespoke instrument for every market.* On-chain structured notes, live in minutes. Collateralize,
mint, raise USDG, and let Chainlink oracles and automation handle every fixing and coupon.
Three facts: 141 underlyings (stocks, crypto, FX and gold, priced by Chainlink) · one engine (every product is data on
one contract) · live on Robinhood Chain testnet, not audited.
> Notes: notes.markets lets anyone issue a structured note on-chain in minutes, on any of 141 Chainlink prices. The
> issuer pledges collateral, mints the note, raises USDG from investors, and Chainlink runs every fixing and coupon on
> schedule.

**2 · Problem.** Structured notes are a bank-only product. Weeks to structure · trust the bank's calculation agent ·
unsecured issuer credit · six-figure tickets, sold only where the bank distributes. And on-chain: tokenized stocks
live on Robinhood Chain, but holders can't raise against them without selling; on-chain investors get variable vault
yields, not a term sheet.
> Notes: Structured notes are an established product, but issuing one is a bank's job: weeks of structuring, a
> calculation agent the investor has to trust, unsecured issuer credit, and tickets sized for private-bank clients.
> Tokenized stocks are now on-chain, and their holders have no way to raise against them without selling.

**3 · Solution.** Issuers raise in minutes. Chainlink runs the note. Collateralize and mint (issuer) → subscribe in
USDG, ERC-20 units out (investors) → Chainlink CRE fixes the strike, every observation and each payment step → if a
payment is missed, holders take the pledged collateral, up to its value.
> Notes: The issuer does what a bank desk used to do, in minutes. The issuer funds each payment; Chainlink CRE runs
> the schedule. Miss a payment and the collateral goes to holders, up to its value.

**4 · Product.** Three ways to a term sheet, one readable workflow. Start from a recent note or a ready-made template ·
the product wizard · describe it to the AI (missing terms come back as questions). Every note is a BPMN workflow, the
source of truth, readable by non-programmers and compiled to the on-chain definition; investors see it read-only with
each step's live values. Families: phoenix/autocall, fixed coupon/reverse convertible, snowball, principal-protected,
worst-of baskets.
> Notes: The diagram is the contract a human can read. It is not a programming language; it compiles to the
> definition the engine runs.

**5 · Why now.** The stocks are on-chain; the back office can be automated. Robinhood Chain: collateral and delivery
on one chain, no bridge; collateral whitelist USDG, WETH, TSLA, AMZN, AMD, PLTR. Chainlink: 141 USD prices as
underlyings (crypto 87, stocks 34, FX 18, metals 2); CRE automates the calculation and paying-agent work.
> Notes: Underlyings can be any suitable Chainlink USD price. Collateral is a separate whitelist, limited to what we
> can lock up today.

**6 · Technology.** One engine runs every note; products are data. 391 tests (299 unit, 92 contract), every product
checked against its reference payoff · 393k gas per coupon at 10 or 1,000 holders (one accumulator per note, claims
with a receipt) · new products ship without a redeploy (content-addressed definitions) · the same workflow compiles
to Daml for Canton. ERC-20 units transfer only to wallets with a verified email; reports only from the Chainlink
forwarder, every price bounds-checked. Not audited yet.
> Notes: The moat is the engine: a new product or underlying is data, not a new contract. The audit is the first use
> of the round.

**7 · Traction.** Built, live on testnet, run end to end. TOKEN2049: Best Use of Chainlink CRE (earlier Solana build)
· 24 Oct 2026: TSLA note paid in full on the earlier build (strike $372.07 fixed by Chainlink CRE, collateral
released) · Robinhood Chain only, engine `0xCba17Fe4…D4eE` · demo notes ran their schedule to a missed payment and
defaulted on-chain, as designed · 141 underlyings, the readable workflow and AI issuance. App live at notes.markets;
chain id 46630; 8 ready-made notes. No users, volume or revenue yet.

**8 · Business model.** 50 bps of notional sold, to issue · 25 bps a year on outstanding notional, to service (minimum
USD 50 a period) · every fee on the term sheet, versus roughly 1–3% embedded in a bank note (approximate industry
range, say "roughly"). In-house issuance pays no platform fee.

**9 · Go-to-market.** Issuers first; supply brings the investors. Now: crypto-native issuers (treasuries, market
makers, funds, tokenized-stock holders), with in-house notes to bootstrap supply · Next: desks and communities
structuring for their own clients, where permitted, embedded in wallets and frontends · Later: retail only via
licensed partners · Parallel: institutions on Canton. Metrics: notional issued, repeat issuers, subscribers per note,
on-time funding rate, CRE report success.

**10 · Market.** A bank product line meeting on-chain assets: structured notes × tokenized stocks and RWAs ×
on-chain investors who want terms, not vault yield. `[[MARKET-SIZE]]`: add a sourced figure before using the deck.

**11 · Roadmap.** Done: testnet product · 1 independent audit · 2 mainnet on Robinhood Chain, in-house notes first ·
3 collateral on other chains (future extension; Robinhood Chain stays home) · parallel: institutions on Canton.

**12 · Team and ask.** Raising a USD 500k pre-seed. Kwang, solo founder: involved in the MAS Project Guardian
tokenized structured note pilot at Marketnode; built this product and the earlier build that won Best Use of
Chainlink CRE at TOKEN2049; Canton Network validator from the Canton accelerator. Use of funds: independent audit,
mainnet launch, in-house issuance to bootstrap liquidity.

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
Prices are Chainlink feeds: 141 USD prices in a generated catalogue ([UNDERLYINGS.md](UNDERLYINGS.md)). Stocks come
from Robinhood Chain's own Chainlink feeds; crypto, FX and metals from Ethereum mainnet, plus Arbitrum One for what
Ethereum lacks. CRE has no EVM read for Robinhood Chain yet, so it reads those feeds with an HTTP JSON-RPC call:
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
with collateral enforcement, and Chainlink CRE reading the prices and running each payment step. We don't name competitors without data.

**Is the contract audited?**
Not yet. The audit is the first use of the pre-seed.

**Who is the team?**
Kwang, solo founder. Involved in the MAS Project Guardian tokenized structured note pilot at Marketnode. The
earlier Solana build of this engine won Best Use of Chainlink CRE at TOKEN2049.

**Why mention Canton?**
Kwang runs a Canton Network validator, from the Canton accelerator. Our workflow engine already compiles notes to Daml
for Canton. That is a later path to institutional take-up, not part of this product today.

## Placeholders to fill

`[[LEGAL]]`, `[[MARKET-SIZE]]` (slide 10: a sourced figure for the structured-note market).

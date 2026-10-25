# notes.markets: Product and GTM canvas

> Archived: from the earlier Arbitrum / Founder House build (notes on Arbitrum Sepolia, collateral vault on Robinhood Chain). notes.markets now runs on Robinhood Chain only; see [../OVERVIEW.md](../OVERVIEW.md).

Produced during Arbitrum Founder House (October 2026). One page first, details below. Facts are what is live on
testnet on 2026-10-24. Nothing here claims users or revenue we don't have yet.

## One page

| Block | notes.markets |
|---|---|
| **Problem** | Structured notes are bank-only: weeks to issue, a calculation agent you must trust, sold only where the bank sells. Holders of tokenized stocks can't raise money against them without selling. On-chain investors get variable-yield vaults, not a fixed term sheet. |
| **Segments** | Issuers: crypto treasuries, market makers, funds, tokenized-stock holders. Investors: crypto-native yield seekers; retail later via a licensed partner. |
| **Value: issuer** | Raise stablecoins today against collateral you keep on its own chain. Pay each coupon when due. No structuring desk, paying agent or calculation agent to hire. |
| **Value: investor** | A payoff agreed before you buy, collateral behind it, Chainlink fixing every price, a receipt for every payment. |
| **Solution** | One engine on Arbitrum runs every note. Collateral stays on its own chain (CCIP). Chainlink CRE automates strike, observations, collateral checks and releases. Notes are ERC-20s. |
| **Unfair advantage** | Founder involved in the MAS Project Guardian tokenized structured note pilot at Marketnode. Best Use of Chainlink CRE at TOKEN2049. Cross-chain collateral live on testnet today. Canton Network validators (Canton accelerator): a later path to institutions. |
| **Channels** | Direct issuer BD; Arbitrum DeFi integrations; Robinhood Chain ecosystem; in-house notes as the showcase. |
| **Beachhead** | Crypto-native issuers selling to crypto-native investors, notes on Arbitrum on Robinhood's tokenized stocks (the stock locked on Robinhood Chain as collateral) and on ETH/BTC. |
| **Pricing** | Issuance 50 bps of notional sold. Servicing 25 bps a year on outstanding notional, per period, min USD 50 per period. In-house issuance pays no platform fee. |
| **Key metrics** | Notional issued, notes issued, repeat issuers, subscribers per note, on-time funding rate, CRE report success. |
| **Costs** | Audits, engineering, CRE and gas, Cloudflare, compliance. |
| **Risks** | Regulation, oracle and CRE trust, liquidity. |
| **Pre-seed** | USD 500k: audits, and in-house issuance to bootstrap liquidity. |

## 1. Problem and jobs to be done

**Problem**
- A structured note turns a market view into an agreed outcome: income in a range, capital back with upside,
  exposure on set terms, or a hedge. Only banks issue them today.
- Issuing takes weeks of structuring, a paying agent, a calculation agent and a distribution channel.
- Investors must trust the bank's calculation agent for every payout, and buy where the bank sells.
- Tokenized stocks are now on-chain (Robinhood Chain). Their holders can't raise against them without selling or
  bridging them away.
- On-chain yield is mostly vaults with rolling strategies. Few have a fixed term sheet, a schedule, an independent
  price source and enforced collateral.

**Issuer jobs**
- Raise stablecoins now against assets I hold, without selling or moving them.
- Get paid for a market view by taking the other side of a defined payoff.
- Offer clients a defined-outcome product without building a structuring desk.

**Investor jobs**
- Earn a known income while a stock or coin stays in a range.
- Keep my capital with some upside.
- Know that someone other than the issuer fixes the prices, and that collateral backs the payments.

## 2. Customer segments

| Segment | Side | Why they'd use it | Reachable now? |
|---|---|---|---|
| Crypto treasuries (protocols, DAOs) | Issuer | Raise stablecoins against tokens they hold, paying per period | Yes |
| Market makers and crypto funds | Issuer | Monetize a view; fund a book against inventory | Yes |
| Tokenized-stock holders | Issuer | Raise against TSLA, AMZN, AMD, PLTR on Robinhood Chain without selling; the stock never leaves its chain | Yes, on testnet |
| Crypto-native yield seekers | Investor | Fixed term sheet, collateral behind every payment, Chainlink pricing | Yes |
| Retail | Investor | Notes on stocks they follow | Later, through a licensed distribution partner |

## 3. Value proposition

| Issuer | Investor |
|---|---|
| Subscription money is yours at once | The payoff is in the contract before you buy |
| Collateral stays on its own chain: locked in a vault, credited over Chainlink CCIP, released home automatically | Collateral sits in the note's escrow, checked at every observation |
| Fund each coupon when due, with a 0–7 day grace you set | Miss a payment and holders take the collateral, up to what they're owed |
| No paying or calculation agent: the engine and Chainlink CRE do both | Chainlink CRE fixes every price from Chainlink feeds |
| Issue from a template in minutes | Units are ERC-20s; claim payouts any time, with a hash receipt per claim |
| Every fee on the term sheet | Email alerts at every step; WalletConnect for phone wallets |

## 4. Solution (live on testnet)

- **Anchor:** FlowEngine v4 on Arbitrum Sepolia runs every note: schedule, holders, payments, default rule.
- **Collateral on its own chain:** Robinhood's TSLA locked in a vault on Robinhood Chain testnet, credited over
  CCIP, burned and released home automatically when the note pays out. Live run: 3 TSLA locked 14:56, back 15:56.
- **Chainlink CRE:** strike, observations, collateral checks and release flushes (simulator with `--broadcast`).
  Stocks from Robinhood Chain's own Chainlink feeds (read over CRE HTTP); crypto from Ethereum mainnet feeds.
- **ERC-20 notes:** verified-only transfers. Claim by default with a receipt; issuers can opt in to push. Coupon
  report gas is flat, about 393k for 10 or 1,000 holders.
- **Real assets only:** Paxos USDG and WETH on both chains; Robinhood's TSLA, AMZN, AMD, PLTR. BTC is synthetic
  (price only).
- **Identity:** verified email bound on-chain as a salted hash.
- **Tests:** 344 automated (252 unit, 92 contract), all passing on 2026-10-24. Not audited yet.

## 5. Unfair advantage

- **Domain experience.** Kwang was involved in the MAS Project Guardian tokenized structured note pilot at
  Marketnode. He knows how institutions issue and service notes.
- **Best Use of Chainlink CRE, TOKEN2049.** Won by the earlier Solana build of this engine.
- **Canton Network validators, from the Canton accelerator.** The workflow engine already compiles notes to Daml
  for Canton: a path to institutional take-up later, not part of this product today.
- **Live cross-chain collateral.** A note on Arbitrum backed only by TSLA on Robinhood Chain ran end to end today.
- **One engine, many products.** Notes are workflows compiled to one contract. A new product is a template, not a
  new contract.

## 6. Channels and beachhead

**Beachhead:** crypto-native issuers selling to crypto-native investors. Both already hold the collateral and
stablecoins. Neither needs a retail distribution licence. Notes on tokenized stocks are what no other venue offers.

| Channel | How |
|---|---|
| In-house issuance | We issue the first notes ourselves, so the marketplace has supply on day one and a track record. |
| Direct issuer BD | Treasuries, market makers, funds, tokenized-stock holders. First external notes issued with us. |
| Arbitrum DeFi | Note units as ERC-20s in wallets, dashboards, lending. |
| Robinhood Chain ecosystem | Arbitrum notes backed by Robinhood's stock tokens, locked on Robinhood Chain; co-marketing. |
| Licensed distribution partner | Retail access once the compliance layer exists. |
| Content | The explorer on notes.markets shows any note along any price path. |

## 7. Pricing

**"50 bps to issue, 25 bps a year to service, every fee on the term sheet, versus roughly 1–3% embedded in a bank
note."** The 1–3% is an approximate industry range, not a sourced figure.

| Fee | Level | How it's charged | Built? |
|---|---|---|---|
| Issuance | 50 bps of notional sold | From subscription proceeds at book close | Not yet: needs a fee step at book close |
| Servicing | 25 bps a year on outstanding notional | Each payment period, pro rata; minimum USD 50 per period | Maps to the servicing-fee step the templates already have |
| In-house (bootstrap) issuance | No platform fee | — | — |

**Worked example.** A USD 1M, 12-month note: USD 5,000 issuance plus USD 2,500 servicing = **USD 7,500** revenue.
On-chain cost is a few dollars: a CRE report is about 393k gas, flat in the number of holders; CCIP is about
0.00005–0.00007 ETH per lock or release.

## 8. Key metrics

- Notional issued and notes issued, per month.
- Share of notional from external issuers vs in-house.
- Repeat issuers; subscribers per note; repeat subscribers.
- On-time funding rate; defaults and recovery per unit.
- CRE report success rate; share of reports by the fallback keeper.
- Time from opening the app to issuing a note.

## 9. Costs

- Audits of the engine, libraries and cross-chain contracts, before mainnet and after engine changes.
- Engineering (solo founder today).
- Capital for in-house issuance (collateral and coupon funding).
- Chain costs: CRE reports (~393k gas each), CCIP fees per lock and release.
- Chainlink CRE production costs once on the DON.
- Cloudflare (site, API, email).
- Compliance: KYC/allowlist provider, legal opinions per market.

## 10. Risks

| Risk | What we do |
|---|---|
| **Regulation.** Structured notes are securities in most places when sold to retail. | Start with professional and crypto-native participants. Retail only through a licensed partner, with allowlists, KYC and legal review per market. `[[LEGAL]]` |
| **Oracle and CRE trust.** CRE runs in the simulator today. Robinhood Chain feeds are read over HTTP JSON-RPC, which adds trust in the RPC endpoint. | Reports only from the forwarder; every value bounds-checked; each report labelled CRE or fallback. Mainnet waits for CRE production access; switch to a native EVM read when CRE supports Robinhood Chain. |
| **Liquidity.** A marketplace with no notes or no buyers. | In-house issuance seeds supply. ERC-20 units for DeFi integration. |
| **Issuer credit.** Holders are only as safe as the collateral ratio. | Ratio and coverage shown on every note; margin calls; default to holders. |
| **Smart contracts.** Not audited. | Audit is the first use of funds. |
| **Cross-chain timing.** About 21 minutes per CCIP lock, 18 per release. | Lock well before the strike; grace periods of hours for remote collateral. |

## 11. Milestones (pre-seed USD 500k)

| # | Milestone | Done when |
|---|---|---|
| 1 | Audit | Engine, libraries and cross-chain contracts audited; high and medium findings fixed; report published. |
| 2 | In-house issuance | We issue the first notes ourselves to bootstrap liquidity; issuance fee step built. |
| 3 | First external issuers | External issuers (treasuries, market makers, funds, tokenized-stock holders) issue notes and pay fees. |
| 4 | Licensed distribution partner | A partner offers notes to eligible investors, with allowlists and KYC. |
| 5 | Mainnet | When CRE production access and the audit are both in place. |

Targets per milestone are in [MILESTONES.md](MILESTONES.md).

## Placeholders to fill

`[[LEGAL]]`.

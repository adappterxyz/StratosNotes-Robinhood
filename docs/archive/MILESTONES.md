# notes.markets: milestone plan

> Archived: from the earlier Arbitrum / Founder House build (notes on Arbitrum Sepolia, collateral vault on Robinhood Chain). notes.markets now runs on Robinhood Chain only; see [../OVERVIEW.md](../OVERVIEW.md).

Prizes pay 50% upfront and 50% on milestones. This plan covers about six months from Founder House (late October
2026). Targets in `[[…]]` are for the team to set.

## Where we start (October 2026)

- Live on testnet: every note is issued and runs on **Arbitrum Sepolia**, with the collateral vault on **Robinhood
  Chain testnet** (TSLA, AMZN, AMD, PLTR locked there back Arbitrum notes): notes.markets (landing and app), the API,
  and the Chainlink CRE keeper.
- Two notes ran start to finish on testnet, with every strike, observation and payment written by Chainlink CRE:
  TSLA/NVDA (on an early engine on Robinhood, now retired) paid 630 and 420 tUSD; ETH/BTC on Arbitrum Sepolia paid
  645 and 430 tUSD. Since then 3 TSLA locked on Robinhood Chain backed an Arbitrum note start to finish
  ([CROSS-CHAIN.md](../CROSS-CHAIN.md), "Live v2 proof")
  ([SUBMISSION.md](../OVERVIEW.md)).
- Engine v3: collateral escrow, per-period funding with a grace period, default to holders, a verified email
  bound on-chain as a salted hash, and the fixes from the security pass ([SECURITY.md](../SECURITY.md)).
- 128 unit tests and 26 contract tests passing.

## M1: Audit and hardening, on testnet (month 1–2)

| | |
|---|---|
| Deliverables | Independent audit of the engine and its libraries, with all high and medium findings fixed. Fuzz and invariant tests in CI. Engine owner and email-verifier keys moved to a multisig and KMS, with a timelock on admin setters. Circle's test USDC as the cash asset on Arbitrum Sepolia. Application for Chainlink CRE production (DON) access. |
| Acceptance | Audit report published. A note issued with test USDC on Arbitrum Sepolia, run to redemption by CRE, with payouts equal to the reference payoff. |
| Dependencies | Audit firm `[[auditor, date]]`; audit budget `[[cost]]`. |

## M2: Stock-collateralised notes on Arbitrum, stocks locked on Robinhood Chain (month 2–3)

| | |
|---|---|
| Deliverables | Arbitrum notes on stocks, cash-settled, secured by Robinhood Chain's own testnet stock tokens (TSLA, AMZN, AMD, PLTR) locked in the vault there, not our mintable stand-ins. Equity prices from Chainlink's feeds on Robinhood Chain. A pilot with issuers on testnet. |
| Acceptance | `[[n]]` stock notes issued by pilot issuers on Arbitrum Sepolia with stock collateral locked on Robinhood Chain testnet, run on schedule by CRE. |
| Dependencies | Robinhood Chain testnet stock-token access; pilot issuers `[[names]]`. |

## M3: First issuers (month 3–5)

| | |
|---|---|
| Deliverables | Onboard `[[n]]` issuers (treasuries, market makers, funds). Issue `[[n]]` notes with `[[$ notional]]` total. A template library from real issuances. Email alerts in production. An issuance fee or servicing fee switched on. |
| Acceptance | `[[n]]` notes issued by `[[n]]` distinct issuers; `[[%]]` of payments funded on time; `[[n]]` repeat issuers. |
| Dependencies | Issuer pipeline `[[names]]`; pricing decision (see [GTM-CANVAS.md](GTM-CANVAS.md)). |

## M4: Compliance layer and distribution (month 5–6)

| | |
|---|---|
| Deliverables | Allowlists per note (issuer-chosen investor sets). A KYC partner integration for eligible investors. Legal review for `[[jurisdictions]]`. `[[n]]` distribution partners (wallets, fintechs or brokers) offering a notes shelf. |
| Acceptance | Allowlisted notes live; `[[n]]` partner integrations in production; `[[n]]` investors onboarded through partners. |
| Dependencies | KYC provider `[[name]]`; legal counsel `[[name]]`; partner agreements. |

## Later: mainnet (Arbitrum One and Robinhood Chain), gated

We run Chainlink through the CRE simulator today, so we stay on testnets until:
- Chainlink grants CRE production access (the workflow deployed to the DON, reports through the production
  forwarder);
- the audit is done and its findings are fixed;
- the legal review for the first jurisdictions is done.

Then: Arbitrum One with USDC and Robinhood Chain mainnet with real stock tokens (CRE where supported, the labelled
fallback keeper on Robinhood mainnet until CRE supports it).

## Use of funds

`[[Split of the prize/grant across audit, engineering, compliance and BD]]`

## Placeholders to fill

`[[auditor, date]]`, `[[cost]]`, `[[n]]` (several), `[[$ notional]]`, `[[%]]`, `[[names]]` (issuer pipeline),
`[[jurisdictions]]`, `[[name]]` (KYC provider, counsel), use of funds.

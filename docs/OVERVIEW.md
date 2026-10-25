# notes.markets: overview

**One line:** structured notes on Robinhood Chain, next to the stocks they are written on. Anyone issues a note on
stocks or crypto and raises USDG against collateral pledged into the note: Robinhood's real TSLA, for example, backs a
TSLA note and is delivered to holders below the barrier, on the same chain, with no bridge. Chainlink CRE fixes every
price; the contract enforces every payment.

- **Site:** https://notes.markets · **App:** https://notes.markets/app
- **Code:** https://github.com/adappterxyz/StratosNotes-Robinhood
- **Pitch video script:** [PITCH.md](PITCH.md) · **Demo video script:** [DEMO-SCRIPT.md](DEMO-SCRIPT.md) ·
  **Demo walkthrough:** [DEMO.md](DEMO.md)
- **How the money works:** [NOTE-ECONOMICS.md](NOTE-ECONOMICS.md) · **ERC-20 notes and claims:**
  [ERC20-NOTES.md](ERC20-NOTES.md) · **Alerts and email binding:** [NOTIFICATIONS.md](NOTIFICATIONS.md) ·
  **Security:** [SECURITY.md](SECURITY.md) · **Runbook:** [DEPLOY.md](DEPLOY.md)
- **Planned:** collateral on other chains, home = Robinhood Chain ([CROSS-CHAIN.md](CROSS-CHAIN.md)).
- **Team:** Kwang, solo founder; involved in the MAS Project Guardian tokenized structured note pilot at Marketnode.
- **Earlier builds:** Solana, TOKEN2049, won Best Use of Chainlink CRE (https://sp.stratoslab.app); an earlier EVM build
  (notes on another chain, collateral locked on Robinhood Chain over Chainlink CCIP), whose records are kept in
  [archive/](archive/) and `deployments/archive/arbitrum-build/`.

## Where it runs

Everything a note does happens on **Robinhood Chain testnet** (chain id 46630): issuance, subscriptions, the note's
ERC-20 units, the escrow, coupons, redemption, default, and every Chainlink CRE report (written through the chain's
KeystoneForwarder; with the CRE simulator, through its MockKeystoneForwarder). Mainnets are only read, for prices.

| What | Where |
|---|---|
| Notes (FlowEngine, NotesLens, NoteToken) | Robinhood Chain testnet; fresh deployment recorded in `deployments/robinhood-testnet.json` |
| Cash | Paxos USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F` (6 decimals) |
| Collateral | USDG, WETH (`0x7943…52Fa`, the chain's bridge WETH), Robinhood's TSLA, AMZN, AMD and PLTR stock tokens, pledged into the note's escrow and valued by Chainlink after a haircut |
| Physical delivery | Below the knock-in barrier, TSLA, AMZN, AMD, PLTR or WETH (for ETH), units ÷ strike from a delivery reserve |
| Equity prices | Chainlink feeds on Robinhood Chain mainnet (TSLA, AMZN, AMD, PLTR, NVDA, AAPL, SPY, META, MSFT, GOOGL, COIN), read by CRE over its HTTP capability (JSON-RPC `eth_call`) |
| Crypto prices | Chainlink ETH/USD, BTC/USD, SOL/USD on Ethereum mainnet |
| Cash-settled only | BTC (synthetic), SOL, NVDA, AAPL and the other stocks with no token on Robinhood Chain; NFLX is held only (no feed) |

## The problem

A structured note turns a market view into an outcome agreed upfront: yield while prices stay in a range, capital
protection with some upside, exposure to a stock or a basket on defined terms, or a hedge. Banks issue them with a
calculation agent and a paying agent and weeks of structuring; investors buy where the bank sells. DeFi's yield
products are mostly vaults with rolling strategies, with no fixed term sheet or independent calculation agent. And
holders of tokenized stocks can't raise money against them without selling.

## What it does

1. **Design** (Issue workspace): a template (ten seeded, four of them on stocks), a term sheet (fixed coupon note,
   reverse convertible, phoenix with memory, snowball, principal-protected; one underlying or a worst-of basket; cash
   settlement, or physical delivery of the stock token or WETH), a sentence to the AI, or a blank BPMN canvas. Every
   edit passes the validator and compiler.
2. **Issue**: this issuance's size, dates, settlement lag and grace period (0-7 days), the collateral ratio and
   haircuts, and the collateral itself: USDG, WETH, TSLA, AMZN, AMD or PLTR, pledged straight into the note's escrow
   on Robinhood Chain. The book opens on the marketplace.
3. **Sell**: anyone with a verified email swaps USDG for units in one transaction until the strike date; the USDG is
   the issuer's at once (the funds the note raises). Holders transfer units.
4. **Observe, fund and pay**: CRE fixes the strike and observes every date, pricing the collateral too (margin call
   below the requirement). Each observation fixes what is owed; the issuer funds it into escrow before the payment
   date; funded, CRE pays it into the note and holders claim it (or the issuer's bot pushes it); not funded through
   grace, the note defaults and the holders are paid from escrow pro rata: what they are owed (the missed payment
   plus par), the rest back to the issuer (or everything, under the `all-to-holders` default rule). After the final
   payment the collateral is released to the issuer. Below a knock-in, a physical note delivers units ÷ strike of the
   (worst) underlying's token, funded the same way.

All of it is drawn in each note's BPMN (Fund Payment windows, payment dates, "Funded?" checks, grace, default and
release), and the validator refuses any payment that isn't paid from escrow behind a funding check, so canvas edits
and AI drafts can't create an unfunded payment. Worked example: [NOTE-ECONOMICS.md](NOTE-ECONOMICS.md).

## Architecture

```
template / term sheet / AI / canvas -> BPMN -> compiler -> definition (bytes, content-addressed)
                                                                  |
                FlowEngine on Robinhood Chain testnet (one contract, every note; collateral in its escrow)
   issuer: pledge, fund, top up -> escrow (engine-held) -> pay holders | default: escrow to holders | release
   verified email -> salted-hash attestation (EIP-712, verifier) -> required to issue, subscribe, receive units
                                   ^ onReport via KeystoneForwarder (robinhood-testnet)
Chainlink feeds (crypto: Ethereum mainnet; equities: Robinhood Chain mainnet over HTTP) -> CRE notes-keeper-evm
                                   (observations, collateral prices, deadlines)
notes.markets = one Cloudflare Worker: landing, app, AI (Workers AI), email (Cloudflare Email Service), API on D1,
                                   indexer and notifier on a one-minute cron
```

## Smart contracts

`packages/evm-engine`: one engine (`FlowEngine.sol`, v4) runs every note from a content-addressed definition. Note
units are ERC-20s (`NoteToken`, verified-only transfers). Payouts through one accumulator: claim by default with a
hash receipt per claim, push opt-in; a coupon report costs about 393k gas for 10 or 1,000 holders. Custom errors,
`ReentrancyGuard`, `SafeERC20`, `Ownable2Step`, `Pausable`. Reports accepted only from the forwarder, every oracle
value bounds-checked. Every product timeline is checked against the reference payoff in Foundry. The cross-chain
contracts (`HomeGateway`, `RemoteVault`, `RemoteReceipt`) and their tests stay in the repo for the planned
extension; nothing of them is deployed.

**Issuer behaviour, on the engine** (`forge test`; each timeline replayed and every holder's cash, delivered tokens
and collateral checked against the reference `simulateNote`):

| Scenario | Outcome |
|---|---|
| Funds every payment (13 product timelines; one funds in two deposits, all fund early) | the reference payoff; collateral released |
| Misses coupon 3 (phoenix) | default at the end of grace; owed 1,075 > 1,000 USDC collateral: all of it to the holders pro rata |
| Funds coupon 3 late, inside grace | cured: paid, runs to maturity |
| Half-funds the redemption (FCN, knocked in) | default; holders share the half and the collateral |
| ETH collateral falls 40%, margin call topped up | cured; continues; collateral released |
| ETH collateral falls 40%, not topped up | default; holders receive the ETH in kind |
| USDC + ETH collateral (1.2x), misses coupon 2, `cap-at-owed` | default; holders take the coupon + par (USDC first, then ETH at its price), the rest of the ETH back to the issuer |
| The same, `all-to-holders` | default; both distributed in kind, pro rata |

## Evidence

A fresh FlowEngine and NotesLens are deployed on Robinhood Chain testnet for this build ([DEPLOY.md](DEPLOY.md)); the
transactions of the first notes run on it go into `docs/evidence.json` and onto the landing page
(`scripts/landing-proof.ts`).

The same engine design already ran notes start to finish on public testnets, every price and payment written by
Chainlink CRE, in the earlier builds: a TSLA/NVDA worst-of phoenix on Robinhood Chain testnet (autocalled at
observation 2, 1.050 per unit) and an ETH/BTC phoenix on another testnet (held to maturity, 1.075 per unit). Their
transactions are in [archive/evidence.json](archive/evidence.json), and the cross-chain proof (TSLA locked on
Robinhood Chain backing a note on another chain) in [CROSS-CHAIN.md](CROSS-CHAIN.md).

## Honest limits

- **Not audited.** The engine is at 23,384 of 24,576 bytes; new features go into libraries or separate contracts.
- **CRE in the simulator.** CRE runs in Chainlink's simulator with `--broadcast`, writing real testnet transactions
  through Robinhood Chain testnet's MockKeystoneForwarder, until we have DON deploy access. On the public testnet RPC
  the keeper reads note state at the latest block; the engine re-checks every step on-chain.
- **No CRE on Robinhood Chain mainnet** yet: CRE cannot write there. A fallback keeper (off by default, labelled on
  every report, `services/keeper-fallback`) exists for chains CRE doesn't reach.
- **Testnet assets.** Only real tokens: cash is Paxos testnet USDG; ETH collateral and delivery is the chain's
  canonical WETH; Robinhood's TSLA, AMZN, AMD and PLTR are collateral and deliverable (NFLX is held only: no feed).
  Paxos and the stock tokens' issuer can pause, freeze or seize ([SECURITY.md](SECURITY.md)). BTC is synthetic
  (priced, cash-settled).
- **Equity feeds** follow NYSE hours with a 24 h heartbeat; notes accept a 4-day-old round so weekends don't block
  them.
- **Margin** is checked at each observation, not continuously.
- **Email checks can be bypassed in principle.** The email requirement is on-chain, but the attestation is signed by
  our verifier key: whoever holds it can attest addresses. It needs a KMS or multisig before mainnet.
- **Limits per note:** up to 64 holders, 12 observations, 3 underlyings, 3 collateral assets.
- **Not cleared for retail.** Structured notes are securities in most jurisdictions; the testnet product isn't
  cleared for retail distribution.

## What's next

1. Audit and hardening on testnet.
2. First issuers on Robinhood's stock tokens: raise USDG against TSLA without selling it.
3. Collateral on other chains, home = Robinhood Chain ([CROSS-CHAIN.md](CROSS-CHAIN.md)).
4. Compliance layer and distribution partners; mainnet once Chainlink CRE can write to Robinhood Chain mainnet and
   the audit is in place.

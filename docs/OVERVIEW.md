# notes.markets: overview

**One line:** structured notes on Robinhood Chain and Base, collateralised by the stocks they are written on. Anyone
issues a note on stocks or crypto and raises USDG (Robinhood Chain) or USDC (Base) against collateral: Robinhood's real
TSLA, for example, backs a TSLA note on Robinhood Chain and is delivered to holders below the barrier, or stays locked
on Robinhood Chain and backs a note on Base, carried by Chainlink CCIP with no bridge and no wrapped token. Chainlink
CRE fixes every price; the contract enforces every payment.

- **Site:** https://notes.markets · **App:** https://notes.markets/app
- **Code:** https://github.com/adappterxyz/StratosNotes-Robinhood
- **Investor deck:** [PITCH.md](PITCH.md) · **Demo video script:** [DEMO-SCRIPT.md](DEMO-SCRIPT.md) ·
  **Demo walkthrough:** [DEMO.md](DEMO.md)
- **How the money works:** [NOTE-ECONOMICS.md](NOTE-ECONOMICS.md) · **ERC-20 notes and claims:**
  [ERC20-NOTES.md](ERC20-NOTES.md) · **Alerts and email binding:** [NOTIFICATIONS.md](NOTIFICATIONS.md) ·
  **Security:** [SECURITY.md](SECURITY.md) · **Runbook:** [DEPLOY.md](DEPLOY.md)
- **Collateral on the other chain**, both directions ([CROSS-CHAIN.md](CROSS-CHAIN.md)).
- **Team:** Kwang, solo founder; involved in the MAS Project Guardian tokenized structured note pilot at Marketnode.
- **Earlier builds:** Solana, TOKEN2049, won Best Use of Chainlink CRE (https://sp.stratoslab.app); an earlier EVM build
  (notes on another chain, collateral locked on Robinhood Chain over Chainlink CCIP), whose records are kept in
  [archive/](archive/) and `deployments/archive/arbitrum-build/`.

## Where it runs

Notes run on two testnets, **Robinhood Chain testnet** (chain id 46630) and **Base Sepolia** (chain id 84532). Each
note lives on one of them, its home chain: issuance, subscriptions, the note's ERC-20 units, the escrow, coupons,
redemption, default, and every Chainlink CRE report (written through the chain's KeystoneForwarder; with the CRE
simulator, through its MockKeystoneForwarder) happen there. Mainnets are only read, for prices.

| What | Robinhood Chain testnet | Base Sepolia |
|---|---|---|
| Notes (FlowEngine, NotesLens, NoteToken) | `deployments/robinhood-testnet.json` | `deployments/base-sepolia.json` (deployment pending) |
| Cash | Paxos USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F` (6 decimals) | Circle USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals) |
| Collateral in the note | USDG, WETH (`0x7943…52Fa`, the chain's bridge WETH), Robinhood's TSLA, AMZN, AMD and PLTR stock tokens | USDC, WETH (`0x4200…0006`, the OP Stack predeploy) |
| Collateral locked on the other chain (receipts via CCIP) | USDC.base, WETH.base | USDG.rh, WETH.rh, TSLA.rh, AMZN.rh, AMD.rh, PLTR.rh |
| Physical delivery | TSLA, AMZN, AMD, PLTR or WETH (for ETH) | WETH (for ETH) |

All collateral is valued by Chainlink after a haircut (default 100% for dollars, 70% ETH, 60% stocks), the same
whether it is pledged locally or locked on the other chain.

| What | Where |
|---|---|
| Equity prices | Chainlink feeds on Robinhood Chain mainnet (TSLA, AMZN, AMD, PLTR, NVDA, AAPL, SPY, META, MSFT, GOOGL, COIN), read by CRE over its HTTP capability (JSON-RPC `eth_call`) |
| Crypto prices | Chainlink ETH/USD, BTC/USD, SOL/USD on Ethereum mainnet |
| Cash-settled only | BTC (synthetic), SOL, NVDA, AAPL and the other stocks with no token on the note's chain (every stock on Base); NFLX is held only (no feed) |

## The problem

A structured note turns a market view into an outcome agreed upfront: yield while prices stay in a range, capital
protection with some upside, exposure to a stock or a basket on defined terms, or a hedge. Banks issue them with a
calculation agent and a paying agent and weeks of structuring; investors buy where the bank sells. DeFi's yield
products are mostly vaults with rolling strategies, with no fixed term sheet or independent calculation agent. And
holders of tokenized stocks can't raise money against them without selling.

## What it does

1. **Design** (Issue): three ways in. Start from a note (one issued recently on the current engine, or a ready-made
   one: ten seeded, four of them on stocks), the product wizard (fixed coupon note, reverse convertible, phoenix with
   memory, snowball, principal-protected; one underlying or a worst-of basket; cash settlement, or physical delivery of
   the stock token or WETH), or a sentence to the AI. Each ends on a review that draws the note's BPMN workflow, the
   source of truth the compiler turns into the on-chain definition. The advanced BPMN editor opens from a review with
   that workflow loaded, never blank. Every edit passes the validator and compiler.
2. **Issue**: this issuance's size, dates, settlement lag and grace period (0-7 days), the collateral ratio and
   haircuts, and the collateral itself: pledged straight into the note's escrow on its chain, or locked in the vault
   on the other chain (Robinhood's stock tokens locked on Robinhood Chain for a Base note; USDC or WETH locked on
   Base for a Robinhood Chain note) with the receipts pledged once CCIP delivers them. The issuer picks the network in
   the issue wizard. The book opens on the marketplace.
3. **Sell**: anyone with a verified email swaps the note's cash token (USDG or USDC) for units in one transaction until the strike date; the USDG is
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
      FlowEngine on Robinhood Chain testnet | FlowEngine on Base Sepolia (one contract per chain; collateral in escrow)
   HomeGateway + receipts on each  <──── Chainlink CCIP ────>  RemoteVault on the other chain (locked collateral)
   issuer: pledge, fund, top up -> escrow (engine-held) -> pay holders | default: escrow to holders | release
   verified email -> salted-hash attestation (EIP-712, verifier) -> required to issue, subscribe, receive units
               ^ onReport via KeystoneForwarder (robinhood-testnet, ethereum-testnet-sepolia-base-1)
Chainlink feeds (crypto: Ethereum mainnet; equities: Robinhood Chain mainnet over HTTP) -> CRE notes-keeper-evm
                (observations, collateral prices, deadlines, gateway flushes, vault backing checks)
notes.markets = one Cloudflare Worker: landing, app, AI (Workers AI), email (Cloudflare Email Service), API on D1,
                                   indexer and notifier on a one-minute cron
```

## Smart contracts

`packages/evm-engine`: one engine (`FlowEngine.sol`, v4) runs every note from a content-addressed definition. Note
units are ERC-20s (`NoteToken`, verified-only transfers). Payouts through one accumulator: claim by default with a
hash receipt per claim, push opt-in; a coupon report costs about 393k gas for 10 or 1,000 holders. Custom errors,
`ReentrancyGuard`, `SafeERC20`, `Ownable2Step`, `Pausable`. Reports accepted only from the forwarder, every oracle
value bounds-checked. Every product timeline is checked against the reference payoff in Foundry. The same engine runs
on both chains. The cross-chain contracts (`HomeGateway`, `RemoteVault`, `RemoteReceipt`) carry collateral between
them, one gateway–vault pair per direction, tested on Chainlink Local and on forks of both chains' real CCIP routers.

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
(`scripts/landing-proof.ts`). The Base Sepolia engine and the two cross-chain pairs are scripted and rehearsed on
forks, and are deployed once the deployer is funded on Base Sepolia.

The same engine design already ran notes start to finish on public testnets, every price and payment written by
Chainlink CRE, in the earlier builds: a TSLA/NVDA worst-of phoenix on Robinhood Chain testnet (autocalled at
observation 2, 1.050 per unit) and an ETH/BTC phoenix on another testnet (held to maturity, 1.075 per unit). Their
transactions are in [archive/evidence.json](archive/evidence.json), and the cross-chain proof (TSLA locked on
Robinhood Chain backing a note on another chain) in [CROSS-CHAIN.md](CROSS-CHAIN.md).

## Honest limits

- **Not audited.** The engine is at 23,384 of 24,576 bytes; new features go into libraries or separate contracts.
- **CRE in the simulator.** CRE runs in Chainlink's simulator with `--broadcast`, writing real testnet transactions
  through each chain's MockKeystoneForwarder, until we have DON deploy access. On the public testnet RPC
  the keeper reads note state at the latest block; the engine re-checks every step on-chain.
- **No CRE on Robinhood Chain mainnet** yet: CRE cannot write there. A fallback keeper (off by default, labelled on
  every report, `services/keeper-fallback`) exists for chains CRE doesn't reach.
- **Testnet assets.** Only real tokens: cash is Paxos testnet USDG on Robinhood Chain and Circle testnet USDC on
  Base; ETH collateral and delivery is each chain's canonical WETH; Robinhood's TSLA, AMZN, AMD and PLTR are
  collateral and deliverable on Robinhood Chain, and collateral for Base notes when locked there (NFLX is held only:
  no feed). Paxos, Circle and the stock tokens' issuer can pause, freeze or seize ([SECURITY.md](SECURITY.md)). BTC is
  synthetic (priced, cash-settled).
- **Cross-chain latency.** Each CCIP message waits for its source chain's finality, roughly 15–25 minutes: collateral
  on the other chain is locked well before the strike, and such notes need a grace period of hours.
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
3. Live notes on Base backed by Robinhood's stock tokens locked on Robinhood Chain ([CROSS-CHAIN.md](CROSS-CHAIN.md));
   more asset chains are configuration (a vault and a wire step each).
4. Compliance layer and distribution partners; mainnet once Chainlink CRE can write to Robinhood Chain mainnet and
   the audit is in place.

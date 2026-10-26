# Underlyings: the Chainlink price catalogue

A note can be written on any price in the catalogue: US stocks and ETFs, crypto, forex and commodities, each fixed by
Chainlink on its asset's own oracle and delivered to the engine by Chainlink CRE. The catalogue is generated from
Chainlink's reference data directory and committed as `packages/core/src/products/feeds-catalogue.ts`; `FEEDS` (by
symbol) is derived from it.

**Underlyings are not collateral.** What an issuer can pledge is a separate whitelist (`COLLATERAL_SYMBOLS`: USDG,
WETH, and Robinhood's TSLA, AMZN, AMD, PLTR stock tokens on Robinhood Chain): only tokens a note can actually lock.
Likewise physical delivery is limited to tokens that exist on Robinhood Chain (`deliverableToken`: WETH for ETH,
Robinhood's TSLA, AMZN, AMD, PLTR); every other underlying, including all forex and commodities, settles in cash
(final ÷ strike in USDG below the knock-in).

## What is in it (generated 2026-10-26)

141 feeds:

| Class | Feeds | Source (first choice) |
|---|---|---|
| Stocks (US equities and ETFs: TSLA, NVDA, AAPL, SPY, QQQ, MSTR, the SLV and USO ETFs…) | 34 | Robinhood Chain mainnet |
| Crypto (ETH, BTC, SOL, LINK, DOGE, XRP…) | 87 | Ethereum mainnet, then Arbitrum One |
| Forex (EUR, GBP, JPY, CHF, AUD, CAD, CNY, KRW, SGD, HKD, SEK…, each against USD) | 18 | Ethereum mainnet, then Arbitrum One |
| Commodities (XAU gold, XAG silver) | 2 | Ethereum mainnet |

By chain: Robinhood Chain mainnet 35, Ethereum mainnet 53, Arbitrum One 53.

| Chain (CRE chain-selector name) | How the keeper reads it |
|---|---|
| `ethereum-mainnet` | CRE EVM read (`EVMClient`), finalized block |
| `ethereum-mainnet-arbitrum-1` | CRE EVM read (`EVMClient`), finalized block |
| `robinhood-mainnet` | CRE HTTP capability, one batched JSON-RPC `eth_call` per run (`httpFeedChains`, `packages/core/src/feed-rpc.ts`): CRE has no EVM read there yet |

A CRE target needs an `rpcs` entry for both EVM chains (`cre/project.yaml`); `config.*.json` keeps `httpFeedChains`
for Robinhood Chain mainnet. The fallback keeper has public RPCs for all three by default (`EVM_FEED_CHAINS`,
`HTTP_FEED_CHAINS`). A worst-of basket has at most 3 underlyings (`MAX_UNDERLYINGS`), so a report costs at most 6 EVM
reads, inside the keeper's 15-read budget per run.

## The rules (packages/core/src/products/feed-directory.ts)

Directories read: `feeds-mainnet.json` (Ethereum), `feeds-ethereum-mainnet-arbitrum-1.json` (Arbitrum One),
`feeds-robinhood-mainnet.json` (Robinhood Chain), from https://reference-data-directory.vercel.app.

Kept: standard push price feeds, i.e. an AggregatorV3 proxy (`proxyAddress`), product type Price, a plain `X / USD`
pair, Chainlink market-risk category **low** or **medium**, asset class equity/ETF, crypto, fiat or commodity.

Excluded, with the number of directory rows on 2026-10-26:

| Excluded | Why | Rows |
|---|---|---|
| Data Streams / DataLink (no proxy, `verifier` contracts, names with `-Streams-`, `-Datalink-`, `RefPrice`) | pull-based reports, not a feed CRE reads with `latestRoundData` | 827 |
| Exchange rates (`… Exchange Rate`) | a wrapped-token ratio, not a market price | 83 |
| Hidden in the directory | Chainlink does not list them | 53 |
| Crypto stablecoins and pegged assets (USDC, USDT, EURC, WBTC, stETH, PAXG…, and dollar tokens like AUSD) | pegged to another asset: a note on them is a note on the peg | 62 |
| Quoted in ETH, BTC, ARS… | not USD: the strike and payoffs are in dollars | 58 |
| Not a plain `X / USD` pair (`SPCX-USD (24/5)`, `Calculated …`) | special-purpose feeds | 36 |
| Risk category high, new, custom or none | Chainlink flags their market risk; `custom` is allowed only for Robinhood Chain's own `Robinhood <TICKER> / USD` equity feeds, the native oracle of Robinhood's stock tokens | 42 |
| Proof of reserve / reserves | not a price | 23 |
| NAV / funds (NAVLink, treasuries, money-market, private credit) | not a market price | 19 |
| Deprecated (`docs.shutdownDate`, category `deprecating`) | being shut down | 19 |
| Macro / index (CPI, economic indices) | not an asset price | 14 |
| Tickers notes cannot name (`1INCH`, `BTC.B`) | a ticker starts with a letter, capitals and digits only (`validateTermSheet`) | 2 |
| Duplicates on a network | one feed per symbol per network: the canonical path (`eth-usd` over `eth-usd-svr`), 8 decimals, the faster heartbeat | 17 |

One feed per symbol across networks: stocks from Robinhood Chain mainnet first (Robinhood's own oracle for its stock
tokens), then Arbitrum One; crypto, forex and commodities from Ethereum mainnet first, then Arbitrum One. ETFs follow
the directory's asset class (SPY, QQQ, SLV and USO are equities there: Stocks). Then every chosen feed is
read once (`latestRoundData`, read-only): a feed whose last round is older than its staleness allowance is dropped as
not live, and so is one priced below 0.00001 USD (PEPE, SHIB on 2026-10-26), whose bounds would need more decimals
than the engine's fixed point keeps.

### Staleness

The oldest round a fixing accepts (`staleness`, seconds; the keeper adds its finality allowance on top):

- Stocks, ETFs, forex, commodities: heartbeat + 3 days (259,200 s). Their feeds follow market hours and do not update
  from Friday's close to Monday's open; with the usual 24 h heartbeat that is 345,600 s, as notes have always used.
- Crypto (24/7): heartbeat + 10% (at least 5 minutes), e.g. 3,600 s → 3,960 s, 86,400 s → 95,040 s.

### Bounds

Every fixing must sit in `[minPrice, maxPrice]`, checked on-chain by the engine: a tenth of the price on the day the
catalogue was generated to ten times it, two significant figures (min rounded down, max up). EUR/USD at 1.12 gives
0.11–12; JPY/USD at 0.0064 gives 0.00063–0.064; XAU at 4,009 gives 400–41,000. Wide enough for any move over a note's
life, narrow enough to refuse a broken feed (a decimals change, a zero). Regenerating moves the bounds of new symbols
with the market; a note keeps the bounds compiled into its definition.

### Symbols notes used before the catalogue

ETH, BTC, SOL (Ethereum mainnet) and TSLA, AMZN, AMD, PLTR, NVDA, AAPL, SPY, META, MSFT, GOOGL, COIN (Robinhood
Chain mainnet) keep exactly their earlier feed, chain, bounds and staleness (`PINNED` in the generator), so templates
and saved term sheets compile to the same definitions. The generator fails if the priority would ever pick another
feed for one of them.

## Payoffs

Barriers, coupon barriers and autocall levels are % of each underlying's strike, so forex and commodity underlyings
work in every payoff unchanged (fcn, reverse convertible, phoenix, snowball, PPN, worst-of baskets mixing classes).
The Foundry fixtures run a phoenix on EUR/USD, a reverse convertible on JPY/USD (a price of 0.0064) and a worst-of FCN
on EUR, XAU and TSLA through the engine against the reference payoff. The template library has one forex note
(12M Phoenix on EUR/USD).

`validateTermSheet` refuses an underlying without a staleness, with bounds that are not plain decimals of at most 10
places, or on a feed chain the keeper does not read.

## Regenerate

```bash
npx tsx scripts/feeds-catalogue.ts --check   # download, filter, read every feed; print counts and exclusions
npx tsx scripts/feeds-catalogue.ts           # the same, then write packages/core/src/products/feeds-catalogue.ts
npm -w packages/core run test                # the catalogue tests (test/catalogue.test.ts)
```

RPCs default to public endpoints (`ETH_RPC`, `ARB_RPC`, `RH_RPC` override). Only `eth_call` is sent. Commit the
regenerated module; deployed notes are unaffected (their feeds and bounds are in their definitions), new issues use
the new catalogue. The app, the AI prompt (`packages/core/src/ai`) and the keepers read the catalogue as is.

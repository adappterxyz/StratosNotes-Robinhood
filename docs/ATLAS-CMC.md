# Atlas and CoinMarketCap: how stock-token notes are priced

Notes on BNB Chain can be written on fourteen of Binance's stock tokens (bStocks: TSLAB, NVDAB, the index ETFs SPYB and QQQB, and ten more). Two data providers price them, and a note needs both:

| Provider      | What it gives                                                    | Where it is read                                  |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| Atlas         | The token's price now, on-chain, around the clock                | Multi-Feed contract on BNB Chain mainnet          |
| Atlas         | The same price signed by Atlas, with its own quality reading     | Atlas API (`/report/v1/price/latest`)             |
| CoinMarketCap | The same token's price every five minutes, and daily since June  | Pro API (`/v3/cryptocurrency/quotes/historical`)  |
| CoinMarketCap | The token's DEX liquidity, volume and range on BNB Chain         | Pro API, DEX (`/v1/dex/token`, platform `bsc`)    |

Everything below was built during BNB Hack Bangkok (25 to 27 November 2026). The commit tagged `pre-hackathon` is
the state of the product before it: the note engine, the keepers, the app, and Chainlink-priced notes.

## Why two sources

A structured note pays or fails on a handful of prices: the start price, each coupon check, the barrier. One wrong
price moves real money, and nobody can reverse it afterwards. Stock tokens make this harder than stocks:

- They trade when the stock exchange is closed. A weekend price comes from thin markets.
- An oracle that follows the stock exchange stands still for those hours. Chainlink's equity feeds do.
- Atlas follows the token itself, so it has a weekend price, but it keeps only the latest value on-chain. There is
  no history to take a median from, and no second opinion.

So the rule is: **Atlas sets the price, CoinMarketCap has to agree, and CoinMarketCap supplies the history.**

## What Atlas is used for

1. **Fixing a note's prices.** Start price, coupon checks and barrier of a note on a stock token are Atlas's price
   of that token (`packages/core/src/products/atlas-feeds.ts`). The price is per token, so nothing is converted by
   the token's share multiplier, and a note that ends in the token delivers `1 / start price` tokens.
2. **Valuing collateral.** An issuer who locks bStocks to back a note has them valued at the same Atlas price, on
   every check, alongside the note's own prices.
3. **Staleness as a control.** Atlas writes a price at least every 60 seconds. The keeper refuses one older than 15
   minutes. When Atlas's sources disagree it stops publishing; the price then ages out and the check waits.
   On top of that, the keeper reads Atlas's own quality rating of each feed from the API: when Atlas rates its
   sources CRITICAL or SPLIT_MARKET, the check waits. The rating is not signed, so it can only delay a check, never
   change a price; if the API cannot be reached, the keeper goes on without it.

4. **Live price between checks.** A note's page shows where each token stands against its start price right now.
   The number is Atlas's signed price: the server recovers the signer of every reply and serves it only when
   Atlas's reporter key (`0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600`) signed it, together with Atlas's own
   quality status for the feed (`packages/core/src/atlas-signed.ts`, `GET /api/market/atlas`).

All fourteen feeds live in one contract, `0xeace519ebb14fb8404fa6ddd23c3b34abade44aa` on BNB Chain mainnet, read with
`fetch(bytes4 feedId)`:

| Token  | Atlas feed | CoinMarketCap id |
| ------ | ---------- | ---------------- |
| TSLAB  | 933        | 40214            |
| NVDAB  | 934        | 40215            |
| AAPLB  | 979        | 40927            |
| MSFTB  | 943        | 40589            |
| AMZNB  | 981        | 40929            |
| GOOGLB | 952        | 40793            |
| METAB  | 944        | 40592            |
| SPYB   | 956        | 40790            |
| QQQB   | 947        | 40593            |
| COINB  | 949        | 40789            |
| MSTRB  | 939        | 40536            |
| AMDB   | 942        | 40538            |
| PLTRB  | 945        | 40590            |
| NFLXB  | 996        | 40973            |

The first seven have a stand-in token on BNB Chain testnet, so a note can lock them as collateral or deliver them.
The last seven (the S&P 500 and Nasdaq-100 ETF tokens among them) are underlyings only: a note on one settles in
cash.

## What CoinMarketCap is used for

1. **Second source, aware of market hours.** No Atlas price is written to a note unless CoinMarketCap's latest
   five-minute price agrees with it (`secondSourceHold` in `packages/core/src/cmc.ts`): within 3% while the US
   stock market is open, within 2% while it is closed. At night and at weekends the token trades on its own, on
   thinner markets, so the two sources must agree more closely. Otherwise the check waits and is retried every
   minute. A note is never fixed on one publisher alone.
2. **Fixing window.** An issuer can choose a 15, 30 or 60 minute median instead of the latest price. For a stock
   token the median is taken over CoinMarketCap's five-minute prices, ending at the check's scheduled time. A spike
   that reverses within the window does not set a coupon or a barrier.
3. **Disruption rule.** With a limit of 5%, 10% or 20%: if the token's low and high inside the window are further
   apart than the limit, the check is postponed by one window, at most twice.
4. **Closing-price fixing.** A note can fix at the US market close (16:00 New York) on weekdays: the token's price
   while the stock itself is trading, not a weekend price.
5. **Back-test.** Before issuing, and on every note's page, the note's terms are replayed from each past day on
   CoinMarketCap's daily prices since the tokens listed (`packages/core/src/products/backtest.ts`,
   `GET /api/market/history`): how often it redeemed early, paid every coupon, or ended with a loss.

6. **Liquidity-aware collateral.** When an issuer pledges stock tokens, the issue flow reads each token's market
   on BNB Chain's DEXes from CoinMarketCap's DEX API: liquidity, 24-hour volume, 24-hour high and low. It suggests
   what share of the token's value to count (60% at most; less after a violent day; less again when the pledge is
   more than 10% of the liquidity) and warns when a pledge is more than half of what the market holds
   (`packages/core/src/products/liquidity.ts`, `GET /api/market/liquidity`).

## How the keeper reads them

The keeper is a Chainlink CRE workflow (`cre/notes-keeper-evm`); a fallback keeper (`services/keeper-fallback`)
applies the same rules.

- **Atlas:** one batched JSON-RPC `eth_call` to BNB Chain mainnet, at a block 20 below the head that all nodes
  agree on, so every node reads the same price.
- **CoinMarketCap:** one HTTP request per run for all tokens due. Nodes ask only for five-minute points at least 90
  seconds old, so they all receive the same closed points and reach identical consensus.
- **Atlas's quality rating:** one request per run to Atlas's API for all stock-token feeds due, reduced to one
  hold reason per feed, so nodes that saw slightly different scores still agree.
- **The keys** are keeper secrets (`CMC_API_KEY`, `ATLAS_API_KEY`, `cre/secrets.yaml`) and Worker secrets for the
  back-test, liquidity and live price. They are never in a note, the app or this repository.

Failure handling, all tested in `packages/core/test/cmc.test.ts` and `atlas-feeds.test.ts`:

| Situation                                      | What happens                                   |
| ---------------------------------------------- | ---------------------------------------------- |
| Atlas price older than 15 minutes              | Check waits                                    |
| Atlas feed id returns an empty price           | That feed fails, the check waits               |
| CoinMarketCap refuses (rate limit, bad key)    | Check waits; the log carries the error code    |
| CoinMarketCap's newest price older than 15 min | Check waits                                    |
| The two disagree by more than the limit        | Check waits                                    |
| Atlas rates its sources critical or split      | Check waits                                    |
| Atlas's API unreachable for the quality rating | Check goes on; the other controls still apply  |
| A signed price not signed by Atlas's key       | The live price is not shown                    |
| No API key configured                          | Stock-token checks wait; other notes unaffected |

## Limits to know

- **Testnet notes, mainnet prices.** Binance's stock tokens and Atlas's feeds for them exist on BNB Chain mainnet
  only. Notes run on BNB Chain testnet against stand-in tokens with the real tokens' symbols and multipliers, and
  read the real mainnet prices.
- **A wait has no deadline when the sources disagree.** Payment dates do not move, so a long disagreement eats into
  the issuer's funding time. A production version needs a rule for what happens after a set time.
- **Calendar for 2026 only.** The market-hours rule knows weekdays, the 09:30 to 16:00 New York session with
  daylight saving, and the NYSE's 2026 holidays and 13:00 early closes. A later year needs its dates added.
- **The haircut is advice.** The suggested haircut is shown to the issuer; the note's terms carry whatever the
  issuer chose, and investors see it.
- **Short history.** The tokens listed in June 2026, so the back-test covers months, not market cycles.
- **Free CoinMarketCap plan.** 15,000 credits a month covers this: a keeper run with a check due costs 1 credit.

## Code map: what was built at the hackathon

Everything after the git tag `pre-hackathon` (`git log pre-hackathon..main`). Before it: the note engine, the
keepers, the app and Chainlink-priced notes on other chains.

| Built at the hackathon | Where |
|---|---|
| Atlas Multi-Feed reads (`fetch(bytes4)`), pinned to one block for every keeper node | `packages/core/src/feed-rpc.ts`, `products/atlas-feeds.ts` |
| Stock tokens as underlyings and as collateral, priced per token | `packages/core/src/products/params.ts` |
| CoinMarketCap second-source check and five-minute history | `packages/core/src/cmc.ts` |
| Both in the Chainlink CRE keeper and the fallback keeper | `cre/notes-keeper-evm`, `services/keeper-fallback` |
| Back-test on CoinMarketCap's daily history | `packages/core/src/products/backtest.ts`, `GET /api/market/history`, `app/src/components/Backtest.tsx` |
| Market-hours rule for the second source | `packages/core/src/cmc.ts` (`usMarketOpen`, `secondSourceTolerance`) |
| Liquidity-aware collateral from CoinMarketCap DEX data | `packages/core/src/products/liquidity.ts`, `GET /api/market/liquidity`, `app/src/components/issue/CollateralMarket.tsx` |
| Atlas's quality rating holds a check (CRITICAL, SPLIT_MARKET) | `packages/core/src/atlas-signed.ts` (`atlasQualityHolds`), `cre/notes-keeper-evm/http-feeds.ts` |
| Atlas signed prices, signature verified server-side | `packages/core/src/atlas-signed.ts`, `GET /api/market/atlas`, `app/src/components/LivePrices.tsx` |
| Tests | `packages/core/test/atlas-feeds.test.ts`, `cmc.test.ts`, `backtest.test.ts`, `liquidity.test.ts`, `services/edge/test/api.test.ts` |

## Run it

Needs Node 20+, and for the keeper [Bun](https://bun.sh) and the [Chainlink CRE CLI](https://docs.chain.link/cre).

```bash
npm install
npm run typecheck && npm test          # all unit tests, no keys needed

# Keys (never committed: .keys/ is ignored)
mkdir -p .keys
echo '{"apiKey":"<your CoinMarketCap Pro API key>"}' > .keys/cmc.json

# Issue a demo note on stock tokens on BNB Chain testnet (needs funded testnet wallets in .keys/, see docs/DEPLOY.md)
CHAIN=bnb-testnet NOTE=bstock FIXING_WINDOW=15 DISRUPTION=5 STRIKE_IN=420 OBS_EVERY=600 npx tsx scripts/seed-note.ts

# Run the keeper for BNB Chain: reads Atlas and CoinMarketCap, writes the prices to the note
npx tsx scripts/cre-config.ts bnb
TARGET=bnb-settings bash scripts/keeper-loop.sh

# The site (landing page, app and API in one Cloudflare Worker)
npm run build:web
cd web && printf 'CMC_API_KEY=<your key>\nATLAS_API_KEY=<your Atlas key, optional: live prices>\n' > .dev.vars && wrangler dev
```

API keys stay on the server: the keeper reads its key as a workflow secret (`cre/secrets.yaml`), the site as a
Worker secret. Neither is in the app bundle or this repository.

Testnet only; the contracts are not audited.

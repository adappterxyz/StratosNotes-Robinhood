# StratosNotes on Arbitrum: plan

The Arbitrum Hackerhouse build: the StratosNotes EVM platform (engine, CRE keeper, indexer, API, app) on
**Arbitrum Sepolia** (where every note is issued) and **Robinhood Chain testnet** (the collateral chain), served at notes.markets.

## Chain facts (checked 2026-10-23)

| | Arbitrum Sepolia | Robinhood Chain testnet |
|---|---|---|
| Chain id | 421614 | 46630 |
| CRE | `ethereum-testnet-sepolia-arbitrum-1`; mock forwarder `0xD412…ca5d`, production `0x76c9…5E62` | `robinhood-testnet`; mock forwarder `0x0b93…3885`, production `0x8E6E…AF19` |
| Feeds on the chain | none: crypto from Ethereum mainnet, equities from Arbitrum One | none (same sources) |
| Stablecoin | our tUSD (Circle test USDC `0x75fa…AA4d` exists) | our tUSD (no stablecoin found) |
| Stocks | our tTSLA, tNVDA, tAAPL, tSPY | our test stocks; Robinhood's TSLA `0xC9f9…Bd4E`, AMZN `0x5884…9E02`, NFLX `0x3b82…8C93` (18 decimals) also exist |

Equity prices: Chainlink TSLA/USD, NVDA/USD, AAPL/USD and SPY/USD on Arbitrum One (8 decimals, 24 h heartbeat,
NYSE hours), which CRE reads as `ethereum-mainnet-arbitrum-1`. Ethereum mainnet has no US equity feeds.

## Status

| Step | Status |
|---|---|
| Engine, CRE keeper, fallback keeper, SDK, indexer, API, app (from stratosnotes-platform) | Done, tests green |
| Retarget to Arbitrum Sepolia + Robinhood testnet; equity feeds; test tokens + faucet; physical delivery in the app | Done |
| Site Worker (landing at /, app at /app/, AI, API proxy); landing reframed for Arbitrum | Done, not deployed |
| CRE e2e on an Arbitrum Sepolia fork, crypto and equity notes | Done (payouts match the reference) |
| Note economics: subscriptions to the issuer, collateral in an engine-held escrow, per-period funding calls, margin calls, grace, default to holders, release ([NOTE-ECONOMICS.md](NOTE-ECONOMICS.md)) | Done: drawn in every product and template, refused by the validator when unfunded, 19 engine timelines green |
| Testnet deployment, hosting, keeper, issuer bots, seed data | Waiting for funding and approval (docs/DEPLOY.md) |
| Demo video, evidence tables | After deployment |

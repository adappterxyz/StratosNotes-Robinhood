import { describe, expect, it } from 'vitest';
import {
  ASSET_CLASSES,
  boundsOf,
  exclusionReason,
  filterDirectory,
  pickPerSymbol,
  roundSig,
  stalenessOf,
  TICKER,
  type DirectoryEntry,
} from '../src/products/feed-directory';
import {
  catalogueFeed,
  catalogueSummary,
  COLLATERAL_SYMBOLS,
  deliverableToken,
  EXAMPLE_PRODUCTS,
  FEED_CATALOGUE,
  FEED_CHAIN_LABELS,
  FEEDS,
  HTTP_FEED_CHAINS,
  instantiateProduct,
  POPULAR_UNDERLYINGS,
  SEED_TEMPLATES,
  simulatePayoff,
  validateProductParams,
  type ProductParams,
} from '../src';

/** A directory row: an Ethereum-mainnet-style standard price feed unless overridden. */
const row = (name: string, over: Partial<DirectoryEntry> = {}, docs: DirectoryEntry['docs'] = {}): DirectoryEntry => ({
  name,
  proxyAddress: '0x' + 'ab'.repeat(20),
  path: name.toLowerCase().replace(/ \/ /, '-'),
  heartbeat: 3600,
  decimals: 8,
  feedCategory: 'low',
  feedType: 'Crypto',
  contractType: '',
  ...over,
  docs: { assetClass: 'Crypto', productType: 'Price', deliveryChannelCode: 'DF', ...docs },
});

describe('the catalogue filter (Chainlink reference data directory)', () => {
  it('keeps standard USD push price feeds', () => {
    expect(exclusionReason('mainnet', row('ETH / USD'))).toBeNull();
    expect(
      exclusionReason('mainnet', row('EUR / USD', { heartbeat: 86400 }, { assetClass: 'Fiat', marketHours: 'Forex' })),
    ).toBeNull();
    expect(exclusionReason('mainnet', row('XAU / USD', {}, { assetClass: 'Commodity' }))).toBeNull();
    expect(exclusionReason('ethereum-mainnet-arbitrum-1', row('TSLA / USD', {}, { assetClass: 'Equity' }))).toBeNull();
  });

  it('excludes Data Streams, DataLink, proof of reserve, exchange rates, NAV, macro, deprecated and hidden feeds', () => {
    const why = (e: DirectoryEntry, n: 'mainnet' | 'ethereum-mainnet-arbitrum-1' = 'mainnet') => exclusionReason(n, e);
    expect(why(row('BNB/USD-Streams-TWAP-60s', { proxyAddress: null, contractType: 'verifier' }))).toMatch(/Streams/);
    expect(why(row('EUR/USD-Datalink-RefPrice', {}, { deliveryChannelCode: 'DS' }))).toMatch(/DataLink/);
    expect(why(row('WBTC PoR', {}, { productType: 'Proof of Reserve' }))).toBe('proof of reserve');
    expect(why(row('TUSD Reserves'))).toBe('proof of reserve');
    expect(why(row('WSTETH / STETH Exchange Rate'))).toBe('exchange rate');
    expect(why(row('JTRSY NAV', {}, { productType: 'NAVLink', assetClass: 'U.S. Treasuries' }))).toBe('NAV / fund');
    expect(why(row('US CPI', {}, { productType: 'Macroeconomics', assetClass: 'Macroeconomics' }))).toBe(
      'macro / index',
    );
    expect(why(row('CSPX / USD', { feedCategory: 'deprecating' }, { shutdownDate: 'September 2nd, 2026' }))).toBe(
      'deprecated',
    );
    expect(why(row('BTC / USD', {}, { hidden: true }))).toMatch(/hidden/);
  });

  it('keeps only X / USD pairs, low or medium risk, no stablecoins or pegged assets, and tickers notes accept', () => {
    const why = (e: DirectoryEntry) => exclusionReason('mainnet', e);
    expect(why(row('ETH / BTC'))).toMatch(/quoted in BTC/);
    expect(why(row('USD / ARS', {}, { assetClass: 'Fiat' }))).toMatch(/quoted in ARS/);
    expect(why(row('SPCX-USD (24/5)', {}, { assetClass: 'Equity' }))).toMatch(/plain X \/ USD/);
    expect(why(row('MEME / USD', { feedCategory: 'high' }))).toMatch(/risk category 'high'/);
    expect(why(row('NEWT / USD', { feedCategory: 'new' }))).toMatch(/risk category 'new'/);
    expect(why(row('ONDO / USD', { feedCategory: 'custom' }))).toMatch(/risk category 'custom'/);
    expect(why(row('USDC / USD', {}, { assetSubClass: 'Stablecoin' }))).toMatch(/Stablecoin/);
    expect(why(row('WBTC / USD', {}, { assetSubClass: 'Pegged Asset' }))).toMatch(/Pegged/);
    expect(why(row('AUSD / USD'))).toMatch(/stablecoin/);
    expect(why(row('1INCH / USD'))).toMatch(/not a ticker/);
  });

  it("allows 'custom' risk only for Robinhood Chain's own equity feeds", () => {
    const rh = row('Robinhood TSLA / USD', { feedCategory: 'custom', heartbeat: 86400 }, { assetClass: 'Equity' });
    expect(exclusionReason('robinhood-mainnet', rh)).toBeNull();
    expect(exclusionReason('mainnet', rh)).not.toBeNull();
    const rhDash = row('Robinhood DELL-USD', { feedCategory: 'custom', heartbeat: 86400 }, { assetClass: 'Equity' });
    expect(exclusionReason('robinhood-mainnet', rhDash)).toBeNull();
    expect(filterDirectory('robinhood-mainnet', [rhDash]).kept[0]).toMatchObject({
      symbol: 'DELL',
      assetClass: 'Stocks',
      feedChain: 'robinhood-mainnet',
    });
  });

  it('picks the canonical feed among duplicates on a network', () => {
    const { kept, excluded } = filterDirectory('mainnet', [
      row('ETH / USD', { proxyAddress: '0x' + '11'.repeat(20), path: 'eth-usd-svr' }),
      row('ETH / USD', { proxyAddress: '0x' + '22'.repeat(20), path: 'eth-usd' }),
      row('ETH / USD', { proxyAddress: '0x' + '33'.repeat(20), path: 'eth-usd-shared-svr' }),
    ]);
    expect(kept.map((c) => c.feed)).toEqual(['0x' + '22'.repeat(20)]);
    expect(excluded.filter((x) => x.reason === 'duplicate on the network')).toHaveLength(2);
  });

  it('prefers Robinhood Chain for stocks and Ethereum for crypto, forex and commodities', () => {
    const rh = filterDirectory('robinhood-mainnet', [
      row('Robinhood TSLA / USD', { feedCategory: 'custom' }, { assetClass: 'Equity' }),
      row('ETH / USD'),
    ]).kept;
    const arb = filterDirectory('ethereum-mainnet-arbitrum-1', [
      row('TSLA / USD', {}, { assetClass: 'Equity' }),
      row('ETH / USD'),
      row('HKD / USD', {}, { assetClass: 'Fiat' }),
    ]).kept;
    const eth = filterDirectory('mainnet', [row('ETH / USD'), row('EUR / USD', {}, { assetClass: 'Fiat' })]).kept;
    const { picked } = pickPerSymbol([...arb, ...rh, ...eth]);
    const src = Object.fromEntries(picked.map((c) => [c.symbol, c.feedChain]));
    expect(src).toEqual({
      TSLA: 'robinhood-mainnet',
      ETH: 'ethereum-mainnet',
      EUR: 'ethereum-mainnet',
      HKD: 'ethereum-mainnet-arbitrum-1',
    });
    expect(picked.map((c) => c.assetClass)).toEqual(['Stocks', 'Crypto', 'Forex', 'Forex']);
  });

  it('staleness: heartbeat + a weekend in market hours, + 10% for crypto', () => {
    expect(stalenessOf({ assetClass: 'Stocks', heartbeat: 86400 })).toBe(345_600);
    expect(stalenessOf({ assetClass: 'Forex', heartbeat: 86400 })).toBe(345_600);
    expect(stalenessOf({ assetClass: 'Commodities', heartbeat: 3600 })).toBe(262_800);
    expect(stalenessOf({ assetClass: 'Crypto', heartbeat: 3600 })).toBe(3960);
    expect(stalenessOf({ assetClass: 'Crypto', heartbeat: 86400 })).toBe(95_040);
    expect(stalenessOf({ assetClass: 'Crypto', heartbeat: 60 })).toBe(360);
  });

  it('bounds: a tenth to ten times the price, two significant figures, plain decimals', () => {
    expect(boundsOf(1.1634)).toEqual({ minPrice: 0.11, maxPrice: 12 });
    expect(boundsOf(0.006423)).toEqual({ minPrice: 0.00064, maxPrice: 0.065 });
    expect(boundsOf(2650)).toEqual({ minPrice: 260, maxPrice: 27_000 });
    expect(roundSig(0.3, 'down')).toBe(0.3);
    expect(roundSig(0.30000001, 'up')).toBe(0.31);
    expect(() => boundsOf(0.000004)).toThrow();
  });
});

describe('the generated catalogue', () => {
  it('has stocks, crypto, forex and commodities, one feed per symbol, every field sane', () => {
    const syms = FEED_CATALOGUE.map((f) => f.symbol);
    expect(new Set(syms).size).toBe(syms.length);
    for (const c of ASSET_CLASSES)
      expect(
        FEED_CATALOGUE.some((f) => f.assetClass === c),
        c,
      ).toBe(true);
    for (const s of ['EUR', 'JPY', 'GBP', 'XAU', 'XAG', 'DOGE', 'LINK', 'QQQ']) expect(syms).toContain(s);
    for (const f of FEED_CATALOGUE) {
      expect(TICKER.test(f.symbol), f.symbol).toBe(true);
      expect(f.feed, f.symbol).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(FEED_CHAIN_LABELS[f.feedChain], f.symbol).toBeDefined();
      expect(f.staleness, f.symbol).toBeGreaterThanOrEqual(f.heartbeat);
      expect(f.minPrice, f.symbol).toBeGreaterThan(0);
      expect(f.maxPrice, f.symbol).toBeGreaterThan(f.minPrice);
      expect(['low', 'medium', 'custom'], f.symbol).toContain(f.risk);
      if (f.risk === 'custom') expect(f.feedChain, f.symbol).toBe('robinhood-mainnet');
      if (f.assetClass !== 'Crypto') expect(f.staleness, f.symbol).toBeGreaterThanOrEqual(f.heartbeat + 259_200);
    }
    // Stocks come from Robinhood Chain wherever it has them.
    for (const s of ['TSLA', 'NVDA', 'QQQ', 'MSTR']) expect(catalogueFeed(s)?.feedChain).toBe('robinhood-mainnet');
    for (const s of ['ETH', 'BTC', 'EUR', 'XAU']) expect(catalogueFeed(s)?.feedChain).toBe('ethereum-mainnet');
  });

  it('every feed chain is one the keeper reads: a CRE EVM read chain, or an HTTP feed chain', () => {
    const evmRead = ['ethereum-mainnet', 'ethereum-mainnet-arbitrum-1'];
    for (const f of FEED_CATALOGUE)
      expect(evmRead.includes(f.feedChain) || !!HTTP_FEED_CHAINS[f.feedChain], f.feedChain).toBe(true);
  });

  it('keeps FEEDS: the symbols notes used before, with their exact values', () => {
    const equity = { feedChain: 'robinhood-mainnet', minPrice: 1, maxPrice: 100_000, staleness: 345_600 };
    expect(FEEDS.ETH).toEqual({
      symbol: 'ETH',
      feed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
      feedChain: 'ethereum-mainnet',
      minPrice: 1,
      maxPrice: 1_000_000,
      staleness: 3600,
    });
    expect(FEEDS.BTC).toEqual({
      symbol: 'BTC',
      feed: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
      feedChain: 'ethereum-mainnet',
      minPrice: 1,
      maxPrice: 10_000_000,
      staleness: 3600,
    });
    expect(FEEDS.SOL).toEqual({
      symbol: 'SOL',
      feed: '0x4ffC43a60e009B551865A93d232E33Fce9f01507',
      feedChain: 'ethereum-mainnet',
      minPrice: 0.01,
      maxPrice: 100_000,
      staleness: 86400,
    });
    const eq: Record<string, string> = {
      TSLA: '0x4A1166a659A55625345e9515b32adECea5547C38',
      AMZN: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C',
      AMD: '0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72',
      PLTR: '0x820ABedFF239034956B7A9d2F0a331f9F075eB4c',
      NVDA: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15',
      AAPL: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0',
      SPY: '0x319724394D3A0e3669269846abE664Cd621f9f6A',
      META: '0x7C38C00C30BEe9378381E7B6135d7283356D71b1',
      MSFT: '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E',
      GOOGL: '0xF6f373a037c30F0e5010d854385cA89185AE638b',
      COIN: '0xA3a468A452940B7D6b69991207B508c609a98Ef2',
    };
    for (const [s, feed] of Object.entries(eq))
      expect(FEEDS[s as keyof typeof FEEDS], s).toEqual({ symbol: s, feed, ...equity });
    // An Underlying carries only what the engine and keeper read: definitions stay the same.
    for (const u of Object.values(FEEDS))
      expect(Object.keys(u).sort()).toEqual(['feed', 'feedChain', 'maxPrice', 'minPrice', 'staleness', 'symbol']);
    for (const s of POPULAR_UNDERLYINGS) expect(FEEDS[s], s).toBeDefined();
  });

  it('keeps collateral a separate whitelist', () => {
    expect(COLLATERAL_SYMBOLS).toEqual(['USD', 'ETH', 'TSLA', 'AMZN', 'AMD', 'PLTR']);
    const p: ProductParams = {
      ...EXAMPLE_PRODUCTS.fcn,
      underlyings: [FEEDS.EUR],
      collateral: [{ symbol: 'EUR' as never, haircutPct: 90 }],
    };
    expect(validateProductParams(p).join(' ')).toMatch(/'EUR' cannot be pledged/);
  });

  it('summarises the catalogue by class, popular symbols first', () => {
    expect(catalogueSummary(3)).toMatch(/^Stocks: TSLA, NVDA, AAPL and \d+ more; Crypto: ETH, BTC, SOL and \d+ more;/);
    expect(catalogueSummary()).toContain('Forex: EUR');
    expect(catalogueSummary()).toContain('Commodities: XAU');
  });
});

describe('forex and commodity underlyings', () => {
  const eurPhoenix: ProductParams = {
    ...EXAMPLE_PRODUCTS.phoenix,
    name: 'Phoenix on EUR/USD',
    underlyings: [FEEDS.EUR],
  };

  it('issue in every payoff, cash-settled', () => {
    for (const p of Object.values(EXAMPLE_PRODUCTS)) {
      for (const u of [FEEDS.EUR, FEEDS.JPY, FEEDS.XAU]) {
        const q = { ...p, underlyings: [u] };
        expect(validateProductParams(q), `${p.productType} on ${u.symbol}`).toEqual([]);
        expect(instantiateProduct(q).bpmnXml).toContain(u.feed);
      }
    }
    expect(validateProductParams({ ...eurPhoenix, underlyings: [FEEDS.EUR, FEEDS.XAU, FEEDS.TSLA] })).toEqual([]);
  });

  it('refuse physical delivery: there is no EUR or gold token to deliver', () => {
    expect(deliverableToken({}, 'EUR')).toBeUndefined();
    expect(deliverableToken({}, 'XAU')).toBeUndefined();
    expect(validateProductParams({ ...eurPhoenix, settlement: 'physical' }).join(' ')).toMatch(
      /no EUR token to deliver/,
    );
  });

  it('pay the same as any other underlying: barriers are % of the strike', () => {
    const eur = simulatePayoff(eurPhoenix, 1.16, [1.16 * 0.6, 1.16 * 0.65, 1.16 * 0.8, 1.16 * 0.75]);
    const eth = simulatePayoff(EXAMPLE_PRODUCTS.phoenix, 2000, [1200, 1300, 1600, 1500]);
    expect(eur).toEqual(eth);
  });

  it('refuse an underlying without staleness or with bounds the engine cannot hold', () => {
    const { staleness: _s, ...noStaleness } = FEEDS.EUR;
    expect(validateProductParams({ ...eurPhoenix, underlyings: [noStaleness] }).join(' ')).toMatch(/staleness/);
    expect(
      validateProductParams({ ...eurPhoenix, underlyings: [{ ...FEEDS.EUR, minPrice: 1e-12 }] }).join(' '),
    ).toMatch(/plain decimals/);
    expect(
      validateProductParams({ ...eurPhoenix, underlyings: [{ ...FEEDS.EUR, feedChain: 'polygon-mainnet' }] }).join(' '),
    ).toMatch(/keeper reads prices/);
  });

  it('the template library stays valid', () => {
    for (const t of SEED_TEMPLATES) {
      const p = t.source.product ?? t.source.basis;
      if (p) expect(validateProductParams(p), t.name).toEqual([]);
    }
  });
});

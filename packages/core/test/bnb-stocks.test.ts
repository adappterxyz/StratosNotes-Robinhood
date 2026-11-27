import { describe, expect, it } from 'vitest';
import {
  BSC_MAINNET_FEED_CHAIN,
  isAtlasFeed,
  oracleFeeds,
  BNB_TESTNET_FEED_CHAIN,
  BSTOCK_SYMBOLS,
  BSTOCKS,
  CASH_TOKENS,
  CHAIN_TOKENS,
  cashTokenOf,
  collateralChoices,
  collateralFeed,
  collateralMultiplierFeed,
  collateralSymbolOfAsset,
  collateralTokenOf,
  compileTemplate,
  deliverableToken,
  EXAMPLE_PRODUCTS,
  EXTERNAL_TOKENS,
  FEED_CHAIN_LABELS,
  FEEDS,
  instantiateProduct,
  isBStockSymbol,
  NOTE_CHAIN_LABELS,
  pendingPlan,
  RECEIPTS,
  STOCK_TOKEN_FAUCETS,
  toChain,
  undeployedTokensOf,
  validateProductParams,
  wirePlan,
  XC_CHAINS,
  type ProductParams,
  collateralRefMultiplierFeed,
} from '../src';

const BNB = 'bnb-testnet' as const;
const BASE = 'base-sepolia' as const;
const RH = 'robinhood-testnet' as const;

/** A BNB Chain note on TSLA, physically settled (in TSLAB), backed by TSLAB pledged into the note. */
const bnbTsla: ProductParams = {
  ...EXAMPLE_PRODUCTS.fcn,
  name: '12M FCN on TSLA (BNB Chain), physical',
  chain: BNB,
  underlyings: [FEEDS.TSLA],
  settlement: 'physical',
  collateral: [{ symbol: 'TSLAB', haircutPct: 60 }],
};

describe("Binance's bStocks on BNB Chain: notes.markets stand-ins on BNB Chain testnet", () => {
  it('knows BNB Chain testnet as a third note chain, settled in the nmUSD test dollar', () => {
    expect(NOTE_CHAIN_LABELS[BNB]).toBe('BNB Chain testnet');
    expect(cashTokenOf(BNB)).toEqual({ token: 'nmUSD', decimals: 6 });
    expect(XC_CHAINS[BNB]).toMatchObject({
      chainId: 97,
      selector: '13264668187771770619',
      creName: 'binance_smart_chain-testnet',
    });
    expect(FEED_CHAIN_LABELS[BNB_TESTNET_FEED_CHAIN]).toBe('BNB Chain testnet');
    expect(Object.keys(CHAIN_TOKENS[BNB]).sort()).toEqual(['nmUSD', ...BSTOCK_SYMBOLS].sort());
    expect(collateralSymbolOfAsset('Collateral nmUSD')).toBe('USD');
  });

  it('maps each stand-in to its real bStock and the share it represents', () => {
    expect(BSTOCK_SYMBOLS).toEqual(['TSLAB', 'NVDAB', 'AAPLB', 'MSFTB', 'AMZNB', 'GOOGLB', 'METAB']);
    for (const s of BSTOCK_SYMBOLS) {
      const b = BSTOCKS[s];
      expect(b.decimals).toBe(18);
      expect(b.mainnetToken).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(FEEDS[b.ticker], b.ticker).toBeDefined();
      expect(CHAIN_TOKENS[BNB][s]).toMatchObject({ token: s, decimals: 18, valuedAs: s });
      expect(CHAIN_TOKENS[BNB][s].bstock).toMatchObject({ delivers: b.ticker, standIn: true });
    }
    expect(isBStockSymbol('TSLAB')).toBe(true);
    expect(isBStockSymbol('TSLAc')).toBe(false);
  });

  it("values a bStock with Atlas's price of the token itself: one feed, no multiplier", () => {
    // Atlas prices one TOKEN from the token's own markets, so the multiplier is already in the price.
    expect(collateralFeed('TSLAB')).toEqual(FEEDS.TSLAB);
    expect(isAtlasFeed(FEEDS.TSLAB.feed)).toBe(true);
    expect(FEEDS.TSLAB.feedChain).toBe(BSC_MAINNET_FEED_CHAIN);
    expect(collateralMultiplierFeed('TSLAB')).toBeUndefined();
    expect(collateralRefMultiplierFeed('TSLAB')).toBeUndefined();
    const prod = instantiateProduct(bnbTsla);
    expect(prod.assets.find((a) => a.id === 'col_TSLAB')).toMatchObject({ name: 'Collateral TSLAB', decimals: 18 });
    const c = compileTemplate({ product: bnbTsla });
    const names = c.def.fields.map((f) => f.name);
    expect(names).toContain('px_TSLAB');
    for (const n of ['pxs_TSLAB', 'pxm_TSLAB', 'pxr_TSLAB']) expect(names).not.toContain(n);
    expect(oracleFeeds(c.def).px_TSLAB).toMatchObject({ feed: FEEDS.TSLAB.feed, feedChain: BSC_MAINNET_FEED_CHAIN });
    // Coverage reads px_TSLAB like any other collateral price.
    expect(prod.bpmnXml).toMatch(/\* px_TSLAB \* haircut_TSLAB/);
  });

  it('writes a note on the stock token itself: fixed on Atlas, delivered token for token', () => {
    const p: ProductParams = { ...bnbTsla, underlyings: [FEEDS.TSLAB], settlement: 'physical' };
    expect(validateProductParams(p)).toEqual([]);
    // 1 / strike is already a number of tokens: no multiplier is read at the final observation.
    const d = deliverableToken({ chain: BNB }, 'TSLAB');
    expect(d).toMatchObject({ token: 'TSLAB', decimals: 18 });
    expect(d?.multiplier).toBeUndefined();
    expect(d?.reference).toBeUndefined();
    const c = compileTemplate({ product: p });
    const o = oracleFeeds(c.def);
    expect(o.initialLevel).toMatchObject({ feed: FEEDS.TSLAB.feed, feedChain: BSC_MAINNET_FEED_CHAIN, staleness: 900 });
    expect(Object.keys(o).some((k) => /mult/i.test(k))).toBe(false);
  });

  it("delivers a share underlying in its bStock at shares / multiplier, the shares from Robinhood's multiplier", () => {
    expect(deliverableToken({ chain: BNB }, 'TSLA')).toMatchObject({
      token: 'TSLAB',
      decimals: 18,
      multiplier: { field: 'mult_TSLA', feed: { feedChain: BNB_TESTNET_FEED_CHAIN } },
    });
    expect(deliverableToken({ chain: BNB }, 'GOOGL')).toMatchObject({ token: 'GOOGLB' });
    expect(deliverableToken({ chain: BNB }, 'ETH')).toBeUndefined();
    expect(deliverableToken({ chain: BNB }, 'TSLA')?.reference).toMatchObject({ field: 'rmult_TSLA' });
    expect(instantiateProduct(bnbTsla).bpmnXml).toMatch(/1 \/ initialLevel \* rmult_TSLA \/ mult_TSLA/);
  });

  it('is offered, served and wired now BNB Chain testnet is deployed', () => {
    for (const s of ['nmUSD', ...BSTOCK_SYMBOLS]) expect(EXTERNAL_TOKENS[BNB][s]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(CASH_TOKENS[BNB]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(STOCK_TOKEN_FAUCETS[BNB]).toMatch(/^https:\/\/testnet\.bscscan\.com\/address\/0x/);
    expect(undeployedTokensOf(bnbTsla)).toEqual([]);
    expect(validateProductParams(bnbTsla)).toEqual([]);
    expect(
      collateralChoices({ chain: BNB })
        .filter((c) => c.token)
        .map((c) => c.token),
    ).toEqual(['nmUSD', ...BSTOCK_SYMBOLS]);
    // The network picker keeps physical delivery in TSLAB on BNB Chain.
    expect(toChain({ ...bnbTsla, chain: undefined }, BNB).settlement).toBe('physical');
    // Every pair with BNB Chain is wired, nothing pending.
    expect(wirePlan(RH, BNB).map((w) => w.symbol)).toEqual(['nmUSD.bnb', ...BSTOCK_SYMBOLS.map((s) => `${s}.bnb`)]);
    expect(pendingPlan(RH, BNB)).toEqual([]);
  });

  it('lets notes on the other chains lock bStocks on BNB Chain, and BNB notes lock theirs', () => {
    const rhNote: ProductParams = {
      ...EXAMPLE_PRODUCTS.phoenix,
      collateralChain: BNB,
      collateral: [{ symbol: 'NVDAB', haircutPct: 60 }],
    };
    expect(collateralTokenOf(rhNote, 'NVDAB')).toEqual({ token: 'NVDAB.bnb', decimals: 18 });
    expect(RECEIPTS['NVDAB.bnb']).toMatchObject({ homes: [RH, BASE], asset: BNB, symbol: 'NVDAB' });
    expect(instantiateProduct(rhNote).bpmnXml).toMatch(/\* px_NVDAB \* haircut_NVDAB/);
    expect(instantiateProduct(rhNote).bpmnXml).not.toMatch(/pxm_NVDAB/);
    const bnbNote: ProductParams = {
      ...EXAMPLE_PRODUCTS.phoenix,
      chain: BNB,
      collateralChain: RH,
      collateral: [{ symbol: 'TSLA', haircutPct: 60 }],
    };
    expect(collateralTokenOf(bnbNote, 'TSLA')).toEqual({ token: 'TSLA.rh', decimals: 18 });
    expect(RECEIPTS['TSLA.rh'].homes).toEqual([BASE, BNB]);
    const viaBase: ProductParams = {
      ...bnbNote,
      collateralChain: BASE,
      collateral: [{ symbol: 'TSLAc', haircutPct: 60 }],
    };
    expect(collateralTokenOf(viaBase, 'TSLAc')).toEqual({ token: 'TSLAc.base', decimals: 8 });
    expect(validateProductParams(viaBase)).toEqual([]);
  });
});

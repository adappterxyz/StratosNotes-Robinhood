import { describe, expect, it } from 'vitest';
import {
  CASH_TOKENS,
  CHAIN_TOKENS,
  collateralChoices,
  collateralSymbolOfAsset,
  collateralTokenOf,
  compileTemplate,
  deliverableToken,
  EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF,
  EXTERNAL_TOKENS,
  FEEDS,
  instantiateProduct,
  isRetiredTestToken,
  normalizeParams,
  NOTE_CHAINS,
  RETIRED_TEST_TOKENS,
  HOME_CHAIN,
  ISSUANCE_CHAINS,
  isLegacyChainTerms,
  isRemoteCollateral,
  REMOTE_COLLATERAL,
  SEED_TEMPLATES,
  toIssuanceTerms,
  templateOffered,
  UNPRICED_STOCKS,
  validateProductParams,
  validateTermSheet,
  type ProductParams,
} from '../src';

const rc: ProductParams = {
  ...EXAMPLE_PRODUCTS['reverse-convertible'],
  name: 'RC on TSLA',
  underlyings: [FEEDS.TSLA],
  settlement: 'physical',
};
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const tokensOf = (p: ProductParams) =>
  instantiateProduct(p)
    .assets.filter((a) => a.kind === 'cash')
    .map((a) => a.token!);

describe('real tokens on Robinhood Chain', () => {
  it('lists USDG, WETH and the stock tokens on Robinhood Chain testnet, the only note chain', () => {
    expect(NOTE_CHAINS).toEqual(['robinhood-testnet']);
    expect(HOME_CHAIN).toBe('robinhood-testnet');
    expect(ISSUANCE_CHAINS).toEqual(['robinhood-testnet']);
    expect(Object.keys(CHAIN_TOKENS).sort()).toEqual(['robinhood-testnet']);
    expect(Object.keys(CHAIN_TOKENS['robinhood-testnet']).sort()).toEqual([
      'AMD',
      'AMZN',
      'NFLX',
      'PLTR',
      'TSLA',
      'USDG',
      'WETH',
    ]);
    for (const c of NOTE_CHAINS)
      for (const t of Object.values(CHAIN_TOKENS[c])) {
        expect(t.address).toMatch(ADDR);
        expect(EXTERNAL_TOKENS[c][t.token]).toBe(t.address);
        expect(isRetiredTestToken(t.token)).toBe(false);
      }
    expect(CHAIN_TOKENS['robinhood-testnet'].WETH.address).toBe('0x7943e237c7F95DA44E0301572D358911207852Fa');
    expect(CASH_TOKENS).toEqual({ 'robinhood-testnet': '0x7E955252E15c84f5768B83c41a71F9eba181802F' });
    expect(UNPRICED_STOCKS).toEqual(['NFLX']);
  });

  it('delivers Robinhood Chain tokens: the stock tokens and WETH; BTC and the rest settle in cash', () => {
    expect(deliverableToken({}, 'TSLA')).toEqual({ token: 'TSLA', decimals: 18 });
    expect(deliverableToken({}, 'AMZN')).toEqual({ token: 'AMZN', decimals: 18 });
    expect(deliverableToken({}, 'AMD')).toEqual({ token: 'AMD', decimals: 18 });
    expect(deliverableToken({ chain: 'robinhood-testnet' }, 'PLTR')).toEqual({ token: 'PLTR', decimals: 18 });
    expect(deliverableToken({}, 'ETH')).toEqual({ token: 'WETH', decimals: 18 });
    expect(deliverableToken({}, 'NFLX')).toBeUndefined(); // held only: no feed
    for (const s of ['BTC', 'SOL', 'NVDA', 'AAPL', 'SPY', 'META']) expect(deliverableToken({}, s)).toBeUndefined();
  });

  it('offers every collateral asset as a real Robinhood Chain token, never a test token', () => {
    expect(collateralChoices({})).toEqual([
      { symbol: 'USD', token: 'USDG' },
      { symbol: 'ETH', token: 'WETH' },
      { symbol: 'TSLA', token: 'TSLA' },
      { symbol: 'AMZN', token: 'AMZN' },
      { symbol: 'AMD', token: 'AMD' },
      { symbol: 'PLTR', token: 'PLTR' },
    ]);
    expect(collateralChoices({ collateralChain: 'note' })).toEqual(collateralChoices({}));
    for (const c of collateralChoices({})) expect(isRetiredTestToken(c.token!)).toBe(false);
  });

  it('compiles the delivered token into the definition', () => {
    expect(instantiateProduct(rc).assets.find((a) => a.id === 'd_TSLA')).toMatchObject({ token: 'TSLA', decimals: 18 });
    expect(validateProductParams(rc)).toEqual([]);
    const eth: ProductParams = { ...rc, underlyings: [FEEDS.ETH] };
    expect(instantiateProduct(eth).assets.find((a) => a.id === 'd_ETH')).toMatchObject({ token: 'WETH', decimals: 18 });
    expect(compileTemplate({ product: rc }).hash.length).toBe(32);
  });

  it('refuses tokens the chain does not have, another chain, and collateral held elsewhere', () => {
    const amzn: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, collateral: [{ symbol: 'AMZN', haircutPct: 60 }] };
    expect(validateProductParams(amzn)).toEqual([]);
    for (const chain of ['arbitrum-sepolia', 'nasdaq'])
      expect(validateProductParams({ ...amzn, chain: chain as never }).join(' ')).toMatch(
        /Notes run on Robinhood Chain testnet only/,
      );
    expect(validateProductParams({ ...amzn, collateralChain: 'robinhood' }).join(' ')).toMatch(
      /Collateral on other chains \(robinhood\) is not available yet/,
    );
    // BTC is synthetic: never collateral.
    const btc = {
      ...EXAMPLE_PRODUCTS.phoenix,
      collateral: [{ symbol: 'BTC', haircutPct: 70 }],
    } as unknown as ProductParams;
    expect(validateTermSheet(btc).join(' ')).toMatch(/'BTC' cannot be pledged/);
    const eth: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, collateral: [{ symbol: 'ETH', haircutPct: 70 }] };
    expect(validateTermSheet(eth)).toEqual([]);
    const solPhysical: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, underlyings: [FEEDS.SOL], settlement: 'physical' };
    expect(validateProductParams(solPhysical).join(' ')).toMatch(/no SOL token to deliver on Robinhood Chain testnet/);
    expect(validateProductParams({ ...solPhysical, settlement: 'cash' })).toEqual([]);
  });

  it('settles in USDG', () => {
    expect(instantiateProduct({ ...rc, settlement: 'cash' }).assets.find((a) => a.id === 'cash')).toMatchObject({
      token: 'USDG',
      decimals: 6,
    });
  });

  it("fixes each asset on its native chain's oracle: equities on Robinhood Chain, crypto on Ethereum", () => {
    expect(FEEDS.AMZN).toMatchObject({
      feed: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C',
      feedChain: 'robinhood-mainnet',
      staleness: 345_600,
    });
    expect(FEEDS.TSLA.feed).toBe('0x4A1166a659A55625345e9515b32adECea5547C38');
    for (const s of ['TSLA', 'AMZN', 'AMD', 'PLTR', 'NVDA', 'AAPL', 'SPY', 'META', 'MSFT', 'GOOGL', 'COIN'] as const)
      expect(FEEDS[s].feedChain).toBe('robinhood-mainnet');
    for (const s of ['ETH', 'BTC', 'SOL'] as const) expect(FEEDS[s].feedChain).toBe('ethereum-mainnet');
    // Collateral is valued by the same feed as the asset itself.
    const p: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, collateral: [{ symbol: 'TSLA', haircutPct: 60 }] };
    expect(JSON.stringify(instantiateProduct(p).bpmnXml)).toContain(FEEDS.TSLA.feed);
  });

  it('reads term sheets saved with the retired stockTokens switch', () => {
    expect(normalizeParams({ ...rc, stockTokens: 'robinhood' } as ProductParams)).toEqual(rc);
    expect(normalizeParams({ ...rc, stockTokens: 'test' } as ProductParams)).toEqual(rc);
    expect(normalizeParams(rc)).toBe(rc);
  });

  it('maps collateral asset names, old and new, to their symbols', () => {
    expect(collateralSymbolOfAsset('Collateral WETH')).toBe('ETH');
    expect(collateralSymbolOfAsset('Collateral TSLA')).toBe('TSLA');
    expect(collateralSymbolOfAsset('Collateral TSLA.rh')).toBe('TSLA');
    expect(collateralSymbolOfAsset('Collateral USDG.rh')).toBe('USD');
    expect(collateralSymbolOfAsset('Collateral tUSD')).toBe('USD');
    expect(collateralSymbolOfAsset('Collateral tETH')).toBe('ETH');
    expect(collateralSymbolOfAsset('USDG')).toBeNull();
  });
});

describe('the ready-made library', () => {
  it('uses only real tokens, and every entry validates', () => {
    for (const t of SEED_TEMPLATES) {
      const p = t.source.product ?? t.source.basis!;
      expect(validateProductParams(p), t.name).toEqual([]);
      const tokens = t.source.assets?.map((a) => a.token ?? '') ?? tokensOf(p);
      for (const tok of tokens) expect(isRetiredTestToken(tok) || tok === 'tUSD', `${t.name}: ${tok}`).toBe(false);
      expect(templateOffered(t.source)).toBe(true);
    }
  });

  it('puts every note on Robinhood Chain: stock notes on its stock tokens deliver them, collateral pledged there', () => {
    for (const t of SEED_TEMPLATES) {
      const p = t.source.product ?? t.source.basis!;
      expect(p.chain ?? HOME_CHAIN, t.name).toBe('robinhood-testnet');
      expect(isLegacyChainTerms(p), t.name).toBe(false);
      expect(p.collateralChain ?? 'note', t.name).toBe('note');
      if (p.settlement === 'physical')
        for (const u of p.underlyings) expect(deliverableToken({}, u.symbol), `${t.name}: ${u.symbol}`).toBeDefined();
    }
    const stock = SEED_TEMPLATES.filter((t) => t.source.product?.underlyings.some((u) => u.symbol === 'TSLA'));
    expect(stock.map((t) => [t.name, t.source.product!.settlement ?? 'cash'])).toEqual([
      ['12M Worst-of Phoenix on TSLA, AMZN', 'physical'],
      ['12M Reverse Convertible on TSLA', 'physical'],
      ['12M Worst-of Phoenix on TSLA, NVDA', 'cash'],
    ]);
    for (const t of stock) {
      const tokens = tokensOf(t.source.product!);
      expect(tokens).toContain('TSLA');
      expect(tokens.some((x) => x.includes('.'))).toBe(false);
      expect(compileTemplate(t.source).hash.length).toBe(32);
    }
    // Crypto notes settle in cash.
    for (const t of SEED_TEMPLATES) {
      const p = t.source.product ?? t.source.basis!;
      if (p.underlyings.every((u) => FEEDS[u.symbol as keyof typeof FEEDS]?.feedChain === 'ethereum-mainnet'))
        expect(p.settlement ?? 'cash', t.name).toBe('cash');
    }
  });

  it('stops listing saved templates that name a retired test token, a receipt, or no longer validate', () => {
    const oldAapl = {
      product: {
        ...EXAMPLE_PRODUCTS['reverse-convertible'],
        underlyings: [FEEDS.AAPL],
        settlement: 'physical' as const,
      },
    };
    expect(templateOffered(oldAapl)).toBe(false);
    const { bpmnXml, assets } = instantiateProduct(EXAMPLE_WORST_OF);
    expect(templateOffered({ bpmnXml, assets })).toBe(true);
    expect(
      templateOffered({
        bpmnXml,
        assets: assets.map((a) => (a.token === 'USDG' && a.id !== 'cash' ? { ...a, token: 'tETH' } : a)),
      }),
    ).toBe(false);
    expect(RETIRED_TEST_TOKENS).toContain('tTSLA');
    expect(isRetiredTestToken('tTSLA.rh')).toBe(true);
    expect(isRetiredTestToken('tUSD')).toBe(false);
  });
});

describe('term sheets from the earlier Arbitrum build', () => {
  // As saved by the Arbitrum build: the note on Arbitrum, stock collateral locked on Robinhood Chain.
  const arb = {
    ...EXAMPLE_PRODUCTS.phoenix,
    underlyings: [FEEDS.TSLA],
    chain: 'arbitrum-sepolia',
    collateralChain: 'robinhood',
    collateral: [
      { symbol: 'TSLA', haircutPct: 60 },
      { symbol: 'USD', haircutPct: 100 },
    ],
  } as unknown as ProductParams;
  it('reads them but does not issue them as they are', () => {
    expect(isLegacyChainTerms(arb)).toBe(true);
    expect(isLegacyChainTerms(EXAMPLE_PRODUCTS.phoenix)).toBe(false);
    expect(validateProductParams(arb).join(' ')).toMatch(/Notes run on Robinhood Chain testnet only/);
    expect(templateOffered({ product: arb })).toBe(false);
    expect(templateOffered({ product: { ...arb, chain: undefined } })).toBe(false); // remote collateral, not deployed
  });
  it('moves them to Robinhood Chain for the issue forms, collateral pledged locally', () => {
    const moved = toIssuanceTerms(arb);
    expect(moved.chain).toBeUndefined();
    expect(moved.collateralChain).toBeUndefined();
    expect(moved.collateral).toEqual(arb.collateral);
    expect(collateralTokenOf(moved, 'TSLA')).toEqual({ token: 'TSLA', decimals: 18 });
    expect(validateProductParams(moved)).toEqual([]);
    const ok = { ...EXAMPLE_PRODUCTS.phoenix, settlement: 'physical' as const };
    expect(toIssuanceTerms(ok)).toBe(ok); // ETH is delivered as WETH
    const aapl = toIssuanceTerms({ ...rc, underlyings: [FEEDS.AAPL] });
    expect(aapl.settlement).toBe('cash');
    expect(validateProductParams(aapl)).toEqual([]);
  });
  it('hides a stored workflow that moves a receipt of collateral held elsewhere', () => {
    const { bpmnXml, assets } = instantiateProduct(EXAMPLE_PRODUCTS.phoenix);
    expect(templateOffered({ bpmnXml, assets })).toBe(true);
    const withReceipt = assets.map((a) => (a.token === 'USDG' && a.id !== 'cash' ? { ...a, token: 'TSLA.rh' } : a));
    expect(templateOffered({ bpmnXml, assets: withReceipt })).toBe(false);
  });
});

describe('collateral on other chains (planned)', () => {
  it('has no remote collateral configured: every note pledges on Robinhood Chain', () => {
    expect(REMOTE_COLLATERAL).toEqual({});
    expect(isRemoteCollateral({})).toBe(false);
    expect(isRemoteCollateral({ collateralChain: 'note' })).toBe(false);
    expect(isRemoteCollateral({ collateralChain: 'ethereum' })).toBe(true);
    expect(collateralTokenOf({ collateralChain: 'ethereum' }, 'USD')).toBeUndefined();
    expect(collateralTokenOf({}, 'USD')).toEqual(collateralTokenOf({ collateralChain: 'note' }, 'USD'));
  });
});

import { describe, expect, it } from 'vitest';
import {
  CASH_FAUCETS,
  CASH_TOKENS,
  cashTokenOf,
  CHAIN_TOKENS,
  checkCrossChainDeployment,
  collateralChoices,
  collateralSymbolOfAsset,
  collateralTokenOf,
  compileTemplate,
  CRE_CHAIN_NAMES,
  DEFAULT_HAIRCUT,
  definitionId,
  deliverableToken,
  EXAMPLE_PRODUCTS,
  FEEDS,
  GAS_FAUCETS,
  instantiateProduct,
  isNoteChain,
  keeperGateways,
  keeperVaults,
  NOTE_CHAIN_IDS,
  NOTE_CHAINS,
  noteChainOf,
  RECEIPTS,
  receiptChain,
  REMOTE_COLLATERAL,
  remoteCollateralChains,
  remoteCollateralOf,
  templateOffered,
  toChain,
  toIssuanceTerms,
  validateProductParams,
  wirePlan,
  withChain,
  XC_CHAINS,
  type CrossChainDeployment,
  type ProductParams,
} from '../src';

const BASE = 'base-sepolia' as const;
const RH = 'robinhood-testnet' as const;
const cashOf = (p: ProductParams) => instantiateProduct(p).assets.find((a) => a.id === 'cash');

describe('two note chains: Robinhood Chain testnet and Base Sepolia', () => {
  it('knows both, with their chain ids, cash tokens and faucets', () => {
    expect(NOTE_CHAINS).toEqual([RH, BASE]);
    expect(NOTE_CHAIN_IDS).toEqual({ [RH]: 46630, [BASE]: 84532 });
    expect(isNoteChain(BASE)).toBe(true);
    expect(isNoteChain('arbitrum-sepolia')).toBe(false);
    expect(cashTokenOf(RH)).toEqual({ token: 'USDG', decimals: 6 });
    expect(cashTokenOf(BASE)).toEqual({ token: 'USDC', decimals: 6 });
    expect(cashTokenOf({})).toEqual({ token: 'USDG', decimals: 6 });
    expect(cashTokenOf({ chain: BASE })).toEqual({ token: 'USDC', decimals: 6 });
    expect(CASH_TOKENS[BASE]).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(Object.keys(CHAIN_TOKENS[BASE]).sort()).toEqual(['USDC', 'WETH']);
    expect(CHAIN_TOKENS[BASE].WETH.address).toBe('0x4200000000000000000000000000000000000006');
    expect(CASH_FAUCETS[BASE]).toBe('https://faucet.circle.com');
    expect(GAS_FAUCETS[BASE].length).toBeGreaterThan(0);
    expect(collateralSymbolOfAsset('Collateral USDC')).toBe('USD');
    expect(collateralSymbolOfAsset('Collateral USDC.base')).toBe('USD');
    expect(collateralSymbolOfAsset('Collateral WETH.base')).toBe('ETH');
  });

  it('keeps a Robinhood Chain note exactly as before: no chain in its terms, USDG named after itself', () => {
    const p = EXAMPLE_PRODUCTS.phoenix;
    expect(noteChainOf(p)).toBe(RH);
    expect(cashOf(p)).toMatchObject({ name: 'USDG', token: 'USDG', decimals: 6 });
    expect(withChain(p, RH)).not.toHaveProperty('chain');
    expect(withChain({ ...p, chain: BASE }, RH)).not.toHaveProperty('chain');
    expect(withChain(p, BASE).chain).toBe(BASE);
  });

  it('issues a Base note in USDC, delivering WETH; stocks settle in cash there', () => {
    const p: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, chain: BASE, settlement: 'physical' };
    expect(validateProductParams(p)).toEqual([]);
    expect(cashOf(p)).toMatchObject({ name: 'USDC', token: 'USDC', decimals: 6 });
    expect(instantiateProduct(p).assets.find((a) => a.id === 'd_ETH')).toMatchObject({ token: 'WETH', decimals: 18 });
    expect(instantiateProduct(p).description).toContain('subscribe in USDC');
    expect(deliverableToken({ chain: BASE }, 'TSLA')).toBeUndefined();
    const tsla: ProductParams = { ...EXAMPLE_PRODUCTS['reverse-convertible'], chain: BASE, underlyings: [FEEDS.TSLA] };
    expect(validateProductParams(tsla)).toEqual([]);
    expect(validateProductParams({ ...tsla, settlement: 'physical' }).join(' ')).toMatch(
      /no TSLA token to deliver on Base Sepolia/,
    );
    // The same terms on two chains are two definitions.
    const rh = compileTemplate({ product: EXAMPLE_PRODUCTS.phoenix });
    const base = compileTemplate({ product: { ...EXAMPLE_PRODUCTS.phoenix, chain: BASE } });
    expect(definitionId(rh)).not.toBe(definitionId(base));
    expect(templateOffered({ product: { ...EXAMPLE_PRODUCTS.phoenix, chain: BASE } })).toBe(true);
  });

  it('pledges USDC and WETH locally on Base, and refuses stock tokens there', () => {
    expect(collateralChoices({ chain: BASE })).toEqual([
      { symbol: 'USD', token: 'USDC' },
      { symbol: 'ETH', token: 'WETH' },
      { symbol: 'TSLA', token: null },
      { symbol: 'AMZN', token: null },
      { symbol: 'AMD', token: null },
      { symbol: 'PLTR', token: null },
    ]);
    const p: ProductParams = {
      ...EXAMPLE_PRODUCTS.phoenix,
      chain: BASE,
      collateral: [{ symbol: 'TSLA', haircutPct: 60 }],
    };
    expect(validateProductParams(p).join(' ')).toMatch(/no TSLA token to pledge on Base Sepolia: pledge USD \(USDC\)/);
  });
});

describe('collateral locked on the other chain, both directions', () => {
  it('backs a Robinhood Chain note with USDC or WETH locked on Base', () => {
    const p: ProductParams = {
      ...EXAMPLE_PRODUCTS.phoenix,
      collateralChain: BASE,
      collateral: [
        { symbol: 'USD', haircutPct: 100 },
        { symbol: 'ETH', haircutPct: 70 },
      ],
    };
    expect(validateProductParams(p)).toEqual([]);
    expect(collateralTokenOf(p, 'USD')).toEqual({ token: 'USDC.base', decimals: 6 });
    expect(collateralTokenOf(p, 'ETH')).toEqual({ token: 'WETH.base', decimals: 18 });
    expect(collateralTokenOf(p, 'TSLA')).toBeUndefined();
    // Cash stays the note chain's: subscriptions and coupons in USDG on Robinhood Chain.
    expect(cashOf(p)).toMatchObject({ token: 'USDG' });
    const assets = instantiateProduct(p).assets.map((a) => a.token);
    expect(assets).toEqual(expect.arrayContaining(['USDG', 'USDC.base', 'WETH.base']));
    expect(validateProductParams({ ...p, collateral: [{ symbol: 'TSLA', haircutPct: 60 }] }).join(' ')).toMatch(
      /TSLA can't be locked on Base Sepolia for a Robinhood Chain note: lock USD \(USDC\), ETH \(WETH\)/,
    );
  });

  it("backs a Base note with Robinhood's stock tokens locked on Robinhood Chain", () => {
    const p: ProductParams = {
      ...EXAMPLE_PRODUCTS['reverse-convertible'],
      chain: BASE,
      underlyings: [FEEDS.TSLA],
      collateralChain: RH,
      collateral: [
        { symbol: 'TSLA', haircutPct: DEFAULT_HAIRCUT.TSLA },
        { symbol: 'AMZN', haircutPct: DEFAULT_HAIRCUT.AMZN },
        { symbol: 'USD', haircutPct: 100 },
      ],
    };
    expect(validateProductParams(p)).toEqual([]);
    expect(collateralChoices(p)).toEqual([
      { symbol: 'USD', token: 'USDG.rh' },
      { symbol: 'ETH', token: 'WETH.rh' },
      { symbol: 'TSLA', token: 'TSLA.rh' },
      { symbol: 'AMZN', token: 'AMZN.rh' },
      { symbol: 'AMD', token: 'AMD.rh' },
      { symbol: 'PLTR', token: 'PLTR.rh' },
    ]);
    expect(cashOf(p)).toMatchObject({ token: 'USDC' });
    // Valued by the stock's own Chainlink feed, like TSLA pledged on Robinhood Chain.
    expect(JSON.stringify(instantiateProduct(p).bpmnXml)).toContain(FEEDS.TSLA.feed);
    expect(remoteCollateralOf(p)?.TSLA?.locked.address).toBe(CHAIN_TOKENS[RH].TSLA.address);
    // NFLX has no feed: never lockable.
    expect(Object.values(REMOTE_COLLATERAL[BASE][RH]).map((r) => r!.token)).not.toContain('NFLX.rh');
  });

  it('names receipts by where the token is locked, and lists every one', () => {
    expect(receiptChain('TSLA.rh')).toBe(RH);
    expect(receiptChain('USDC.base')).toBe(BASE);
    expect(receiptChain('USDG')).toBeNull();
    expect(receiptChain('TSLA.arb')).toBeNull();
    expect(Object.keys(RECEIPTS).sort()).toEqual(
      ['AMD.rh', 'AMZN.rh', 'PLTR.rh', 'TSLA.rh', 'USDC.base', 'USDG.rh', 'WETH.base', 'WETH.rh'].sort(),
    );
    expect(RECEIPTS['TSLA.rh']).toMatchObject({ home: BASE, asset: RH, symbol: 'TSLA' });
    expect(RECEIPTS['USDC.base']).toMatchObject({ home: RH, asset: BASE, symbol: 'USD' });
    expect(remoteCollateralChains(RH)).toEqual([BASE]);
    expect(remoteCollateralChains(BASE)).toEqual([RH]);
  });

  it('refuses a lock on the note chain itself, or on a chain with no pair', () => {
    const p: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, chain: BASE, collateralChain: BASE };
    expect(validateProductParams(p).join(' ')).toMatch(/runs on Base Sepolia already/);
    expect(validateProductParams({ ...p, collateralChain: 'ethereum-sepolia' }).join(' ')).toMatch(
      /A Base note can't hold collateral on ethereum-sepolia: pledge it into the note, or lock it on Robinhood Chain testnet/,
    );
  });
});

describe('moving terms between chains (the network picker)', () => {
  const rhStock: ProductParams = {
    ...EXAMPLE_PRODUCTS['reverse-convertible'],
    underlyings: [FEEDS.TSLA],
    settlement: 'physical',
    collateral: [
      { symbol: 'TSLA', haircutPct: 60 },
      { symbol: 'USD', haircutPct: 100 },
    ],
  };
  it('to Base: stock delivery settles in cash, stock collateral dropped (or locked on Robinhood Chain)', () => {
    const b = toChain(rhStock, BASE);
    expect(b.chain).toBe(BASE);
    expect(b.settlement).toBe('cash');
    expect(b.collateral).toEqual([{ symbol: 'USD', haircutPct: 100 }]);
    expect(validateProductParams(b)).toEqual([]);
    const locked = toChain({ ...rhStock, collateralChain: RH }, BASE);
    expect(locked.collateralChain).toBe(RH);
    expect(locked.collateral).toEqual(rhStock.collateral);
    expect(validateProductParams(locked)).toEqual([]);
  });
  it('back to Robinhood Chain: a lock on Robinhood Chain becomes a local pledge, chain left out', () => {
    const b = toChain({ ...rhStock, collateralChain: RH }, BASE);
    const r = toChain(b, RH);
    expect(r).not.toHaveProperty('chain');
    expect(r).not.toHaveProperty('collateralChain');
    expect(r.collateral).toEqual(rhStock.collateral);
    expect(validateProductParams({ ...r, settlement: 'physical' })).toEqual([]);
  });
  it('leaves issuable terms alone, on either chain', () => {
    const b: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, chain: BASE };
    expect(toIssuanceTerms(b)).toBe(b);
    const x: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, collateralChain: BASE };
    expect(toIssuanceTerms(x)).toBe(x);
    // A Base note naming Base as its collateral chain: pledged in the note instead.
    expect(toIssuanceTerms({ ...b, collateralChain: BASE })).toEqual(b);
  });
});

describe('cross-chain deployment records', () => {
  const plan = wirePlan(BASE, RH);
  const rec = (home: typeof RH | typeof BASE, asset: typeof RH | typeof BASE): CrossChainDeployment => ({
    home: {
      chain: home,
      chainId: XC_CHAINS[home].chainId,
      selector: XC_CHAINS[home].selector,
      router: XC_CHAINS[home].router,
      engine: '0x00000000000000000000000000000000000e0001',
      gateway: '0x00000000000000000000000000000000000a0001',
      version: 2,
    },
    remotes: [
      {
        chain: asset,
        chainId: XC_CHAINS[asset].chainId,
        selector: XC_CHAINS[asset].selector,
        router: XC_CHAINS[asset].router,
        vault: '0x00000000000000000000000000000000000b0001',
        gasLimit: 300000,
        receipts: Object.fromEntries(
          wirePlan(home, asset).map((w, i) => [
            w.symbol,
            {
              receipt: `0x${(0xc0000 + i).toString(16).padStart(40, '0')}`,
              token: w.token,
              decimals: w.decimals,
              valuedAs: w.valuedAs,
            },
          ]),
        ),
      },
    ],
  });

  it('plans the wire step from REMOTE_COLLATERAL: what each vault allows and each gateway registers', () => {
    expect(plan.map((w) => w.symbol)).toEqual(['USDG.rh', 'WETH.rh', 'TSLA.rh', 'AMZN.rh', 'AMD.rh', 'PLTR.rh']);
    expect(plan.find((w) => w.symbol === 'TSLA.rh')).toEqual({
      symbol: 'TSLA.rh',
      token: CHAIN_TOKENS[RH].TSLA.address,
      decimals: 18,
      valuedAs: 'TSLA',
    });
    expect(wirePlan(RH, BASE)).toEqual([
      { symbol: 'USDC.base', token: CHAIN_TOKENS[BASE].USDC.address, decimals: 6, valuedAs: 'USD' },
      { symbol: 'WETH.base', token: CHAIN_TOKENS[BASE].WETH.address, decimals: 18, valuedAs: 'ETH' },
    ]);
    expect(() => wirePlan(RH, RH)).toThrow(/no cross-chain collateral/);
  });

  it('accepts a record that matches the directory and the plan, and says what is off otherwise', () => {
    expect(checkCrossChainDeployment(rec(RH, BASE))).toEqual([]);
    expect(checkCrossChainDeployment(rec(BASE, RH))).toEqual([]);
    const bad = rec(BASE, RH);
    bad.home.selector = '1';
    delete bad.remotes[0].receipts['PLTR.rh'];
    bad.remotes[0].receipts['TSLA.rh'].decimals = 6;
    const e = checkCrossChainDeployment(bad).join(' | ');
    expect(e).toMatch(/home selector 1/);
    expect(e).toMatch(/receipts .* != /);
    expect(e).toMatch(/TSLA.rh decimals 6 != 18/);
    expect(checkCrossChainDeployment({ ...rec(RH, BASE), home: { ...rec(RH, BASE).home, chain: 'x' } })).toEqual([
      'home chain x is not a note chain',
    ]);
  });

  it('gives the keeper one flush gateway per home chain and a vault check per receipt, by CRE chain name', () => {
    expect(CRE_CHAIN_NAMES).toEqual({ [RH]: 'robinhood-testnet', [BASE]: 'ethereum-testnet-sepolia-base-1' });
    const xs = [rec(RH, BASE), rec(BASE, RH)];
    expect(xs.flatMap((x) => keeperGateways(x, CRE_CHAIN_NAMES)).map((g) => g.chainSelectorName)).toEqual([
      'robinhood-testnet',
      'ethereum-testnet-sepolia-base-1',
    ]);
    const v = keeperVaults(xs, CRE_CHAIN_NAMES, { stateBlock: 'latest' });
    expect(v).toHaveLength(2 + 6);
    expect(v.find((w) => w.label === 'TSLA.rh')).toMatchObject({
      homeChain: 'ethereum-testnet-sepolia-base-1',
      assetChain: 'robinhood-testnet',
      token: CHAIN_TOKENS[RH].TSLA.address,
      stateBlock: 'latest',
    });
    expect(v.find((w) => w.label === 'USDC.base')).toMatchObject({
      homeChain: 'robinhood-testnet',
      assetChain: 'ethereum-testnet-sepolia-base-1',
    });
  });

  it('knows each chain as CCIP and CRE do', () => {
    expect(XC_CHAINS[BASE]).toMatchObject({
      chainId: 84532,
      selector: '10344971235874465080',
      router: '0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93',
      creName: 'ethereum-testnet-sepolia-base-1',
    });
    expect(XC_CHAINS[RH]).toMatchObject({ chainId: 46630, selector: '2032988798112970440' });
  });
});

import { describe, expect, it } from 'vitest';
import { EXAMPLE_PRODUCTS, FEEDS, type ProductParams } from '@sn/core';
import type { NoteView } from '@sn/sdk';
import { collateralPhrase } from '../components/Listing';
import { parseAsset } from '../components/AssetIcon';
import { cashSymbol, prepareConfig } from './chains';
import { chainName, crossChainLeg, crossChainLegs, heldOnChoices, issueChains } from './engines';
import { lockedAssetWhere, lockedOn } from './format';
import { FIXTURE, multichainConfig } from './multichain.fixture';

const RH = 'robinhood-testnet';
const BASE = 'base-sepolia';
const config = prepareConfig(multichainConfig());

describe('two note chains', () => {
  it('serves Robinhood Chain first, each with its own cash token', () => {
    expect(issueChains({ ...config, chains: [...config.chains].reverse() }).map((c) => c.key)).toEqual([RH, BASE]);
    const [rh, base] = config.chains;
    expect(rh.stablecoin).toMatchObject({ symbol: 'USDG', address: '0x7E955252E15c84f5768B83c41a71F9eba181802F' });
    expect(base.stablecoin).toMatchObject({ symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' });
    expect(base.tokens.WETH).toBe('0x4200000000000000000000000000000000000006');
    expect(cashSymbol(base, base.stablecoin.address.toLowerCase())).toBe('USDC');
    expect(cashSymbol(undefined)).toBe('USDG');
    expect(chainName(config, BASE)).toBe('Base Sepolia');
    expect(chainName(config, BASE, true)).toBe('Base');
    expect(chainName(null, RH, true)).toBe('Robinhood Chain');
  });

  it('keeps a Base deployment that names USDC as cash labelled USDC', () => {
    const c = prepareConfig({ chains: [{ ...multichainConfig().chains[1], stablecoin: undefined }] } as never);
    expect(c.chains[0].stablecoin.symbol).toBe('USDC');
  });
});

describe('cross-chain pairs, both directions', () => {
  it('finds each home chain’s pair, and every pair for the portfolio', () => {
    const toBase = crossChainLeg(config, RH, BASE)!;
    expect(toBase.home.key).toBe(RH);
    expect(toBase.asset.key).toBe(BASE);
    expect(toBase.gateway).toBe(FIXTURE[RH].gateway);
    expect(toBase.vault).toBe(FIXTURE[BASE].vault);
    expect(Object.keys(toBase.receipts)).toEqual(['USDC.base', 'WETH.base']);
    const toRh = crossChainLeg(config, BASE)!;
    expect(toRh.asset.key).toBe(RH);
    expect(Object.keys(toRh.receipts)).toEqual(['USDG.rh', 'WETH.rh', 'TSLA.rh', 'AMZN.rh', 'AMD.rh', 'PLTR.rh']);
    expect(crossChainLeg(config, BASE, BASE)).toBeNull();
    expect(crossChainLegs(config).map((l) => `${l.home.key}>${l.asset.key}`)).toEqual([
      `${RH}>${BASE}`,
      `${BASE}>${RH}`,
    ]);
    // A chain this deployment does not serve has no pair.
    const rhOnly = { ...config, chains: [config.chains[0]] };
    expect(crossChainLeg(rhOnly, RH, BASE)).toBeNull();
    expect(crossChainLegs(rhOnly)).toEqual([]);
  });

  it('offers "held on" the other chain only when its pair is served', () => {
    expect(heldOnChoices(config, BASE)).toEqual([
      { key: 'note', label: 'Base', live: true },
      { key: RH, label: 'Robinhood Chain', live: true },
    ]);
    expect(heldOnChoices(config, RH)).toEqual([
      { key: 'note', label: 'Robinhood Chain', live: true },
      { key: BASE, label: 'Base', live: true },
    ]);
    const noXc = { ...config, chains: config.chains.map((c) => ({ ...c, crossChain: null })) };
    expect(heldOnChoices(noXc, BASE)).toEqual([
      { key: 'note', label: 'Base', live: true },
      { key: RH, label: 'Robinhood Chain', live: false },
    ]);
    expect(heldOnChoices(config, 'local')).toEqual([{ key: 'note', label: 'local', live: true }]);
  });

  it('labels receipts by where the token is locked', () => {
    expect(lockedOn('TSLA.rh')).toBe('Robinhood Chain');
    expect(lockedOn('USDC.base')).toBe('Base');
    expect(lockedOn('USDC.eth')).toBe('another chain');
    expect(lockedAssetWhere('TSLA.rh')).toBe('TSLA on Robinhood Chain');
    expect(lockedAssetWhere('WETH.base')).toBe('WETH on Base');
    expect(lockedAssetWhere('USDG')).toBe('USDG');
    expect(parseAsset('TSLA.rh')).toEqual({ base: 'TSLA', test: false, remote: 'rh' });
    expect(parseAsset('USDC')).toEqual({ base: 'USDC', test: false, remote: null });
  });

  it('says where a listed note’s collateral is locked', () => {
    const p: ProductParams = {
      ...EXAMPLE_PRODUCTS['reverse-convertible'],
      chain: BASE,
      underlyings: [FEEDS.TSLA],
      collateralChain: RH,
      collateral: [{ symbol: 'TSLA', haircutPct: 60 }],
      collateralRatioPct: 100,
    };
    const view = { params: p, economics: null } as unknown as NoteView;
    expect(collateralPhrase(view, 'USDC')).toBe('Backed by 100% collateral (TSLA locked on Robinhood Chain)');
    const local = {
      params: { ...p, chain: BASE, collateralChain: undefined, collateral: [{ symbol: 'USD', haircutPct: 100 }] },
      economics: null,
    } as unknown as NoteView;
    expect(collateralPhrase(local, 'USDC')).toBe('Backed by 100% collateral (USDC)');
  });
});

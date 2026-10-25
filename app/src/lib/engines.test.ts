import { describe, expect, it } from 'vitest';
import type { AppConfig, ChainConfig } from './api';
import {
  engineOf,
  entryFor,
  issueChains,
  legacyConfig,
  marketplaceNotes,
  onRobinhoodChain,
  type ByKey,
  type EngineEntry,
} from './engines';

const V3 = '0xaf8425a4b2d8994796e019d9b42cd99d40297e10';
const V4 = '0x7d36da43724b09bb03ed98a4574685070073020b';
const cfg = {
  key: 'arbitrum-sepolia',
  family: 'evm',
  name: 'Arbitrum Sepolia',
  chainId: 421614,
  testnet: true,
  cre: true,
  rpc: 'https://rpc',
  engine: V4,
  lens: '0x7ee0f15f5df7773c702c38d9d227466386974734',
  fromBlock: 322330366,
  stablecoin: { symbol: 'USDG', address: '0xFFC95faa3d63Cde504a05B567C600B78C0b41892', decimals: 6 },
  faucet: false,
  tokenFaucet: null,
  tokens: {
    'USDG.rh': '0x00000000000000000000000000000000000000a4',
    tTSLA: '0x00000000000000000000000000000000000000b1',
  },
  crossChain: {
    role: 'home',
    router: '0x0000000000000000000000000000000000000001',
    selector: '1',
    gateway: '0x00000000000000000000000000000000000000c4',
  },
  legacyEngines: [
    {
      engine: V3,
      lens: '0x7544378876d780e69968cd67c3fef9a294c23a0b',
      fromBlock: 322211118,
      version: 3,
      tokens: { 'USDG.rh': '0x00000000000000000000000000000000000000a3' },
      crossChain: {
        role: 'home',
        router: '0x0000000000000000000000000000000000000001',
        selector: '1',
        gateway: '0x00000000000000000000000000000000000000c3',
      },
    },
  ],
} as ChainConfig;
const config: AppConfig = { chains: [cfg], ai: false };

describe('engines per chain', () => {
  it('tells a v3 note (same id as before) from a v4 one, and refuses unknown engines', () => {
    expect(engineOf(config, `arbitrum-sepolia:${V3}:2`)).toEqual({ legacy: true, version: 3 });
    expect(engineOf(config, `arbitrum-sepolia:${V4}:2`)).toEqual({ legacy: false, version: 4 });
    expect(engineOf(config, 'arbitrum-sepolia:0x0000000000000000000000000000000000000bad:1')).toBeNull();
    expect(engineOf(config, `robinhood-testnet:${V3}:1`)).toBeNull();
  });

  it('gives a v3 note its own engine, lens, receipts and gateway', () => {
    const l = legacyConfig(cfg, cfg.legacyEngines![0]);
    expect(l).toMatchObject({
      engine: V3,
      lens: '0x7544378876d780e69968cd67c3fef9a294c23a0b',
      fromBlock: 322211118,
      legacyEngines: [],
    });
    expect(l.tokens).toEqual({
      'USDG.rh': '0x00000000000000000000000000000000000000a3',
      tTSLA: '0x00000000000000000000000000000000000000b1',
    });
    expect(l.crossChain?.gateway).toBe('0x00000000000000000000000000000000000000c3');
    expect(l.stablecoin).toEqual(cfg.stablecoin);
  });

  it("picks the adapter entry that runs a note, never another engine's", () => {
    const cur = { cfg, legacy: false, version: 4 } as unknown as EngineEntry;
    const old = { cfg: legacyConfig(cfg, cfg.legacyEngines![0]), legacy: true, version: 3 } as unknown as EngineEntry;
    const byKey: ByKey = { 'arbitrum-sepolia': { ...cur, engines: { [V4]: cur, [V3]: old } } };
    expect(entryFor(byKey, { id: `arbitrum-sepolia:${V3}:2` })).toBe(old);
    expect(entryFor(byKey, { chain: 'arbitrum-sepolia', engine: V3.toUpperCase().replace('0X', '0x') })).toBe(old);
    expect(entryFor(byKey, { chain: 'arbitrum-sepolia', id: `arbitrum-sepolia:${V4}:2` })).toBe(cur);
    expect(entryFor(byKey, { id: 'arbitrum-sepolia:0x0000000000000000000000000000000000000bad:1' })).toBeUndefined();
    expect(entryFor(byKey, { chain: 'arbitrum-sepolia' })?.legacy).toBe(false);
    expect(entryFor(byKey, { chain: 'robinhood-testnet', engine: V4 })).toBeUndefined();
  });
});

describe('Robinhood Chain: a collateral chain, its notes legacy', () => {
  const RH_V4 = '0xf1a1Fa45770582d1EeBC173d9076E95f9cFA0244';
  const RH_V3 = '0xCbF6eeC598b8f3b4a4082f5583Db6bD6f488b22D';
  it('tells notes issued on Robinhood Chain by chain or engine', () => {
    expect(onRobinhoodChain({ id: `robinhood-testnet:${RH_V4.toLowerCase()}:3` })).toBe(true);
    expect(onRobinhoodChain({ id: `robinhood-testnet:${RH_V3.toLowerCase()}:1` })).toBe(true);
    expect(onRobinhoodChain({ chain: 'somewhere', engine: RH_V4 })).toBe(true);
    expect(onRobinhoodChain({ id: `arbitrum-sepolia:${V4}:2` })).toBe(false);
    expect(onRobinhoodChain({ chain: 'local', engine: V4 })).toBe(false);
  });
  it('lists no Robinhood Chain note in the marketplace (nor as open now)', () => {
    const notes = [
      { id: `arbitrum-sepolia:${V4}:2`, chain: 'arbitrum-sepolia' },
      { id: `robinhood-testnet:${RH_V4.toLowerCase()}:3`, chain: 'robinhood-testnet' },
      { id: `robinhood-testnet:${RH_V3.toLowerCase()}:1`, chain: 'robinhood-testnet' },
      { id: `arbitrum-sepolia:${V3}:5`, chain: 'arbitrum-sepolia' },
    ];
    expect(marketplaceNotes(notes).map((n) => n.id)).toEqual([`arbitrum-sepolia:${V4}:2`, `arbitrum-sepolia:${V3}:5`]);
  });
  it('issues only on chains other than Robinhood Chain', () => {
    const rh = { ...cfg, key: 'robinhood-testnet', name: 'Robinhood Chain testnet' } as ChainConfig;
    expect(issueChains({ chains: [rh, cfg], ai: false }).map((c) => c.key)).toEqual(['arbitrum-sepolia']);
    expect(issueChains({ chains: [{ ...cfg, key: 'local' }], ai: false }).map((c) => c.key)).toEqual(['local']);
  });
});

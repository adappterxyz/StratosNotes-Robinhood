import { describe, expect, it } from 'vitest';
import type { AppConfig, ChainConfig } from './api';
import { engineOf, entryFor, issueChains, legacyConfig, type ByKey, type EngineEntry } from './engines';

// Synthetic engines: the mechanism serves an earlier engine next to the current one (none is deployed today).
const V3 = '0x00000000000000000000000000000000000e0003';
const V4 = '0x00000000000000000000000000000000000e0004';
const cfg = {
  key: 'robinhood-testnet',
  family: 'evm',
  name: 'Robinhood Chain testnet',
  chainId: 46630,
  testnet: true,
  cre: true,
  rpc: 'https://rpc',
  engine: V4,
  lens: '0x00000000000000000000000000000000000f0004',
  fromBlock: 141825174,
  stablecoin: { symbol: 'USDG', address: '0x7E955252E15c84f5768B83c41a71F9eba181802F', decimals: 6 },
  faucet: false,
  tokenFaucet: null,
  tokens: {
    'USDC.eth': '0x00000000000000000000000000000000000000a4',
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
      lens: '0x00000000000000000000000000000000000f0003',
      fromBlock: 141588428,
      version: 3,
      tokens: { 'USDC.eth': '0x00000000000000000000000000000000000000a3' },
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
    expect(engineOf(config, `robinhood-testnet:${V3}:2`)).toEqual({ legacy: true, version: 3 });
    expect(engineOf(config, `robinhood-testnet:${V4}:2`)).toEqual({ legacy: false, version: 4 });
    expect(engineOf(config, 'robinhood-testnet:0x0000000000000000000000000000000000000bad:1')).toBeNull();
    expect(engineOf(config, `other-chain:${V3}:1`)).toBeNull();
  });

  it('gives a v3 note its own engine, lens, receipts and gateway', () => {
    const l = legacyConfig(cfg, cfg.legacyEngines![0]);
    expect(l).toMatchObject({
      engine: V3,
      lens: '0x00000000000000000000000000000000000f0003',
      fromBlock: 141588428,
      legacyEngines: [],
    });
    expect(l.tokens).toEqual({
      'USDC.eth': '0x00000000000000000000000000000000000000a3',
      tTSLA: '0x00000000000000000000000000000000000000b1',
    });
    expect(l.crossChain?.gateway).toBe('0x00000000000000000000000000000000000000c3');
    expect(l.stablecoin).toEqual(cfg.stablecoin);
  });

  it("picks the adapter entry that runs a note, never another engine's", () => {
    const cur = { cfg, legacy: false, version: 4 } as unknown as EngineEntry;
    const old = { cfg: legacyConfig(cfg, cfg.legacyEngines![0]), legacy: true, version: 3 } as unknown as EngineEntry;
    const byKey: ByKey = { 'robinhood-testnet': { ...cur, engines: { [V4]: cur, [V3]: old } } };
    expect(entryFor(byKey, { id: `robinhood-testnet:${V3}:2` })).toBe(old);
    expect(entryFor(byKey, { chain: 'robinhood-testnet', engine: V3.toUpperCase().replace('0X', '0x') })).toBe(old);
    expect(entryFor(byKey, { chain: 'robinhood-testnet', id: `robinhood-testnet:${V4}:2` })).toBe(cur);
    expect(entryFor(byKey, { id: 'robinhood-testnet:0x0000000000000000000000000000000000000bad:1' })).toBeUndefined();
    expect(entryFor(byKey, { chain: 'robinhood-testnet' })?.legacy).toBe(false);
    expect(entryFor(byKey, { chain: 'other-chain', engine: V4 })).toBeUndefined();
  });
});

describe('Robinhood Chain: the only note chain', () => {
  it('issues on every chain the deployment serves', () => {
    expect(issueChains(config).map((c) => c.key)).toEqual(['robinhood-testnet']);
    expect(issueChains({ chains: [{ ...cfg, key: 'local' }], ai: false }).map((c) => c.key)).toEqual(['local']);
    expect(issueChains({ chains: [], ai: false })).toEqual([]);
  });
});

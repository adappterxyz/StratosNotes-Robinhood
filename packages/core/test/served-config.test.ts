import { describe, expect, it } from 'vitest';
import { CHAIN_TOKENS, wirePlan, XC_CHAINS, type CrossChainDeployment, type NoteChain } from '../src';
import {
  creGateways,
  creNameOf,
  creVaults,
  pickCrossChain,
  realTokens,
  receiptsOn,
  servedChains,
  servedCrossChain,
  servedStablecoin,
} from '../src/served-config';

const RH = 'robinhood-testnet' as const;
const BASE = 'base-sepolia' as const;
const hex = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

/** A deployment record for the pair (home, asset), as scripts/deploy-crosschain.sh writes it. */
const pair = (home: NoteChain, asset: NoteChain, seed: number): CrossChainDeployment => ({
  home: {
    chain: home,
    chainId: XC_CHAINS[home].chainId,
    selector: XC_CHAINS[home].selector,
    router: XC_CHAINS[home].router,
    engine: hex(seed + 1),
    gateway: hex(seed + 2),
    gatewayBlock: 100,
    version: 2,
    feePoolWei: '5000000000000000',
  },
  remotes: [
    {
      chain: asset,
      chainId: XC_CHAINS[asset].chainId,
      selector: XC_CHAINS[asset].selector,
      router: XC_CHAINS[asset].router,
      vault: hex(seed + 3),
      vaultBlock: 200,
      gasLimit: 300000,
      receipts: Object.fromEntries(
        wirePlan(home, asset).map((w, i) => [
          w.symbol,
          { receipt: hex(seed + 10 + i), token: w.token, decimals: w.decimals, valuedAs: w.valuedAs },
        ]),
      ),
    },
  ],
});
const rhHome = pair(RH, BASE, 0x1000);
const baseHome = pair(BASE, RH, 0x2000);

describe('served config: both note chains', () => {
  it('lists Robinhood Chain testnet and Base Sepolia with their RPCs and indexer depth', () => {
    const [rh, base] = servedChains({});
    expect(rh).toMatchObject({
      key: RH,
      chainId: 46630,
      rpc: 'https://rpc.testnet.chain.robinhood.com',
      indexer: { confirmations: 120, maxRange: 20000 },
    });
    expect(base).toMatchObject({ key: BASE, chainId: 84532, indexer: { confirmations: 30, maxRange: 5000 } });
    // sepolia.base.org caps eth_getLogs at 200 blocks: the served RPC is one that scans wider ranges.
    expect(base.rpc).not.toBe('https://sepolia.base.org');
    expect(servedChains({ RPC_BASE_SEPOLIA: 'https://x.example' })[1].rpc).toBe('https://x.example');
  });

  it('serves USDG on Robinhood Chain and USDC on Base, with each chain real tokens', () => {
    expect(servedStablecoin(RH)).toEqual({ symbol: 'USDG', address: CHAIN_TOKENS[RH].USDG.address, decimals: 6 });
    expect(servedStablecoin(BASE)).toEqual({ symbol: 'USDC', address: CHAIN_TOKENS[BASE].USDC.address, decimals: 6 });
    expect(Object.keys(realTokens(BASE)).sort()).toEqual(['USDC', 'WETH']);
    expect(realTokens('local')).toEqual({});
  });
});

describe('served config: cross-chain pairs, both directions', () => {
  it('serves each home chain its gateway, the vault on the other chain and its receipts as tokens', () => {
    const { xs, warnings } = pickCrossChain([
      { file: 'deployments/crosschain/base-sepolia.json', data: baseHome },
      { file: 'deployments/crosschain/robinhood-testnet.json', data: rhHome },
    ]);
    expect(warnings).toEqual([]);
    const b = servedCrossChain(xs, BASE)!;
    expect(b).toMatchObject({ role: 'home', gateway: baseHome.home.gateway, selector: XC_CHAINS[BASE].selector });
    expect(b.remotes).toHaveLength(1);
    expect(b.remotes[0]).toMatchObject({
      chain: RH,
      vault: baseHome.remotes[0].vault,
      selector: XC_CHAINS[RH].selector,
    });
    expect(Object.keys(b.remotes[0].receipts).sort()).toEqual(
      ['AMD.rh', 'AMZN.rh', 'PLTR.rh', 'TSLA.rh', 'USDG.rh', 'WETH.rh'].sort(),
    );
    expect(b.remotes[0].receipts['TSLA.rh'].token).toBe(CHAIN_TOKENS[RH].TSLA.address);
    expect(receiptsOn(xs, BASE)['TSLA.rh']).toBe(baseHome.remotes[0].receipts['TSLA.rh'].receipt);
    const r = servedCrossChain(xs, RH)!;
    expect(r.remotes[0].chain).toBe(BASE);
    expect(Object.keys(receiptsOn(xs, RH)).sort()).toEqual(['USDC.base', 'WETH.base']);
    expect(servedCrossChain(xs, 'local')).toBeNull();
    expect(receiptsOn([], RH)).toEqual({});
  });

  it('skips an invalid record and a second record for the same home, with a warning', () => {
    const bad = pair(BASE, RH, 0x3000);
    bad.remotes[0].selector = '1';
    const { xs, warnings } = pickCrossChain([
      { file: 'a.json', data: bad },
      { file: 'b.json', data: rhHome },
      { file: 'deployments/crosschain-testnet.json', data: pair(RH, BASE, 0x4000) },
    ]);
    expect(xs).toEqual([rhHome]);
    expect(warnings[0]).toMatch(/^a\.json: skipped \(.*selector 1/);
    expect(warnings[1]).toMatch(
      /crosschain-testnet\.json: skipped \(another record already serves home robinhood-testnet\)/,
    );
  });

  it('gives the CRE keeper a flush gateway per home chain and a backing check per receipt', () => {
    const xs = [rhHome, baseHome];
    expect(creGateways(xs)).toEqual([
      {
        chainSelectorName: 'robinhood-testnet',
        gateway: rhHome.home.gateway,
        maxItems: 10,
        baseGas: '250000',
        gasPerItem: '300000',
        stateBlock: 'latest',
      },
      {
        chainSelectorName: 'ethereum-testnet-sepolia-base-1',
        gateway: baseHome.home.gateway,
        maxItems: 10,
        baseGas: '250000',
        gasPerItem: '300000',
        stateBlock: 'latest',
      },
    ]);
    // A v1 gateway (no queue) is never flushed.
    expect(creGateways([{ ...rhHome, home: { ...rhHome.home, version: 1 } }])).toEqual([]);
    const v = creVaults(xs);
    expect(v).toHaveLength(8);
    expect(v.every((w) => w.stateBlock === 'latest')).toBe(true);
    expect(v.filter((w) => w.homeChain === 'ethereum-testnet-sepolia-base-1').map((w) => w.assetChain)).toEqual(
      Array(6).fill('robinhood-testnet'),
    );
    expect(v.find((w) => w.label === 'USDC.base')).toMatchObject({
      homeChain: 'robinhood-testnet',
      assetChain: 'ethereum-testnet-sepolia-base-1',
      vault: rhHome.remotes[0].vault,
      token: CHAIN_TOKENS[BASE].USDC.address,
    });
    expect(creNameOf(BASE)).toBe('ethereum-testnet-sepolia-base-1');
    expect(() => creNameOf('arbitrum-sepolia')).toThrow(/no CRE chain name/);
  });
});

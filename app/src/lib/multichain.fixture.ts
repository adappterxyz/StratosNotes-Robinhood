/**
 * A served config (/api/config) for both note chains with cross-chain collateral wired both ways, as
 * scripts/server-config.ts writes it once both engines and both gateway–vault pairs are deployed. Every address is
 * synthetic (nothing here is deployed): used by the app's unit tests and the multichain e2e smoke
 * (scripts/e2e/multichain.e2e.ts), which serves it in place of the API.
 */
import { CASH_TOKENS, EXTERNAL_TOKENS, wirePlan, XC_CHAINS, type NoteChain } from '@sn/core';
import type { AppConfig, ChainConfig, CrossChainReceipt } from './api';

const hex = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;

/** Synthetic addresses: engine e, lens f, gateway a, vault b, receipts c, per chain (1 Robinhood Chain, 2 Base). */
export const FIXTURE = {
  'robinhood-testnet': { engine: hex(0xe1), lens: hex(0xf1), gateway: hex(0xa1), vault: hex(0xb1), receipt: 0xc100 },
  'base-sepolia': { engine: hex(0xe2), lens: hex(0xf2), gateway: hex(0xa2), vault: hex(0xb2), receipt: 0xc200 },
} as const;

const NAMES: Record<NoteChain, string> = {
  'robinhood-testnet': 'Robinhood Chain testnet',
  'base-sepolia': 'Base Sepolia',
};
const CASH: Record<NoteChain, string> = { 'robinhood-testnet': 'USDG', 'base-sepolia': 'USDC' };

/** The receipts the gateway on `home` mints for tokens locked on `asset` (core's wirePlan), at synthetic addresses. */
function receipts(home: NoteChain, asset: NoteChain): Record<string, CrossChainReceipt> {
  return Object.fromEntries(
    wirePlan(home, asset).map((w, i) => [
      w.symbol,
      { receipt: hex(FIXTURE[home].receipt + i), token: w.token, decimals: w.decimals, valuedAs: w.valuedAs },
    ]),
  );
}

function chain(key: NoteChain, other: NoteChain, rpc: string): ChainConfig {
  const r = receipts(key, other);
  return {
    key,
    family: 'evm',
    name: NAMES[key],
    chainId: XC_CHAINS[key].chainId,
    testnet: true,
    cre: true,
    explorer: XC_CHAINS[key].explorer,
    rpc,
    engine: FIXTURE[key].engine,
    lens: FIXTURE[key].lens,
    fromBlock: 1,
    stablecoin: { symbol: CASH[key], address: CASH_TOKENS[key], decimals: 6 },
    faucet: false,
    tokenFaucet: null,
    tokens: {
      ...(EXTERNAL_TOKENS[key] as Record<string, `0x${string}`>),
      ...Object.fromEntries(Object.entries(r).map(([s, x]) => [s, x.receipt])),
    },
    crossChain: {
      role: 'home',
      router: XC_CHAINS[key].router,
      selector: XC_CHAINS[key].selector,
      gateway: FIXTURE[key].gateway,
      remotes: [{ chain: other, selector: XC_CHAINS[other].selector, vault: FIXTURE[other].vault, receipts: r }],
    },
    legacyEngines: [],
    previousCrossChain: [],
  };
}

/** Both chains, both pairs. `rpc` overrides the RPCs (the e2e points them at a closed local port: no chain reads). */
export function multichainConfig(rpc: Partial<Record<NoteChain, string>> = {}): AppConfig {
  return {
    ai: false,
    chains: [
      chain('robinhood-testnet', 'base-sepolia', rpc['robinhood-testnet'] ?? XC_CHAINS['robinhood-testnet'].rpc),
      chain('base-sepolia', 'robinhood-testnet', rpc['base-sepolia'] ?? XC_CHAINS['base-sepolia'].rpc),
    ],
  };
}

/**
 * The pure parts of the generated configs (scripts/server-config.ts, scripts/cre-config.ts) for the two note chains,
 * Robinhood Chain testnet and Base Sepolia, and the cross-chain pairs between them (one deployments/crosschain/<home>.json
 * per home chain, CrossChainDeployment). No file access here: the scripts read the files and pass the records in, so
 * the shapes the API serves and the keeper reads are unit-tested (test/served-config.test.ts).
 */
import {
  checkCrossChainDeployment,
  CRE_CHAIN_NAMES,
  keeperGateways,
  keeperVaults,
  XC_CHAINS,
  type CrossChainDeployment,
  type KeeperGateway,
} from './crosschain';
import {
  CHAIN_CASH,
  CHAIN_TOKENS,
  isNoteChain,
  isRetiredTestToken,
  NOTE_CHAINS,
  type NoteChain,
} from './products/params';

/** A note chain as the generators see it: key, chain id, the public RPC served to the app and the indexer. */
export interface ServedChain {
  key: NoteChain;
  chainId: number;
  rpc: string;
  /** Indexer settings (services/indexer, the Worker's cron). */
  indexer: { confirmations: number; maxRange: number; pollMs: number };
}

/**
 * Both note chains. RPCs: Robinhood Chain's own; on Base Sepolia, publicnode's (base-sepolia-rpc.publicnode.com),
 * because sepolia.base.org limits eth_getLogs to 200 blocks (checked 2026-11-06) and the indexer and the app's
 * history reads scan wider ranges; publicnode answered 20,000-block ranges. `env` overrides each (RPC_ROBINHOOD_TESTNET,
 * RPC_BASE_SEPOLIA).
 *
 * Indexer depth: Robinhood Chain testnet (an Arbitrum Orbit chain) makes several blocks a second with few logs:
 * 'finalized' would lag ~L1 finality, so 120 confirmations; 20,000-block ranges keep it at the head. Base Sepolia (OP
 * Stack) makes a block every 2 s and its 'finalized' head lags ~1–3 hours (L1 batches), so it is read 30 blocks (one
 * minute) behind the head instead (unsafe-head reorgs are rare and the read model re-reads state); 5,000-block ranges.
 */
export function servedChains(env: Record<string, string | undefined> = {}): ServedChain[] {
  return [
    {
      key: 'robinhood-testnet',
      chainId: XC_CHAINS['robinhood-testnet'].chainId,
      rpc: env.RPC_ROBINHOOD_TESTNET ?? XC_CHAINS['robinhood-testnet'].rpc,
      indexer: { confirmations: 120, maxRange: 20000, pollMs: 2000 },
    },
    {
      key: 'base-sepolia',
      chainId: XC_CHAINS['base-sepolia'].chainId,
      rpc: env.RPC_BASE_SEPOLIA ?? 'https://base-sepolia-rpc.publicnode.com',
      indexer: { confirmations: 30, maxRange: 5000, pollMs: 2000 },
    },
  ];
}

/** The chain's stablecoin as the API serves it: USDG on Robinhood Chain, USDC on Base. */
export function servedStablecoin(key: NoteChain) {
  const c = CHAIN_CASH[key];
  return { symbol: c.token, address: CHAIN_TOKENS[key][c.token].address, decimals: c.decimals };
}

/** The chain's real tokens by symbol (CHAIN_TOKENS: USDG/USDC, WETH, Robinhood's stock tokens). */
export const realTokens = (key: string): Record<string, string> =>
  isNoteChain(key) ? Object.fromEntries(Object.values(CHAIN_TOKENS[key]).map((t) => [t.token, t.address])) : {};

/** Receipts of retired test tokens (tTSLA.rh…) are never served. */
const liveReceipts = (r: CrossChainDeployment['remotes'][number]['receipts']) =>
  Object.fromEntries(Object.entries(r).filter(([sym]) => !isRetiredTestToken(sym)));

/**
 * The cross-chain records to use: every valid one, at most one per home chain. `records` come in priority order
 * (deployments/crosschain/<home>.json first, the legacy deployments/crosschain-testnet.json last); an invalid record
 * (checkCrossChainDeployment) or a second one for a home already taken is skipped with a warning.
 */
export function pickCrossChain(records: ReadonlyArray<{ file: string; data: CrossChainDeployment }>): {
  xs: CrossChainDeployment[];
  warnings: string[];
} {
  const xs: CrossChainDeployment[] = [];
  const warnings: string[] = [];
  for (const { file, data } of records) {
    const errs = checkCrossChainDeployment(data);
    if (errs.length) {
      warnings.push(`${file}: skipped (${errs.join('; ')})`);
      continue;
    }
    if (xs.some((x) => x.home.chain === data.home.chain)) {
      warnings.push(`${file}: skipped (another record already serves home ${data.home.chain})`);
      continue;
    }
    xs.push(data);
  }
  return { xs, warnings };
}

/** Receipt addresses by symbol on the home chain `key` (served in its `tokens`). */
export function receiptsOn(xs: readonly CrossChainDeployment[], key: string): Record<string, string> {
  const x = xs.find((r) => r.home.chain === key);
  return x
    ? Object.fromEntries(
        x.remotes.flatMap((r) => Object.entries(liveReceipts(r.receipts)).map(([sym, v]) => [sym, v.receipt])),
      )
    : {};
}

/** What the app gets as `crossChain` for chain `key`: its home gateway and the vaults behind it (null: none). */
export function servedCrossChain(xs: readonly CrossChainDeployment[], key: string) {
  const x = xs.find((r) => r.home.chain === key);
  if (!x) return null;
  return {
    role: 'home' as const,
    gateway: x.home.gateway,
    router: x.home.router,
    selector: x.home.selector,
    remotes: x.remotes.map((r) => ({
      chain: r.chain,
      selector: r.selector,
      vault: r.vault,
      receipts: liveReceipts(r.receipts),
    })),
  };
}

/** The keeper's flush gateways: one per home chain with an auto-release (v2) gateway, read at 'latest'. */
export const creGateways = (xs: readonly CrossChainDeployment[]): KeeperGateway[] =>
  xs.flatMap((x) => keeperGateways(x, CRE_CHAIN_NAMES, { stateBlock: 'latest' }));

/** The keeper's vault checks: one per receipt of every pair (public testnet RPCs: 'latest'). */
export const creVaults = (xs: readonly CrossChainDeployment[]) =>
  keeperVaults(xs, CRE_CHAIN_NAMES, { stateBlock: 'latest' });

/** The CRE chain-selector name of a deployment chain key. */
export function creNameOf(key: string): string {
  const n = CRE_CHAIN_NAMES[key];
  if (!n) throw new Error(`no CRE chain name for ${key} (note chains: ${NOTE_CHAINS.join(', ')})`);
  return n;
}

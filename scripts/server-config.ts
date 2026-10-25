/**
 * Write the server configs from deployments/robinhood-testnet.json (the current engine on Robinhood Chain testnet, the
 * only note chain):
 *   deployments/server/indexer.json   services/indexer (INDEXER_CONFIG) and the Worker's cron
 *   deployments/server/api.json       services/api (API_CONFIG) and the Worker's /api
 *
 *   npx tsx scripts/server-config.ts            # SITE=https://notes.markets by default
 *
 * Generic, unused today: deployments/archive/v<N>/<chain>.json would name earlier engines whose notes stay on them
 * (served as `legacyEngines`), and deployments/crosschain-testnet.json a cross-chain gateway (planned:
 * docs/CROSS-CHAIN.md). Neither exists, so the chain has one engine and no cross-chain config. A deployment file
 * without an `engine` (the placeholder before a fresh deploy) is skipped: the configs then list no chain.
 *
 * No secrets: DATABASE_URL, SN_PROXY_SECRET and the rest come from the environment (docs/DEPLOY.md).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CHAIN_TOKENS,
  isRetiredTestToken,
  TEST_CASH_TOKEN,
  type NoteChain,
} from '../packages/core/src/products/params';

const SITE = process.env.SITE ?? 'https://notes.markets';
const CHAINS = [
  {
    key: 'robinhood-testnet',
    chainId: 46630,
    rpc: process.env.RPC_ROBINHOOD_TESTNET ?? 'https://rpc.testnet.chain.robinhood.com',
  },
];
type Deployment = { engine: string; lens: string; block: number; faucet?: string; tokens?: Record<string, string> };
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const deployed = CHAINS.filter((c) => existsSync(`deployments/${c.key}.json`))
  .map((c) => ({ ...c, d: read<Partial<Deployment>>(`deployments/${c.key}.json`) }))
  .filter((c): c is typeof c & { d: Deployment } => !!c.d.engine && !!c.d.lens);
if (!deployed.length)
  console.warn('no deployed engine yet (deployments/robinhood-testnet.json is a placeholder): writing configs with no chain');

/** Earlier engines: deployments/archive/v<N>/<chain>.json, oldest first (the flat v1/v2 files predate the read model). */
const ARCHIVE = 'deployments/archive';
const versions = (existsSync(ARCHIVE) ? readdirSync(ARCHIVE) : [])
  .map((d) => /^v(\d+)$/.exec(d))
  .filter((m): m is RegExpExecArray => !!m)
  .map((m) => Number(m[1]))
  .sort((a, b) => a - b);
const legacyOf = (key: string, current: string) =>
  versions
    .filter((v) => existsSync(`${ARCHIVE}/v${v}/${key}.json`))
    .map((v) => ({
      version: v,
      d: read<Deployment>(`${ARCHIVE}/v${v}/${key}.json`),
      xc: existsSync(`${ARCHIVE}/v${v}/crosschain-testnet.json`)
        ? read<CrossChain>(`${ARCHIVE}/v${v}/crosschain-testnet.json`)
        : null,
    }))
    .filter((l) => l.d.engine.toLowerCase() !== current.toLowerCase());

const indexer = {
  chains: deployed.map((c) => ({
    key: c.key,
    family: 'evm',
    chainId: c.chainId,
    rpc: c.rpc,
    engine: c.d.engine,
    startBlock: c.d.block,
    // Robinhood Chain testnet (an Arbitrum Orbit chain) makes several blocks a second with few logs: 'finalized'
    // would lag ~L1 finality, so 120 confirmations; 20,000-block ranges (its RPC answers them in well under a second)
    // keep the indexer at the head (2,000 fell ~170,000 blocks behind).
    confirmations: 120,
    maxRange: 20000,
    pollMs: 2000,
    legacyEngines: legacyOf(c.key, c.d.engine).map((l) => ({
      engine: l.d.engine,
      startBlock: l.d.block,
      version: l.version,
    })),
  })),
};
/** The chain's real tokens (packages/core CHAIN_TOKENS: USDG, WETH, Robinhood's stock tokens), verified on-chain. */
const REAL = (key: string): Record<string, string> =>
  Object.fromEntries(Object.values(CHAIN_TOKENS[key as NoteChain] ?? {}).map((t) => [t.token, t.address]));
/** Of the deployment's own test tokens (TEST_TOKENS=1 rehearsals only), only tUSD is served. The others (tETH,
 * tTSLA…) are retired and never served. */
const legacyCash = (tokens: Record<string, string> | undefined) =>
  tokens?.[TEST_CASH_TOKEN.token] ? { [TEST_CASH_TOKEN.token]: tokens[TEST_CASH_TOKEN.token] } : {};
/** Receipts of retired test tokens (tTSLA.rh…) are disabled in the vault: dropped from what is served. */
const liveReceipts = (r: CrossChain['remotes'][number]['receipts']) =>
  Object.fromEntries(Object.entries(r).filter(([sym]) => !isRetiredTestToken(sym)));
/** Cross-chain collateral (planned; deployments/crosschain-testnet.json once deployed, home = Robinhood Chain):
 * receipts are tokens on the home chain; both sides get the addresses the app needs to lock, follow and redeem. */
type CrossChain = {
  home: { chain: string; selector: string; router: string; gateway: string };
  remotes: Array<{
    chain: string;
    selector: string;
    router: string;
    vault: string;
    receipts: Record<string, { receipt: string; token: string; decimals: number; valuedAs: string | null }>;
  }>;
};
const PREVIOUS_XC: CrossChain[] = (existsSync(ARCHIVE) ? readdirSync(ARCHIVE) : [])
  .filter((d) => /^xc-\d+$/.test(d))
  .sort()
  .map((d) => `${ARCHIVE}/${d}/crosschain-testnet.json`)
  .filter((f) => existsSync(f))
  .map((f) => read<CrossChain>(f));
const XC_CURRENT: CrossChain | null = existsSync('deployments/crosschain-testnet.json')
  ? read<CrossChain>('deployments/crosschain-testnet.json')
  : null;
const receiptsOn = (key: string, xc = XC_CURRENT) =>
  xc && xc.home.chain === key
    ? Object.fromEntries(
        xc.remotes.flatMap((r) => Object.entries(liveReceipts(r.receipts)).map(([sym, v]) => [sym, v.receipt])),
      )
    : {};
const crossChainOn = (key: string, XC: CrossChain | null = XC_CURRENT) => {
  if (!XC) return null;
  if (XC.home.chain === key)
    return {
      role: 'home',
      gateway: XC.home.gateway,
      router: XC.home.router,
      selector: XC.home.selector,
      remotes: XC.remotes.map((r) => ({
        chain: r.chain,
        selector: r.selector,
        vault: r.vault,
        receipts: liveReceipts(r.receipts),
      })),
    };
  const r = XC.remotes.find((x) => x.chain === key);
  return r
    ? {
        role: 'asset',
        vault: r.vault,
        router: r.router,
        selector: r.selector,
        home: { chain: XC.home.chain, gateway: XC.home.gateway, selector: XC.home.selector },
      }
    : null;
};
const api = {
  allowedOrigins: [SITE],
  trustProxy: true,
  ai: false, // the site's Worker answers /api/ai on Workers AI
  chains: deployed.map((c) => ({
    key: c.key,
    rpc: c.rpc,
    engine: c.d.engine,
    lens: c.d.lens,
    fromBlock: c.d.block,
    // Cash is Paxos's testnet USDG on Robinhood Chain (docs.paxos.com/guides/stablecoin/usdg/testnet).
    // The TokenFaucet (test tokens) is retired: not served.
    stablecoin: { symbol: 'USDG', address: REAL(c.key).USDG, decimals: 6 },
    tokens: { ...legacyCash(c.d.tokens), ...REAL(c.key), ...receiptsOn(c.key) },
    ...(crossChainOn(c.key) ? { crossChain: crossChainOn(c.key) } : {}),
    // Earlier engines: their notes render and their holders withdraw and settle with the engine's own address,
    // lens and ABI; their cross-chain receipts (symbols shared with the current pair) and gateway–vault pair.
    legacyEngines: legacyOf(c.key, c.d.engine).map((l) => ({
      engine: l.d.engine,
      lens: l.d.lens,
      fromBlock: l.d.block,
      version: l.version,
      tokens: receiptsOn(c.key, l.xc),
      ...(crossChainOn(c.key, l.xc) ? { crossChain: crossChainOn(c.key, l.xc) } : {}),
    })),
    // The current engine's replaced gateway–vault pairs (deployments/archive/xc-<n>/crosschain-testnet.json).
    previousCrossChain: PREVIOUS_XC.map((x) => crossChainOn(c.key, x)).filter((x) => x?.role === 'home'),
  })),
};
mkdirSync('deployments/server', { recursive: true });
writeFileSync('deployments/server/indexer.json', JSON.stringify(indexer, null, 2) + '\n');
writeFileSync('deployments/server/api.json', JSON.stringify(api, null, 2) + '\n');
console.log(`deployments/server/{indexer,api}.json: ${deployed.map((c) => c.key).join(', ')}`);

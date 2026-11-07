/**
 * Write the server configs from deployments/<chain>.json for each note chain (Robinhood Chain testnet and Base
 * Sepolia; the current engine on each) and the cross-chain pairs deployments/crosschain/<home>.json:
 *   deployments/server/indexer.json   services/indexer (INDEXER_CONFIG) and the Worker's cron
 *   deployments/server/api.json       services/api (API_CONFIG) and the Worker's /api
 *
 *   npx tsx scripts/server-config.ts            # SITE=https://notes.markets by default
 *
 * A deployment file without an `engine` (the placeholder before a fresh deploy), or none at all, is skipped: the
 * configs list only deployed chains. Each home chain with a valid deployments/crosschain/<home>.json (checked with
 * checkCrossChainDeployment) is served a `crossChain` (role 'home': its gateway and the vault behind it on the other
 * chain) and its receipts as tokens; a legacy deployments/crosschain-testnet.json is read last. The pure parts live in
 * packages/core/src/served-config.ts (unit-tested).
 *
 * Generic, unused today: deployments/archive/v<N>/<chain>.json would name earlier engines whose notes stay on them
 * (served as `legacyEngines`), and deployments/archive/xc-<n>/crosschain-testnet.json replaced gateway–vault pairs.
 *
 * No secrets: DATABASE_URL, SN_PROXY_SECRET and the rest come from the environment (docs/DEPLOY.md).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CrossChainDeployment } from '../packages/core/src/crosschain';
import { TEST_CASH_TOKEN } from '../packages/core/src/products/params';
import {
  pickCrossChain,
  realTokens,
  receiptsOn,
  servedChains,
  servedCrossChain,
  servedStablecoin,
} from '../packages/core/src/served-config';

const SITE = process.env.SITE ?? 'https://notes.markets';
const CHAINS = servedChains(process.env);
type Deployment = { engine: string; lens: string; block: number; faucet?: string; tokens?: Record<string, string> };
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const deployed = CHAINS.filter((c) => existsSync(`deployments/${c.key}.json`))
  .map((c) => ({ ...c, d: read<Partial<Deployment>>(`deployments/${c.key}.json`) }))
  .filter((c): c is typeof c & { d: Deployment } => !!c.d.engine && !!c.d.lens);
if (!deployed.length) console.warn('no deployed engine yet: writing configs with no chain');

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
        ? read<CrossChainDeployment>(`${ARCHIVE}/v${v}/crosschain-testnet.json`)
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
    ...c.indexer,
    legacyEngines: legacyOf(c.key, c.d.engine).map((l) => ({
      engine: l.d.engine,
      startBlock: l.d.block,
      version: l.version,
    })),
  })),
};
/** Of the deployment's own test tokens (TEST_TOKENS=1 rehearsals only), only tUSD is served. The others (tETH,
 * tTSLA…) are retired and never served. */
const legacyCash = (tokens: Record<string, string> | undefined) =>
  tokens?.[TEST_CASH_TOKEN.token] ? { [TEST_CASH_TOKEN.token]: tokens[TEST_CASH_TOKEN.token] } : {};

/** Cross-chain pairs: one deployments/crosschain/<home>.json per home chain, then the legacy single file. */
const XC_DIR = 'deployments/crosschain';
const xcFiles = [
  ...(existsSync(XC_DIR) ? readdirSync(XC_DIR) : [])
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => `${XC_DIR}/${f}`),
  ...(existsSync('deployments/crosschain-testnet.json') ? ['deployments/crosschain-testnet.json'] : []),
];
const { xs: XC, warnings } = pickCrossChain(xcFiles.map((file) => ({ file, data: read<CrossChainDeployment>(file) })));
for (const w of warnings) console.warn(w);
/** The current engine's replaced gateway–vault pairs (deployments/archive/xc-<n>/crosschain-testnet.json). */
const PREVIOUS_XC: CrossChainDeployment[] = (existsSync(ARCHIVE) ? readdirSync(ARCHIVE) : [])
  .filter((d) => /^xc-\d+$/.test(d))
  .sort()
  .map((d) => `${ARCHIVE}/${d}/crosschain-testnet.json`)
  .filter((f) => existsSync(f))
  .map((f) => read<CrossChainDeployment>(f));
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
    // Cash: Paxos's testnet USDG on Robinhood Chain, Circle's testnet USDC on Base Sepolia (core CHAIN_CASH).
    // The TokenFaucet (test tokens) is retired: not served.
    stablecoin: servedStablecoin(c.key),
    tokens: { ...legacyCash(c.d.tokens), ...realTokens(c.key), ...receiptsOn(XC, c.key) },
    ...(servedCrossChain(XC, c.key) ? { crossChain: servedCrossChain(XC, c.key) } : {}),
    // Earlier engines: their notes render and their holders withdraw and settle with the engine's own address,
    // lens and ABI; their cross-chain receipts (symbols shared with the current pair) and gateway–vault pair.
    legacyEngines: legacyOf(c.key, c.d.engine).map((l) => ({
      engine: l.d.engine,
      lens: l.d.lens,
      fromBlock: l.d.block,
      version: l.version,
      tokens: l.xc ? receiptsOn([l.xc], c.key) : {},
      ...(l.xc && servedCrossChain([l.xc], c.key) ? { crossChain: servedCrossChain([l.xc], c.key) } : {}),
    })),
    // The current engine's replaced gateway–vault pairs (deployments/archive/xc-<n>/crosschain-testnet.json).
    previousCrossChain: PREVIOUS_XC.map((x) => servedCrossChain([x], c.key)).filter((x) => !!x),
  })),
};
mkdirSync('deployments/server', { recursive: true });
writeFileSync('deployments/server/indexer.json', JSON.stringify(indexer, null, 2) + '\n');
writeFileSync('deployments/server/api.json', JSON.stringify(api, null, 2) + '\n');
console.log(
  `deployments/server/{indexer,api}.json: ${deployed.map((c) => c.key).join(', ') || 'no chain'}${XC.length ? `; cross-chain homes: ${XC.map((x) => x.home.chain).join(', ')}` : ''}`,
);

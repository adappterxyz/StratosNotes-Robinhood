/**
 * Write the CRE keeper's config for a target from the note chains' deployments (deployments/robinhood-testnet.json,
 * deployments/base-sepolia.json; CRE writes on each through the chain's KeystoneForwarder or, simulating with
 * --broadcast, its MockKeystoneForwarder) and the cross-chain pairs (deployments/crosschain/<home>.json):
 *
 *   npx tsx scripts/cre-config.ts staging       # robinhood-testnet and ethereum-testnet-sepolia-base-1
 *   npx tsx scripts/cre-config.ts local-fork deployments/local/robinhood-fork.json
 *   GATEWAY=0x... npx tsx scripts/cre-config.ts local-fork ...   # also flush a HomeGateway v2 on the fork
 *   BASE_FORK=deployments/local/base-fork.json npx tsx scripts/cre-config.ts local-fork ...   # plus a Base Sepolia fork
 *
 * There is no production target: CRE cannot write to Robinhood Chain mainnet yet (services/keeper-fallback).
 * Staging gets `gateways` (one flush gateway per home chain, HomeGateway v2) and `vaults` (one backing check per
 * receipt, both directions) from every valid deployments/crosschain/*.json (and a legacy crosschain-testnet.json)
 * whose home chain is deployed; with none, both are left out. The pure parts: packages/core/src/served-config.ts.
 *
 * A deployment file without an engine (the placeholder before a fresh deploy) is left out of staging; a local fork
 * without one gets the zero address, which the workflow refuses (fails closed).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { keeperGateways, type CrossChainDeployment } from '../packages/core/src/crosschain';
import { HTTP_FEED_CHAINS } from '../packages/core/src/feed-rpc';
import { creGateways, creNameOf, creVaults, pickCrossChain } from '../packages/core/src/served-config';

const ZERO = '0x0000000000000000000000000000000000000000';
const TARGETS: Record<string, Array<{ file: string; chainSelectorName: string }>> = {
  staging: [
    { file: 'deployments/robinhood-testnet.json', chainSelectorName: creNameOf('robinhood-testnet') },
    { file: 'deployments/base-sepolia.json', chainSelectorName: creNameOf('base-sepolia') },
  ],
  'local-fork': [
    {
      file: process.argv[3] ?? 'deployments/local/robinhood-fork.json',
      chainSelectorName: creNameOf('robinhood-testnet'),
    },
    ...(process.env.BASE_FORK ? [{ file: process.env.BASE_FORK, chainSelectorName: creNameOf('base-sepolia') }] : []),
  ],
};
const target = process.argv[2];
const chains = TARGETS[target];
if (!chains) throw new Error(`target: ${Object.keys(TARGETS).join(' | ')}`);
const engineOf = (file: string) => {
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, 'utf8')) as { engine?: string; lens?: string };
  return d.engine && d.lens ? { engine: d.engine, lens: d.lens } : null;
};
/** Valid cross-chain pairs, one per home chain, whose home is deployed (staging only). */
function crossChain(): CrossChainDeployment[] {
  if (target !== 'staging') return [];
  const dir = 'deployments/crosschain';
  const files = [
    ...(existsSync(dir) ? readdirSync(dir) : [])
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => `${dir}/${f}`),
    ...(existsSync('deployments/crosschain-testnet.json') ? ['deployments/crosschain-testnet.json'] : []),
  ];
  const { xs, warnings } = pickCrossChain(
    files.map((file) => ({ file, data: JSON.parse(readFileSync(file, 'utf8')) as CrossChainDeployment })),
  );
  for (const w of warnings) console.warn(w);
  // A pair whose home chain has no engine in this config has nobody to drive its notes: leave it out.
  return xs.filter((x) => !!engineOf(`deployments/${x.home.chain}.json`));
}
const XC = crossChain();
/** Auto-release gateways the keeper flushes: staging from the cross-chain pairs (v2 only); a local fork only when
 * GATEWAY names one (on the Robinhood Chain fork). */
function gateways() {
  if (target === 'staging') return creGateways(XC);
  if (target === 'local-fork' && process.env.GATEWAY) {
    return keeperGateways(
      { home: { chain: 'robinhood-testnet', gateway: process.env.GATEWAY, version: 2 } },
      { 'robinhood-testnet': creNameOf('robinhood-testnet') },
      { stateBlock: 'latest' },
    );
  }
  return [];
}
const flushGateways = gateways();
const vaults = creVaults(XC);
/** Earlier engines whose notes are still running (deployments/archive/<v>/<chain>.json): the keeper keeps
 * driving them to maturity after a redeploy. Staging only, and only when LEGACY=v<N>,... names them (none today). */
const legacyEngines = (ch: { file: string; chainSelectorName: string }) =>
  target !== 'staging'
    ? []
    : (process.env.LEGACY ?? '')
        .split(',')
        .filter(Boolean)
        .map((v) => ch.file.replace('deployments/', `deployments/archive/${v}/`))
        .filter((f) => existsSync(f))
        .map((f) => ({ file: f, chainSelectorName: ch.chainSelectorName }));
const config = {
  schedule: '*/30 * * * * *',
  // A chain not deployed yet is left out of staging: the workflow refuses a zero address, and listing one would stop
  // every run. A local fork keeps its entry.
  chains: chains
    .filter((ch) => target !== 'staging' || engineOf(ch.file))
    .flatMap((ch) => [ch, ...legacyEngines(ch)])
    .map((ch) => {
      const d = engineOf(ch.file) ?? { engine: ZERO, lens: ZERO };
      return {
        chainSelectorName: ch.chainSelectorName,
        engine: d.engine,
        lens: d.lens,
        // A coupon to a full book (62 holders) measured 2.22M gas of execution; the margin covers the L1 data gas
        // Robinhood Chain (an Arbitrum Orbit chain) charges inside the limit (Base bills it outside: more margin).
        gasLimit: '8000000',
        fromPid: 1,
        scan: 200,
        maxProcesses: 50,
        // Public testnet RPCs don't serve recent historical state, so staging reads the engine at the latest block.
        ...(target === 'staging' ? { stateBlock: 'latest' } : {}),
      };
    }),
  maxReportsPerRun: 5,
  // Auto-release (docs/CROSS-CHAIN.md, CRE report spec): read each home chain's gateway queue and flush it.
  ...(flushGateways.length ? { gateways: flushGateways } : {}),
  // Cross-chain collateral (docs/CROSS-CHAIN.md): check that each vault still backs the receipts outstanding on its
  // home chain, both directions (a rotating few per run, within the read budget).
  ...(vaults.length ? { vaults } : {}),
  // Feeds are read at a finalized block (Ethereum ~13 min behind the head).
  finalityAllowanceSec: 1800,
  // Feed chains CRE has no EVM read capability for (Robinhood Chain mainnet: the equity feeds) are read over the
  // HTTP capability with JSON-RPC eth_call, pinned a little below the head the nodes agree on (feed-rpc.ts).
  httpFeedChains: Object.fromEntries(
    Object.entries(HTTP_FEED_CHAINS).map(([name, c]) => [
      name,
      {
        rpc: c.rpc,
        ...(c.lagBlocks !== undefined ? { lagBlocks: c.lagBlocks } : { blockTag: c.blockTag ?? 'finalized' }),
      },
    ]),
  ),
};
const out = `cre/notes-keeper-evm/config.${target === 'staging' ? 'staging' : 'local-fork'}.json`;
writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
console.log(
  `${out}: ${config.chains.map((c) => `${c.chainSelectorName} engine ${c.engine}`).join(', ') || 'no chain'}${flushGateways.map((g) => `; flush gateway ${g.gateway} on ${g.chainSelectorName}`).join('')}${vaults.length ? `; ${vaults.length} vault check(s)` : ''}`,
);

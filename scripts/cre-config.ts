/**
 * Write the CRE keeper's config for a target from deployments/robinhood-testnet.json (Robinhood Chain testnet, the only
 * note chain; CRE writes there through the chain's KeystoneForwarder or, simulating with --broadcast, its
 * MockKeystoneForwarder):
 *
 *   npx tsx scripts/cre-config.ts staging       # robinhood-testnet
 *   npx tsx scripts/cre-config.ts local-fork deployments/local/robinhood-fork.json
 *   GATEWAY=0x... npx tsx scripts/cre-config.ts local-fork ...   # also flush a HomeGateway v2 on the fork
 *
 * There is no production target: CRE cannot write to Robinhood Chain mainnet yet (services/keeper-fallback).
 * Cross-chain collateral is planned, not deployed (docs/CROSS-CHAIN.md): staging gets `gateways` and `vaults` only
 * once deployments/crosschain-testnet.json exists (home = Robinhood Chain); today both are left out.
 *
 * A deployment file without an engine (the placeholder before a fresh deploy) is left out of staging; a local fork
 * without one gets the zero address, which the workflow refuses (fails closed).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { keeperGateways } from '../packages/core/src/crosschain';
import { HTTP_FEED_CHAINS } from '../packages/core/src/feed-rpc';

const ZERO = '0x0000000000000000000000000000000000000000';
const TARGETS: Record<string, Array<{ file: string; chainSelectorName: string }>> = {
  staging: [{ file: 'deployments/robinhood-testnet.json', chainSelectorName: 'robinhood-testnet' }],
  'local-fork': [
    {
      file: process.argv[3] ?? 'deployments/local/robinhood-fork.json',
      chainSelectorName: 'robinhood-testnet',
    },
  ],
};
const target = process.argv[2];
const chains = TARGETS[target];
if (!chains) throw new Error(`target: ${Object.keys(TARGETS).join(' | ')}`);
/** Deployment chain names to CRE chain-selector names (remote collateral chains get theirs when deployed). */
const CRE_NAMES: Record<string, string> = {
  'robinhood-testnet': 'robinhood-testnet',
};
const engineOf = (file: string) => {
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, 'utf8')) as { engine?: string; lens?: string };
  return d.engine && d.lens ? { engine: d.engine, lens: d.lens } : null;
};
function crossChainVaults() {
  const x = JSON.parse(readFileSync('deployments/crosschain-testnet.json', 'utf8')) as {
    home: { chain: string };
    remotes: Array<{ chain: string; vault: string; receipts: Record<string, { receipt: string; token: string }> }>;
  };
  return x.remotes.flatMap((r) =>
    Object.entries(r.receipts).map(([label, v]) => ({
      homeChain: CRE_NAMES[x.home.chain],
      receipt: v.receipt,
      assetChain: CRE_NAMES[r.chain],
      vault: r.vault,
      token: v.token,
      label,
      stateBlock: 'latest' as const,
    })),
  );
}
/** Auto-release gateways the keeper flushes: staging from the cross-chain deployment (v2 only; none today); a local
 * fork only when GATEWAY names one. */
function gateways() {
  if (target === 'staging' && existsSync('deployments/crosschain-testnet.json')) {
    return keeperGateways(JSON.parse(readFileSync('deployments/crosschain-testnet.json', 'utf8')), CRE_NAMES, {
      stateBlock: 'latest',
    });
  }
  if (target === 'local-fork' && process.env.GATEWAY) {
    return keeperGateways(
      { home: { chain: 'robinhood-testnet', gateway: process.env.GATEWAY, version: 2 } },
      CRE_NAMES,
      { stateBlock: 'latest' },
    );
  }
  return [];
}
const flushGateways = gateways();
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
        // Robinhood Chain (an Arbitrum Orbit chain) charges inside the limit.
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
  // Cross-chain collateral (planned, docs/CROSS-CHAIN.md): every run, check that each remote vault still backs the
  // receipts outstanding on Robinhood Chain. Staging only, once deployments/crosschain-testnet.json exists.
  ...(target === 'staging' && existsSync('deployments/crosschain-testnet.json') ? { vaults: crossChainVaults() } : {}),
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
  `${out}: ${config.chains.map((c) => `${c.chainSelectorName} engine ${c.engine}`).join(', ')}${flushGateways.map((g) => `; flush gateway ${g.gateway} on ${g.chainSelectorName}`).join('')}`,
);

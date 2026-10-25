/**
 * Fill the landing page's proof section from facts on disk, never from typed-in numbers:
 *   - deployments/<chain>.json      the contracts on each testnet (written by scripts/deploy-testnets.sh)
 *   - docs/evidence.json            optional: real testnet runs (note, transactions, payouts), added after a run
 *
 *   npx tsx scripts/landing-proof.ts     # writes landing/src/proof.json (run before building the landing page)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CHAIN_TOKENS, type NoteChain } from '../packages/core/src/products/params';

const CHAINS = [
  { key: 'arbitrum-sepolia', name: 'Arbitrum Sepolia', explorer: 'https://sepolia.arbiscan.io' },
  {
    key: 'robinhood-testnet',
    name: 'Robinhood Chain testnet',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
  },
];

interface Evidence {
  runs?: Array<{
    chain: string;
    note: string;
    title: string;
    reporter: 'cre' | 'fallback';
    events: Array<{ what: string; detail: string; tx: string; gas?: string }>;
    paid: Array<{ holder: string; units: string; paid: string }>;
  }>;
}

const deployments = CHAINS.map((c) => {
  const f = `deployments/${c.key}.json`;
  if (!existsSync(f)) return { ...c, deployed: false as const };
  const d = JSON.parse(readFileSync(f, 'utf8')) as {
    engine: string;
    lens: string;
    faucet?: string;
    forwarder: string;
    block: number;
    tokens?: Record<string, string>;
  };
  // The real tokens notes use on the chain (notes.markets' own test tokens are retired and not shown).
  const tokens = Object.fromEntries(
    Object.values(CHAIN_TOKENS[c.key as NoteChain] ?? {}).map((t) => [t.token, t.address]),
  );
  return {
    ...c,
    deployed: true as const,
    engine: d.engine,
    lens: d.lens,
    forwarder: d.forwarder,
    block: d.block,
    tokens,
  };
});
const evidence: Evidence = existsSync('docs/evidence.json')
  ? JSON.parse(readFileSync('docs/evidence.json', 'utf8'))
  : {};
const out = { generatedAt: new Date().toISOString(), deployments, runs: evidence.runs ?? [] };
writeFileSync('landing/src/proof.json', JSON.stringify(out, null, 2) + '\n');
console.log(
  `landing/src/proof.json: ${deployments.filter((d) => d.deployed).length}/${deployments.length} chains deployed, ${out.runs.length} testnet run(s)`,
);

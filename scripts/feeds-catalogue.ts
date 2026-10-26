/**
 * Generate packages/core/src/products/feeds-catalogue.ts: every Chainlink price a note can be fixed on.
 *
 *   npx tsx scripts/feeds-catalogue.ts            # download, filter, read each feed once, write the module
 *   npx tsx scripts/feeds-catalogue.ts --check    # the same, print the summary, write nothing
 *
 * 1. Downloads Chainlink's reference data directory for the networks Chainlink CRE can read fixings from:
 *    Ethereum mainnet and Arbitrum One (CRE EVM read), Robinhood Chain mainnet (CRE HTTP JSON-RPC, httpFeedChains).
 * 2. Keeps standard USD push price feeds only and one feed per symbol (packages/core/src/products/feed-directory.ts;
 *    the rules are in docs/UNDERLYINGS.md).
 * 3. Reads latestRoundData() of every kept feed (read-only eth_call, public RPCs): a feed whose last round is older
 *    than its staleness allowance is dropped as not live; the price sets the bounds (a tenth to ten times).
 * 4. Symbols notes already used keep their exact feed, chain, bounds and staleness (PINNED), so their compiled
 *    definitions do not change; the script fails if the directory's priority would pick another feed for one.
 * 5. Writes the module: one feed per line, left out of prettier (.prettierignore) so a regeneration diffs by feed.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSET_CLASSES,
  boundsOf,
  DIRECTORY_NETWORKS,
  filterDirectory,
  MIN_SUPPORTED_PRICE,
  pickPerSymbol,
  stalenessOf,
  type Candidate,
  type CatalogueChain,
  type DirectoryEntry,
  type DirectoryNetwork,
  type Exclusion,
} from '../packages/core/src/products/feed-directory';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'packages/core/src/products/feeds-catalogue.ts');
const DIRECTORY = (n: string) => `https://reference-data-directory.vercel.app/feeds-${n}.json`;
const RPC: Record<CatalogueChain, string> = {
  'ethereum-mainnet': process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com',
  'ethereum-mainnet-arbitrum-1': process.env.ARB_RPC ?? 'https://arbitrum-one-rpc.publicnode.com',
  'robinhood-mainnet': process.env.RH_RPC ?? 'https://rpc.mainnet.chain.robinhood.com',
};

/**
 * The symbols notes used before the catalogue (FEEDS until 2026-10-26), exactly as they were: issued notes and saved
 * term sheets carry these values, and a definition compiled from them must not change.
 */
const EQUITY_PIN = { feedChain: 'robinhood-mainnet', minPrice: 1, maxPrice: 100_000, staleness: 345_600 } as const;
const PINNED: Record<
  string,
  { feed: string; feedChain: CatalogueChain; minPrice: number; maxPrice: number; staleness: number }
> = {
  ETH: {
    feed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    feedChain: 'ethereum-mainnet',
    minPrice: 1,
    maxPrice: 1_000_000,
    staleness: 3600,
  },
  BTC: {
    feed: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    feedChain: 'ethereum-mainnet',
    minPrice: 1,
    maxPrice: 10_000_000,
    staleness: 3600,
  },
  SOL: {
    feed: '0x4ffC43a60e009B551865A93d232E33Fce9f01507',
    feedChain: 'ethereum-mainnet',
    minPrice: 0.01,
    maxPrice: 100_000,
    staleness: 86400,
  },
  TSLA: { feed: '0x4A1166a659A55625345e9515b32adECea5547C38', ...EQUITY_PIN },
  AMZN: { feed: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C', ...EQUITY_PIN },
  AMD: { feed: '0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72', ...EQUITY_PIN },
  PLTR: { feed: '0x820ABedFF239034956B7A9d2F0a331f9F075eB4c', ...EQUITY_PIN },
  NVDA: { feed: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15', ...EQUITY_PIN },
  AAPL: { feed: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0', ...EQUITY_PIN },
  SPY: { feed: '0x319724394D3A0e3669269846abE664Cd621f9f6A', ...EQUITY_PIN },
  META: { feed: '0x7C38C00C30BEe9378381E7B6135d7283356D71b1', ...EQUITY_PIN },
  MSFT: { feed: '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E', ...EQUITY_PIN },
  GOOGL: { feed: '0xF6f373a037c30F0e5010d854385cA89185AE638b', ...EQUITY_PIN },
  COIN: { feed: '0xA3a468A452940B7D6b69991207B508c609a98Ef2', ...EQUITY_PIN },
};

async function getJson<T>(url: string, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(
        url,
        body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {},
      );
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return (await r.json()) as T;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * attempt));
    }
  }
}

/** latestRoundData() of each feed on one chain, batched JSON-RPC eth_call at 'latest' (read-only). */
async function latestRounds(
  chain: CatalogueChain,
  feeds: string[],
): Promise<Map<string, { answer: bigint; updatedAt: number } | Error>> {
  const out = new Map<string, { answer: bigint; updatedAt: number } | Error>();
  for (let i = 0; i < feeds.length; i += 20) {
    const batch = feeds.slice(i, i + 20);
    const replies = await getJson<Array<{ id: number; result?: string; error?: { message: string } }>>(
      RPC[chain],
      batch.map((to, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'eth_call',
        params: [{ to, data: '0xfeaf968c' }, 'latest'],
      })),
    );
    for (const r of replies) {
      const feed = batch[r.id];
      if (!r.result || r.result.length < 2 + 64 * 5) {
        out.set(feed, new Error(r.error?.message ?? `empty reply ${r.result}`));
        continue;
      }
      const word = (k: number) => BigInt(`0x${r.result!.slice(2 + 64 * k, 2 + 64 * (k + 1))}`);
      let answer = word(1);
      if (answer >= 1n << 255n) answer -= 1n << 256n;
      out.set(feed, { answer, updatedAt: Number(word(3)) });
    }
  }
  return out;
}

const fmt = (n: number) => {
  const s = String(n);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`bound ${n} does not print as a plain decimal`);
  return s.includes('.') ? s : s.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
};

async function main() {
  const check = process.argv.includes('--check');
  const now = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);
  const all: Candidate[] = [];
  const excluded: Exclusion[] = [];
  const rows: Record<string, number> = {};
  for (const network of Object.keys(DIRECTORY_NETWORKS) as DirectoryNetwork[]) {
    const entries = await getJson<DirectoryEntry[]>(DIRECTORY(network));
    rows[network] = entries.length;
    const r = filterDirectory(network, entries);
    all.push(...r.kept);
    excluded.push(...r.excluded);
  }
  const { picked } = pickPerSymbol(all);
  for (const [sym, pin] of Object.entries(PINNED)) {
    const c = picked.find((x) => x.symbol === sym);
    if (!c) throw new Error(`${sym}: notes use it, but the directory no longer passes it`);
    if (c.feed.toLowerCase() !== pin.feed.toLowerCase() || c.feedChain !== pin.feedChain)
      throw new Error(`${sym}: priority picks ${c.feed} on ${c.feedChain}, notes use ${pin.feed} on ${pin.feedChain}`);
  }

  const live: Array<Candidate & { staleness: number; minPrice: number; maxPrice: number; price: number }> = [];
  const dead: string[] = [];
  for (const chain of Object.values(DIRECTORY_NETWORKS)) {
    const on = picked.filter((c) => c.feedChain === chain);
    const rounds = await latestRounds(
      chain,
      on.map((c) => c.feed),
    );
    for (const c of on) {
      const r = rounds.get(c.feed)!;
      const pin = PINNED[c.symbol];
      const staleness = pin?.staleness ?? stalenessOf(c);
      if (r instanceof Error) {
        dead.push(`${c.symbol} (${chain}): read failed: ${r.message}`);
        continue;
      }
      const price = Number(r.answer) / 10 ** c.decimals;
      const age = now - r.updatedAt;
      // The keeper allows 30 min of finality lag on top: the same here.
      if (age > staleness + 1800 && !pin) {
        dead.push(
          `${c.symbol} (${chain}): last round ${Math.round(age / 3600)} h old, allowance ${Math.round(staleness / 3600)} h`,
        );
        continue;
      }
      if (!(price >= MIN_SUPPORTED_PRICE) && !pin) {
        dead.push(`${c.symbol} (${chain}): price ${price} below ${MIN_SUPPORTED_PRICE}`);
        continue;
      }
      const b = pin ? { minPrice: pin.minPrice, maxPrice: pin.maxPrice } : boundsOf(price);
      live.push({ ...c, staleness, ...b, price });
    }
  }
  live.sort(
    (a, b) =>
      ASSET_CLASSES.indexOf(a.assetClass) - ASSET_CLASSES.indexOf(b.assetClass) || a.symbol.localeCompare(b.symbol),
  );

  const count = (k: (c: (typeof live)[number]) => string) =>
    live.reduce<Record<string, number>>((m, c) => ((m[k(c)] = (m[k(c)] ?? 0) + 1), m), {});
  const reasons = excluded.reduce<Record<string, number>>(
    (m, x) => ((m[x.reason.replace(/ \(.*\)$|'.*'/g, '…')] = (m[x.reason.replace(/ \(.*\)$|'.*'/g, '…')] ?? 0) + 1), m),
    {},
  );
  console.log(`directory rows: ${JSON.stringify(rows)}`);
  console.log(`catalogue: ${live.length} feeds`);
  console.log(`  by class: ${JSON.stringify(count((c) => c.assetClass))}`);
  console.log(`  by chain: ${JSON.stringify(count((c) => c.feedChain))}`);
  console.log(`excluded rows by reason: ${JSON.stringify(reasons)}`);
  console.log(`dropped as not live: ${dead.length}${dead.length ? `\n  ${dead.join('\n  ')}` : ''}`);
  if (check) return;

  const lines = live.map(
    (c) =>
      `  { symbol: '${c.symbol}', name: ${JSON.stringify(c.name)}, assetClass: '${c.assetClass}', feed: '${c.feed}', feedChain: '${c.feedChain}', decimals: ${c.decimals}, heartbeat: ${fmt(c.heartbeat)}, staleness: ${fmt(c.staleness)}, minPrice: ${fmt(c.minPrice)}, maxPrice: ${fmt(c.maxPrice)}, risk: '${c.risk}', marketHours: '${c.marketHours}' },`,
  );
  const src = `/**
 * GENERATED by scripts/feeds-catalogue.ts on ${today} from Chainlink's reference data directory
 * (https://reference-data-directory.vercel.app/feeds-<network>.json): every Chainlink price a note can be fixed on.
 * Do not edit by hand. Regenerate with:
 *
 *   npx tsx scripts/feeds-catalogue.ts
 *
 * Rules (docs/UNDERLYINGS.md): standard USD push price feeds only, one per symbol (equities from Robinhood Chain
 * mainnet first, then Arbitrum One; crypto, forex and commodities from Ethereum mainnet first); staleness = heartbeat
 * + the weekend for market-hours classes, + 10% for crypto; bounds = a tenth to ten times the price on ${today}
 * (two significant figures). Symbols notes used before the catalogue keep their exact earlier values.
 * ${live.length} feeds: ${Object.entries(count((c) => c.assetClass))
   .map(([k, v]) => `${v} ${k}`)
   .join(', ')}.
 */
import type { AssetClass, CatalogueChain } from './feed-directory';

/** One Chainlink price feed a note can be fixed on. */
export interface CatalogueFeed {
  /** Ticker, as notes name it (validateTermSheet: capitals and digits). */
  symbol: CatalogueSymbol;
  /** What it is, for people. */
  name: string;
  assetClass: AssetClass;
  /** The feed's AggregatorV3 proxy. */
  feed: \`0x\${string}\`;
  /** CRE chain-selector name of the chain the feed lives on. */
  feedChain: CatalogueChain;
  decimals: number;
  /** Chainlink's heartbeat, seconds: a new round at least this often (in market hours). */
  heartbeat: number;
  /** Oldest acceptable round, seconds (heartbeat + weekend for market-hours classes, + 10% for crypto). */
  staleness: number;
  /** Bounds every fixing must sit in, checked on-chain. */
  minPrice: number;
  maxPrice: number;
  /** Chainlink's market-risk category ('custom': Robinhood Chain's own equity feeds, explicitly allowed). */
  risk: string;
  /** The directory's market hours (e.g. Crypto, Forex, us_equities_24/5). */
  marketHours: string;
}

export type CatalogueSymbol =
${live.map((c) => `  | '${c.symbol}'`).join('\n')};

export const FEED_CATALOGUE: readonly CatalogueFeed[] = [
${lines.join('\n')}
];
`;
  writeFileSync(OUT, src);
  console.log(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

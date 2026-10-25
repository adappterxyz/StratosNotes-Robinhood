/**
 * Run the fallback keeper.
 *
 *   KEEPER_CONFIG=config.json KEEPER_KEY_FILE=/path/to/key npm start      # every INTERVAL seconds
 *   ... npm run once                                                       # one pass, then exit
 *
 * config.json:
 *   { "chain": { "name": "robinhood-mainnet", "chainId": 4663, "rpc": "https://...", "engine": "0x...", "lens": "0x..." },
 *     "feedRpcs": { "ethereum-mainnet": "https://..." },      // robinhood-mainnet has a built-in default
 *     "blockTag": "finalized", "finalityAllowanceSec": 1800, "maxReportsPerRun": 5, "gasLimit": "2500000",
 *     "intervalSec": 60, "feedRoutes": {} }
 *
 * Feed chains in HTTP_FEED_CHAINS (Robinhood Chain mainnet: the equity feeds) get their public RPC and block rule
 * by default; "feedRpcs" and "feedReadAt" ({ "<chain>": { "blockTag": "latest" } or { "lagBlocks": 600 } }) override.
 *
 * The key file holds the fallback reporter's private key (0x-hex, one line). Keep it in a secret store or KMS
 * in production; this process only reads the path it is given and never logs the key.
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HTTP_FEED_CHAINS, type FeedReadAt } from '@sn/core';
import { runOnce } from './keeper';

interface FileConfig {
  chain: { name: string; chainId: number; rpc: string; engine: Address; lens: Address };
  feedRpcs?: Record<string, string>;
  feedReadAt?: Record<string, FeedReadAt>;
  blockTag?: 'latest' | 'safe' | 'finalized';
  finalityAllowanceSec?: number;
  maxReportsPerRun?: number;
  gasLimit?: string;
  intervalSec?: number;
  feedRoutes?: Record<string, { feed: string; feedChain: string; staleness?: number }>;
}

const cfgPath = process.env.KEEPER_CONFIG;
const keyPath = process.env.KEEPER_KEY_FILE;
if (!cfgPath || !keyPath) throw new Error('set KEEPER_CONFIG and KEEPER_KEY_FILE');
const fc = JSON.parse(readFileSync(cfgPath, 'utf8')) as FileConfig;
const account = privateKeyToAccount(readFileSync(keyPath, 'utf8').trim() as Hex);
const chain = defineChain({
  id: fc.chain.chainId,
  name: fc.chain.name,
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [fc.chain.rpc] } },
});
const client = createPublicClient({ chain, transport: http(fc.chain.rpc) }) as PublicClient;
const wallet = createWalletClient({ chain, account, transport: http(fc.chain.rpc) });
const feedRpcs = {
  ...Object.fromEntries(Object.entries(HTTP_FEED_CHAINS).map(([k, c]) => [k, c.rpc])),
  ...fc.feedRpcs,
};
const feedReadAt: Record<string, FeedReadAt> = {
  ...Object.fromEntries(
    Object.entries(HTTP_FEED_CHAINS).map(([k, c]) => [k, { blockTag: c.blockTag, lagBlocks: c.lagBlocks }]),
  ),
  ...fc.feedReadAt,
};
const feedClients = Object.fromEntries(
  Object.entries(feedRpcs).map(([k, url]) => [k, createPublicClient({ transport: http(url) }) as PublicClient]),
);

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const pass = () =>
  runOnce({
    chain: { name: fc.chain.name, client, wallet, engine: fc.chain.engine, lens: fc.chain.lens },
    feedClients,
    feedReadAt,
    blockTag: fc.blockTag ?? 'finalized',
    finalityAllowanceSec: fc.finalityAllowanceSec ?? 1800,
    maxReportsPerRun: fc.maxReportsPerRun ?? 5,
    gasLimit: BigInt(fc.gasLimit ?? '2500000'),
    feedRoutes: fc.feedRoutes,
    log,
  });

if (process.argv.includes('--once')) {
  console.log(JSON.stringify(await pass()));
} else {
  for (;;) {
    try {
      await pass();
    } catch (e) {
      log(`error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, (fc.intervalSec ?? 60) * 1000));
  }
}

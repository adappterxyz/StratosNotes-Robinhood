// Chainlink feed reads over the CRE HTTP capability, for feed chains CRE has no EVM read capability for
// (Robinhood Chain mainnet). Kept apart from main.ts so a check workflow can run exactly this code.
//
// Per chain per run: (pinned reads only) one eth_blockNumber request, the DON agreeing on the median head; then
// ONE batched JSON-RPC request with latestRoundData() + decimals() for every feed needed, at that head minus
// lagBlocks (or at a block tag). Every node decodes its reply to plain strings (packages/core/src/feed-rpc.ts), so
// the DON agrees on the readings themselves, never on raw JSON. No response cache: each node asks the RPC itself.
import {
  bytesToBase64,
  consensusIdenticalAggregation,
  consensusMedianAggregation,
  HTTPClient,
  ok,
  text,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk';
import { z } from 'zod';
import {
  blockNumberBody,
  decodeBlockNumber,
  decodeFeedBatch,
  feedBatchBody,
  FEEDS_PER_BATCH,
  pinnedBlock,
  type FeedReading,
} from '../../packages/core/src/feed-rpc';
import type { FeedRef } from '../../packages/core/src/keeper';

export const httpFeedChainsSchema = z.record(
  z.object({
    // A regex, not z.string().url(): the workflow's QuickJS runtime has no URL constructor.
    rpc: z.string().regex(/^https:\/\/[^\s/?#]+[^\s]*$/, 'an https:// URL'),
    /** Block tag to read at (default 'finalized'), unless lagBlocks pins the block. */
    blockTag: z.enum(['finalized', 'safe', 'latest']).optional(),
    /** Read at (median head across nodes) - lagBlocks: every node reads the same block. */
    lagBlocks: z.number().int().nonnegative().optional(),
  }),
);
export type HttpFeedChains = z.infer<typeof httpFeedChainsSchema>;

const post = (s: HTTPSendRequester, rpc: string, body: string): string => {
  const r = s
    .sendRequest({
      url: rpc,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // QuickJS has no Node Buffer: encode with the SDK helper.
      body: bytesToBase64(new TextEncoder().encode(body)),
      timeout: '10s', // CRE caps an HTTP request at 10 s
    })
    .result();
  if (!ok(r)) throw new Error(`feed RPC: HTTP ${r.statusCode}`);
  return text(r);
};

/** Runs on every node: the head block number (aggregated by median). */
export const headBlock = (s: HTTPSendRequester, rpc: string): number =>
  decodeBlockNumber(post(s, rpc, blockNumberBody()));

/**
 * Runs on every node: one batched request, decoded to strings (aggregated as identical). A failed request fails
 * every feed in it with the same text, so nodes that saw the same failure still agree.
 */
export const feedBatch = (s: HTTPSendRequester, req: { rpc: string; feeds: string[]; block: string }): string => {
  let readings: FeedReading[];
  try {
    readings = decodeFeedBatch(post(s, req.rpc, feedBatchBody(req.feeds, req.block)), req.feeds);
  } catch (e) {
    const m = (e as Error).message;
    readings = req.feeds.map(() => ({ error: m.startsWith('feed RPC:') ? m : 'feed RPC: request failed' }));
  }
  return JSON.stringify(readings);
};

/**
 * Read every feed `wanted` on the HTTP feed chains (feeds on other chains are ignored). Returns readings by
 * `${feedChain}:${feed lowercase}`; a request that fails (or fails consensus) fails its feeds, not the run.
 * HTTP calls per run: per chain with feeds due, 1 (pinned) + ceil(feeds / FEEDS_PER_BATCH); CRE allows 15.
 */
export function httpFeedReadings(
  runtime: Runtime<{ httpFeedChains?: HttpFeedChains }>,
  wanted: FeedRef[],
): Map<string, FeedReading> {
  const out = new Map<string, FeedReading>();
  const chains = runtime.config.httpFeedChains ?? {};
  const byChain = new Map<string, string[]>();
  for (const f of wanted) {
    if (!chains[f.feedChain]) continue;
    const list = byChain.get(f.feedChain) ?? [];
    if (!list.includes(f.feed.toLowerCase())) list.push(f.feed.toLowerCase());
    byChain.set(f.feedChain, list);
  }
  const http = new HTTPClient();
  for (const [name, feeds] of byChain) {
    const c = chains[name];
    let block: string;
    try {
      block =
        c.lagBlocks !== undefined
          ? pinnedBlock(
              http.sendRequest(runtime, headBlock, consensusMedianAggregation<number>())(c.rpc).result(),
              c.lagBlocks,
            )
          : (c.blockTag ?? 'finalized');
    } catch (e) {
      for (const f of feeds)
        out.set(`${name}:${f}`, { error: `feed RPC: no agreed head block (${(e as Error).message})` });
      continue;
    }
    for (let i = 0; i < feeds.length; i += FEEDS_PER_BATCH) {
      const part = feeds.slice(i, i + FEEDS_PER_BATCH);
      let readings: FeedReading[];
      try {
        readings = JSON.parse(
          http
            .sendRequest(
              runtime,
              feedBatch,
              consensusIdenticalAggregation<string>(),
            )({ rpc: c.rpc, feeds: part, block })
            .result(),
        ) as FeedReading[];
      } catch (e) {
        readings = part.map(() => ({ error: `feed RPC: no consensus (${(e as Error).message})` }));
      }
      part.forEach((f, j) => out.set(`${name}:${f}`, readings[j] ?? { error: 'feed RPC: no reading' }));
      runtime.log(`${name}: ${part.length} feed(s) read over HTTP JSON-RPC at block ${block}`);
    }
  }
  return out;
}

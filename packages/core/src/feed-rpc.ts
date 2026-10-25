/**
 * Chainlink feed reads over plain JSON-RPC, for chains where Chainlink CRE has no EVM read capability yet
 * (Robinhood Chain mainnet: the simulator and the DON fail an EVMClient call there). The CRE keeper sends ONE
 * batched JSON-RPC request per chain per run through the HTTP capability: for every feed it needs,
 * eth_call latestRoundData() and decimals() at the configured block tag. Every node decodes the reply into the
 * same plain strings, so the DON reaches identical consensus on the readings, not on raw JSON (ids, ordering
 * and error texts vary between RPC servers). The fallback keeper (services/keeper-fallback) reads the same
 * chains with viem and the same defaults.
 *
 * Pure: no I/O and no Node APIs (bundled into the CRE workflow's WASM).
 */

export type FeedBlockTag = 'finalized' | 'safe' | 'latest';

/**
 * How a feed chain is read: at a block tag, or (lagBlocks) at a block pinned `lagBlocks` below the head. Pinning
 * is what makes the DON's readings identical: the nodes first agree on the head (median), then all read the same
 * block, instead of each reading its own 'latest'.
 */
export interface FeedReadAt {
  blockTag?: FeedBlockTag;
  lagBlocks?: number;
}

/**
 * Feed chains read over HTTP JSON-RPC, by CRE chain-selector name, with their default RPC and how to read them.
 * Robinhood Chain mainnet (chain id 4663) is an Arbitrum Orbit chain making ~10 blocks a second. Its 'finalized'
 * (~15 minutes behind the head) and 'safe' (~13 minutes) blocks are older than the state the public RPC keeps
 * (~9 minutes: "historical state ... is not available", checked 2026-10-24), so it is read 600 blocks (~1 minute)
 * below the head, which the public RPC serves.
 */
export const HTTP_FEED_CHAINS: Record<string, { rpc: string; chainId: number } & FeedReadAt> = {
  'robinhood-mainnet': { rpc: 'https://rpc.mainnet.chain.robinhood.com', chainId: 4663, lagBlocks: 600 },
};

/** The JSON-RPC body asking for the head block number. */
export const blockNumberBody = (): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });

/** The head block number from an eth_blockNumber reply; throws on anything else. */
export function decodeBlockNumber(body: string): number {
  const r = JSON.parse(body) as { result?: unknown; error?: { code?: number } };
  if (typeof r.result !== 'string' || !/^0x[0-9a-fA-F]{1,14}$/.test(r.result)) {
    throw new Error(`feed RPC: eth_blockNumber failed${r.error?.code !== undefined ? ` (code ${r.error.code})` : ''}`);
  }
  return Number(BigInt(r.result));
}

/** The block a pinned read uses: `lagBlocks` below the agreed head, as a JSON-RPC block parameter. */
export const pinnedBlock = (head: number, lagBlocks: number): string =>
  '0x' + Math.max(0, head - lagBlocks).toString(16);

/** latestRoundData() and decimals() selectors. */
export const SELECTOR_LATEST_ROUND = '0xfeaf968c';
export const SELECTOR_DECIMALS = '0x313ce567';

/**
 * Feeds per JSON-RPC batch: 2 calls each, ~0.4 KB of reply per feed (CRE caps an HTTP reply at 250 KB) and ~0.15 KB
 * of decoded reading in the consensus observation (25 KB cap).
 */
export const FEEDS_PER_BATCH = 40;

/** One feed's reading as decimal strings (consensus-safe), or why it could not be read. */
export type FeedReading =
  { roundId: string; answer: string; updatedAt: string; answeredInRound: string; decimals: number } | { error: string };

/**
 * The JSON-RPC batch body for `feeds` (addresses): ids 2i = latestRoundData, 2i+1 = decimals of feeds[i], at a
 * block tag or a 0x-hex block number.
 */
export function feedBatchBody(feeds: readonly string[], blockTag: FeedBlockTag | string): string {
  return JSON.stringify(
    feeds.flatMap((to, i) => [
      { jsonrpc: '2.0', id: 2 * i, method: 'eth_call', params: [{ to, data: SELECTOR_LATEST_ROUND }, blockTag] },
      { jsonrpc: '2.0', id: 2 * i + 1, method: 'eth_call', params: [{ to, data: SELECTOR_DECIMALS }, blockTag] },
    ]),
  );
}

const word = (hex: string, i: number): bigint => BigInt('0x' + (hex.slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'));
const signed = (v: bigint): bigint => (v >= 1n << 255n ? v - (1n << 256n) : v);

/**
 * Decode a JSON-RPC batch reply for `feeds` (same order as feedBatchBody). Replies may come in any order; a
 * missing or failed call fails only its feed. Error texts are reduced to the RPC error code, so every node
 * that saw the same failure reports the same reading.
 */
export function decodeFeedBatch(body: string, feeds: readonly string[]): FeedReading[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return feeds.map(() => ({ error: 'feed RPC: reply is not JSON' }));
  }
  if (!Array.isArray(parsed)) {
    const code = (parsed as { error?: { code?: number } } | null)?.error?.code;
    return feeds.map(() => ({ error: `feed RPC: batch refused${code !== undefined ? ` (code ${code})` : ''}` }));
  }
  const byId = new Map<number, { result?: unknown; error?: { code?: number } }>();
  for (const r of parsed as Array<{ id?: unknown; result?: unknown; error?: { code?: number } }>) {
    if (r && typeof r.id === 'number') byId.set(r.id, r);
  }
  const hexOf = (id: number, words: number): string | { error: string } => {
    const r = byId.get(id);
    if (!r) return { error: 'feed RPC: no reply' };
    if (r.error)
      return { error: `feed RPC: eth_call failed${r.error.code !== undefined ? ` (code ${r.error.code})` : ''}` };
    if (typeof r.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r.result) || r.result.length < 2 + 64 * words) {
      return { error: 'feed RPC: short or malformed result (not a Chainlink feed?)' };
    }
    return r.result;
  };
  return feeds.map((_, i) => {
    const round = hexOf(2 * i, 5);
    if (typeof round !== 'string') return round;
    const dec = hexOf(2 * i + 1, 1);
    if (typeof dec !== 'string') return dec;
    const decimals = word(dec, 0);
    if (decimals > 36n) return { error: `feed RPC: implausible decimals ${decimals}` };
    return {
      roundId: word(round, 0).toString(),
      answer: signed(word(round, 1)).toString(),
      updatedAt: word(round, 3).toString(),
      answeredInRound: word(round, 4).toString(),
      decimals: Number(decimals),
    };
  });
}

/** A reading as checkRound's input; throws the reading's error. */
export function readingToRound(r: FeedReading): {
  round: { roundId: bigint; answer: bigint; updatedAt: bigint; answeredInRound: bigint };
  decimals: number;
} {
  if ('error' in r) throw new Error(r.error);
  return {
    round: {
      roundId: BigInt(r.roundId),
      answer: BigInt(r.answer),
      updatedAt: BigInt(r.updatedAt),
      answeredInRound: BigInt(r.answeredInRound),
    },
    decimals: r.decimals,
  };
}

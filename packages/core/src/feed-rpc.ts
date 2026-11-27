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

/** CRE chain-selector name of BNB Chain mainnet. */
export const BSC_MAINNET_FEED_CHAIN = 'binance_smart_chain-mainnet';

/**
 * A feed reference is a Chainlink-style AggregatorV3 address, or a KEYED feed `0x<address>#<id>`: one price of an
 * Atlas Multi-Feed contract (docs.atlasoracle.io: a registry of many prices keyed by a 4-byte feed id, read with
 * fetch(bytes4)). The id is Atlas's feed number (atlasoracle.io/feeds/<id>).
 */
export const FEED_REF = /^0x[0-9a-fA-F]{40}(#[0-9]{1,9})?$/;
export const keyedFeed = (address: string, id: number): string => `${address}#${id}`;
/** The contract of a feed reference, and its Atlas feed id when it is a keyed one. */
export function parseFeedRef(feed: string): { address: string; atlasId?: number } {
  const [address, id] = feed.split('#');
  return id === undefined ? { address } : { address, atlasId: Number(id) };
}
/** Whether a feed reference is an Atlas Multi-Feed price. */
export const isAtlasFeed = (feed: string): boolean => feed.includes('#');

/** Atlas Multi-Feed fetch(bytes4): (uint80 price, uint48 aggregatedTs, uint48 onchainTs). */
export const SELECTOR_ATLAS_FETCH = '0x7ffc4b97';
/** Calldata of fetch(bytes4 id): the id left-aligned in its word, as the ABI encodes bytesN. */
export const atlasFetchData = (id: number): string =>
  SELECTOR_ATLAS_FETCH + id.toString(16).padStart(8, '0') + '0'.repeat(56);

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
  // BNB Chain mainnet: Atlas's price feeds of Binance's bStocks (products/atlas-feeds.ts). ~0.75 s blocks; the
  // public RPC serves state well past 20 blocks (~15 s) below the head (checked 2026-11-25).
  [BSC_MAINNET_FEED_CHAIN]: { rpc: 'https://bsc-dataseed.bnbchain.org', chainId: 56, lagBlocks: 20 },
};

/**
 * Feed chains Chainlink CRE reads with its EVM read capability (the keeper's EVMClient), by chain-selector name, with
 * a public RPC for the fallback keeper and the catalogue generator. Every feed in the catalogue (FEED_CATALOGUE) lives
 * on one of these or on an HTTP_FEED_CHAINS chain. A CRE target needs an `rpcs` entry for each (cre/project.yaml).
 *
 * Base (docs/BASE-STOCKS.md) is two feed chains, and they price different things:
 *  - Base mainnet (ethereum-mainnet-base-1, the CRE SDK's name for chain 8453): Chainlink's per-token feeds of
 *    Coinbase's B20 stocks ("Coinbase TSLA" …: share price x multiplier). They value TSLAc… COLLATERAL only;
 *    underlyings (strikes, observations) keep the share-price feeds of the catalogue.
 *  - Base Sepolia (ethereum-testnet-sepolia-base-1, also a note chain): the B20MultiplierFeed next to each stand-in,
 *    read at a physically settled note's final observation to deliver shares / multiplier.
 */
export const EVM_FEED_CHAINS: Record<string, { rpc: string; chainId: number }> = {
  'ethereum-mainnet': { rpc: 'https://ethereum-rpc.publicnode.com', chainId: 1 },
  'ethereum-mainnet-arbitrum-1': { rpc: 'https://arbitrum-one-rpc.publicnode.com', chainId: 42161 },
  'ethereum-mainnet-base-1': { rpc: 'https://base-rpc.publicnode.com', chainId: 8453 },
  'ethereum-testnet-sepolia-base-1': { rpc: 'https://base-sepolia-rpc.publicnode.com', chainId: 84532 },
  // BNB Chain testnet (also a note chain): the bStocks stand-ins' BStockMultiplierFeed (collateral prices, delivery).
  'binance_smart_chain-testnet': { rpc: 'https://bsc-testnet-rpc.publicnode.com', chainId: 97 },
};

/**
 * EVM feed chains whose past rounds the keeper can read (a fixing window needs them): CRE reads the latest round with
 * its EVM capability as ever, then ONE JSON-RPC batch of getRoundData over the HTTP capability brings the history
 * (past rounds never change, so every node gets the same reply whatever block it reads at). Ethereum and Arbitrum:
 * where the crypto, forex and gold feeds of the catalogue live. The RPC is EVM_FEED_CHAINS', or the keeper's
 * `historyRpcs` config.
 */
export const HISTORY_FEED_CHAINS: readonly string[] = ['ethereum-mainnet', 'ethereum-mainnet-arbitrum-1'];

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
 * block tag or a 0x-hex block number; then, for each of `tokens` (stock tokens), its four corporate-action reads.
 */
export function feedBatchBody(
  feeds: readonly string[],
  blockTag: FeedBlockTag | string,
  tokens: readonly string[] = [],
): string {
  const base = 2 * feeds.length;
  return JSON.stringify([
    ...feeds.flatMap((feed, i) => {
      const { address: to, atlasId } = parseFeedRef(feed);
      const data = atlasId === undefined ? SELECTOR_LATEST_ROUND : atlasFetchData(atlasId);
      return [
        { jsonrpc: '2.0', id: 2 * i, method: 'eth_call', params: [{ to, data }, blockTag] },
        { jsonrpc: '2.0', id: 2 * i + 1, method: 'eth_call', params: [{ to, data: SELECTOR_DECIMALS }, blockTag] },
      ];
    }),
    // Stock tokens (Robinhood's, ERC-8056): ids base + 4j + k, k in TOKEN_SELECTORS order.
    ...tokens.flatMap((to, j) =>
      TOKEN_SELECTORS.map((data, k) => ({
        jsonrpc: '2.0',
        id: base + 4 * j + k,
        method: 'eth_call',
        params: [{ to, data }, blockTag],
      })),
    ),
  ]);
}

/** uiMultiplier(), newUIMultiplier(), effectiveAt(), oraclePaused(): a stock token's corporate-action state. */
export const TOKEN_SELECTORS = ['0xa60bf13d', '0xdc767007', '0x97a4064f', '0x7706ba52'] as const;

/**
 * A stock token's corporate-action state as decimal strings (consensus-safe), or why it could not be read:
 * the multiplier in effect (shares per token, 18 decimals), the one scheduled (equal to it when none is), when the
 * last or next change takes effect (unix seconds, 0 = never changed), and the issuer's advisory oracle pause.
 */
export type TokenReading =
  { multiplier: string; pending: string; effectiveAt: string; paused: boolean } | { error: string };

/**
 * Decode the token part of a feedBatchBody reply: `nFeeds` feeds came first, then `tokens` in order. A missing or
 * failed call fails only its token, with the same text on every node.
 */
export function decodeTokenBatch(body: string, nFeeds: number, tokens: readonly string[]): TokenReading[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return tokens.map(() => ({ error: 'token RPC: reply is not JSON' }));
  }
  if (!Array.isArray(parsed)) return tokens.map(() => ({ error: 'token RPC: batch refused' }));
  const byId = new Map<number, { result?: unknown; error?: { code?: number } }>();
  for (const r of parsed as Array<{ id?: unknown; result?: unknown; error?: { code?: number } }>) {
    if (r && typeof r.id === 'number') byId.set(r.id, r);
  }
  const base = 2 * nFeeds;
  return tokens.map((_, j) => {
    const words: bigint[] = [];
    for (let k = 0; k < 4; k++) {
      const r = byId.get(base + 4 * j + k);
      if (!r) return { error: 'token RPC: no reply' };
      if (r.error)
        return { error: `token RPC: eth_call failed${r.error.code !== undefined ? ` (code ${r.error.code})` : ''}` };
      if (typeof r.result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.result)) {
        return { error: 'token RPC: malformed result (not a stock token?)' };
      }
      words.push(BigInt(r.result));
    }
    return {
      multiplier: words[0].toString(),
      pending: words[1].toString(),
      effectiveAt: words[2].toString(),
      paused: words[3] !== 0n,
    };
  });
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
  return feeds.map((feed, i) => {
    const atlas = isAtlasFeed(feed);
    const round = hexOf(2 * i, atlas ? 3 : 5);
    if (typeof round !== 'string') return round;
    const dec = hexOf(2 * i + 1, 1);
    if (typeof dec !== 'string') return dec;
    const decimals = word(dec, 0);
    if (decimals > 36n) return { error: `feed RPC: implausible decimals ${decimals}` };
    if (atlas) return atlasReading(word(round, 0), word(round, 1), Number(decimals));
    return {
      roundId: word(round, 0).toString(),
      answer: signed(word(round, 1)).toString(),
      updatedAt: word(round, 3).toString(),
      answeredInRound: word(round, 4).toString(),
      decimals: Number(decimals),
    };
  });
}

/**
 * An Atlas Multi-Feed snapshot as a reading. Atlas keeps the latest price only (no rounds): the round id is the
 * time the price was aggregated off-chain, which is also the time its staleness is measured from (the on-chain
 * write follows it by a second or two). An id Atlas does not publish reads as an empty snapshot.
 */
export function atlasReading(price: bigint, aggregatedTs: bigint, decimals: number): FeedReading {
  if (price === 0n || aggregatedTs === 0n) return { error: 'Atlas feed: empty snapshot (unknown feed id?)' };
  const at = aggregatedTs.toString();
  return { roundId: at, answer: price.toString(), updatedAt: at, answeredInRound: at, decimals };
}

/** getRoundData(uint80). */
export const SELECTOR_GET_ROUND = '0x9a6fc8f5';
/**
 * Past rounds one history request asks for, across its feeds. The public Robinhood Chain RPC refuses bursts much
 * above 60 calls (HTTP 429, measured 2026-11-21), and a run has already spent a few on the prices.
 */
export const ROUND_CALLS_PER_REQUEST = 48;

/** A feed's past rounds to read: `count` of them going back from `fromRound` (a proxy round id, decimal string). */
export interface RoundHistoryRequest {
  feed: string;
  fromRound: string;
  count: number;
}

/**
 * How far back each of `count` rounds is from the latest: the first half one by one (0, 1, 2…: exact in any normal
 * hour, a stock feed writes a few rounds an hour), then 25% further each time, so the same few dozen calls reach
 * thousands of rounds back. A window crowded with rounds (a violent move writes one per 0.5%) is then still covered
 * end to end, sampled, where reading consecutive rounds would see nothing but the move itself.
 */
export function roundOffsets(count: number): number[] {
  const out: number[] = [];
  const dense = Math.ceil(count / 2);
  for (let i = 0; i < count; i++) {
    out.push(i < dense ? i : Math.max(out[i - 1] + 1, Math.round(out[i - 1] * 1.25)));
  }
  return out;
}

/** The round ids a request reads, newest first: never below the first round of the proxy's phase (low 64 bits). */
const roundIds = (r: RoundHistoryRequest): bigint[] => {
  const from = BigInt(r.fromRound);
  const inPhase = from & ((1n << 64n) - 1n);
  return roundOffsets(r.count)
    .filter((o) => BigInt(o) < inPhase)
    .map((o) => from - BigInt(o));
};

/** The JSON-RPC batch body reading past rounds: getRoundData of each request's rounds, ids running on in order. */
export function roundHistoryBody(reqs: readonly RoundHistoryRequest[], blockTag: FeedBlockTag | string): string {
  let id = 0;
  return JSON.stringify(
    reqs.flatMap((r) =>
      roundIds(r).map((round) => ({
        jsonrpc: '2.0',
        id: id++,
        method: 'eth_call',
        params: [{ to: r.feed, data: SELECTOR_GET_ROUND + round.toString(16).padStart(64, '0') }, blockTag],
      })),
    ),
  );
}

/**
 * Decode a roundHistoryBody reply: per request, its rounds newest first as "updatedAt:answer" decimal strings
 * (consensus-safe and compact). A round that is missing, failed or empty is left out; a request with none is an
 * error (the fixing then waits for the next run), and so is a reply that is not a batch (a refused request).
 */
export function decodeRoundHistory(
  body: string,
  reqs: readonly RoundHistoryRequest[],
): Array<{ rounds: string[] } | { error: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return reqs.map(() => ({ error: 'history RPC: reply is not JSON' }));
  }
  if (!Array.isArray(parsed)) {
    const code = (parsed as { error?: { code?: number } } | null)?.error?.code;
    return reqs.map(() => ({ error: `history RPC: batch refused${code !== undefined ? ` (code ${code})` : ''}` }));
  }
  const byId = new Map<number, { result?: unknown }>();
  for (const r of parsed as Array<{ id?: unknown; result?: unknown }>) {
    if (r && typeof r.id === 'number') byId.set(r.id, r);
  }
  let id = 0;
  return reqs.map((req) => {
    const rounds: string[] = [];
    for (let k = roundIds(req).length; k > 0; k--) {
      const hex = byId.get(id++)?.result;
      if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex) || hex.length < 2 + 64 * 5) continue;
      const answer = signed(word(hex, 1));
      const updatedAt = word(hex, 3);
      if (updatedAt !== 0n && answer > 0n) rounds.push(`${updatedAt}:${answer}`);
    }
    return rounds.length ? { rounds } : { error: 'history RPC: no past round could be read' };
  });
}

/** "updatedAt:answer" strings (decodeRoundHistory) as price points. */
export const roundPoints = (rounds: readonly string[]): Array<{ at: number; answer: bigint }> =>
  rounds.map((r) => {
    const [at, answer] = r.split(':');
    return { at: Number(at), answer: BigInt(answer) };
  });

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

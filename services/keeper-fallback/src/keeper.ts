/**
 * The fallback keeper: the CRE workflow's decisions (packages/core keeper.ts), made by a signed Node service
 * for a chain where Chainlink CRE cannot write (Robinhood Chain mainnet today). It submits through
 * FlowEngine.fallbackReport, which only the engine owner's chosen address may call; every report it applies
 * is recorded with that address (ReportProcessed.reporter), so notes show it was not CRE.
 *
 * Same inputs as the CRE workflow: process state from the chain's NotesLens at a chosen block tag, prices
 * from Chainlink feeds (latestRoundData) on the chain each feed lives on, the same staleness rule. A feed chain
 * the CRE workflow reads over HTTP (Robinhood Chain mainnet, HTTP_FEED_CHAINS) is read here at the same block
 * rule: `lagBlocks` below the head, since its public RPC does not keep the finalized block's state.
 */
import {
  ATLAS_API,
  ATLAS_KEY_HEADER,
  ATLAS_PRICE_PATH,
  atlasQualityHolds,
  atlasReading,
  atlasSignedBody,
  checkRound,
  CMC_API,
  CMC_KEY_HEADER,
  CMC_MAX_LOOKBACK,
  CMC_STEP,
  cmcHistoryPath,
  cmcIdOfFeed,
  decodeCmcHistory,
  roundPoints,
  secondSourceHold,
  parseFeedRef,
  readingToRound,
  corporateActionHold,
  feedToFixed,
  ROUND_CALLS_PER_REQUEST,
  roundOffsets,
  stepFixing,
  type PricePoint,
  isRhMultiplierRef,
  rhTokenOfFeed,
  routeFeed,
  tokenMultiplier,
  type DueReport,
  type FeedReadAt,
  type FeedRef,
  type FeedRoutes,
  type TokenReading,
} from '@sn/core';
import { engineAbi, feedAbi, readDue, reportHex } from '@sn/sdk';
import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from 'viem';

export interface FallbackConfig {
  /** The chain the engine is on. */
  chain: {
    name: string;
    client: PublicClient;
    wallet: WalletClient<Transport, Chain, Account>;
    engine: Address;
    lens: Address;
  };
  /** Clients for the chains feeds live on, by CRE chain-selector name (e.g. ethereum-mainnet). */
  feedClients: Record<string, PublicClient>;
  /** Per feed chain: read at a block tag or `lagBlocks` below the head instead of blockTag's rule. */
  feedReadAt?: Record<string, FeedReadAt>;
  blockTag: 'latest' | 'safe' | 'finalized';
  finalityAllowanceSec: number;
  maxReportsPerRun: number;
  gasLimit: bigint;
  feedRoutes?: FeedRoutes;
  /** CoinMarketCap Pro API key: the second source of Atlas prices (never logged). Without it they wait. */
  cmcApiKey?: string;
  /** Atlas API key: its own quality reading of a feed is a control on its price (never logged). Without it, none. */
  atlasApiKey?: string;
  /** For tests: the fetch used for CoinMarketCap and Atlas. */
  fetch?: typeof fetch;
  log: (line: string) => void;
}

const roundAbi = [
  {
    type: 'function',
    name: 'getRoundData',
    stateMutability: 'view',
    inputs: [{ name: 'roundId', type: 'uint80' }],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

/** Atlas Multi-Feed (docs.atlasoracle.io): one price of the registry, by 4-byte feed id. */
const atlasAbi = [
  {
    type: 'function',
    name: 'fetch',
    stateMutability: 'view',
    inputs: [{ name: 'feedId', type: 'bytes4' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'price', type: 'uint80' },
          { name: 'aggregatedTs', type: 'uint48' },
          { name: 'onchainTs', type: 'uint48' },
        ],
      },
    ],
  },
] as const;

const stockTokenAbi = [
  { type: 'function', name: 'uiMultiplier', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'newUIMultiplier', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'effectiveAt', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'oraclePaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

/**
 * A feed's price (engine fixed point) or, with `history`, its latest round checked and its past rounds for the
 * step's windowed fixing (the same rounds as the CRE keeper: roundOffsets back from the latest).
 */
export async function readFeed(cfg: FallbackConfig, f: FeedRef, nowSec: number): Promise<bigint>;
export async function readFeed(
  cfg: FallbackConfig,
  f: FeedRef,
  nowSec: number,
  history: true,
): Promise<{ points: PricePoint[]; decimals: number }>;
export async function readFeed(
  cfg: FallbackConfig,
  f: FeedRef,
  nowSec: number,
  history?: true,
): Promise<bigint | { points: PricePoint[]; decimals: number }> {
  const client = cfg.feedClients[f.feedChain];
  if (!client) throw new Error(`no RPC for feed chain ${f.feedChain}`);
  const at = cfg.feedReadAt?.[f.feedChain];
  const block =
    at?.lagBlocks !== undefined
      ? { blockNumber: (await client.getBlockNumber()) - BigInt(at.lagBlocks) }
      : { blockTag: at?.blockTag ?? (cfg.blockTag === 'latest' ? ('latest' as const) : ('finalized' as const)) };
  // As the CRE keeper: a Robinhood stock token's multiplier is its uiMultiplier(), and both it and the stock's price
  // wait while the issuer processes a corporate action on the token (corporateActionHold).
  const tokenState = async (token: Address): Promise<TokenReading> => {
    const read = (functionName: 'uiMultiplier' | 'newUIMultiplier' | 'effectiveAt' | 'oraclePaused') =>
      client.readContract({ address: token, abi: stockTokenAbi, functionName, ...block });
    try {
      const [multiplier, pending, effectiveAt, paused] = await Promise.all([
        read('uiMultiplier'),
        read('newUIMultiplier'),
        read('effectiveAt'),
        read('oraclePaused'),
      ]);
      return {
        multiplier: String(multiplier),
        pending: String(pending),
        effectiveAt: String(effectiveAt),
        paused: paused === true,
      };
    } catch {
      return { error: 'token RPC: eth_call failed' };
    }
  };
  if (isRhMultiplierRef(f)) return tokenMultiplier(await tokenState(f.feed as Address), nowSec);
  const token = rhTokenOfFeed(f);
  if (token) {
    const hold = corporateActionHold(await tokenState(token as Address), nowSec);
    if (hold) throw new Error(`${f.field}: ${hold}`);
  }
  const ref = parseFeedRef(f.feed);
  if (ref.atlasId !== undefined) {
    // An Atlas Multi-Feed price: the same reading as the CRE keeper decodes (atlasReading), the same staleness rule.
    const snap = await client.readContract({
      address: ref.address as Address,
      abi: atlasAbi,
      functionName: 'fetch',
      args: [`0x${ref.atlasId.toString(16).padStart(8, '0')}`],
      ...block,
    });
    const dec = await client.readContract({
      address: ref.address as Address,
      abi: feedAbi,
      functionName: 'decimals',
      ...block,
    });
    const r = readingToRound(atlasReading(snap.price, BigInt(snap.aggregatedTs), dec));
    const price = checkRound(r.round, r.decimals, nowSec, f.staleness, cfg.finalityAllowanceSec);
    // As the CRE keeper: CoinMarketCap must confirm an Atlas price (secondSourceHold), and its five-minute points
    // are the history of a fixing window (Atlas keeps no past rounds).
    const cmcId = cmcIdOfFeed(f);
    if (cmcId === undefined) throw new Error(`${f.field}: no second source for this Atlas feed`);
    if (!cfg.cmcApiKey) throw new Error(`${f.field}: CoinMarketCap: no API key (CMC_API_KEY or CMC_KEY_FILE)`);
    const from = history ? nowSec - CMC_MAX_LOOKBACK : nowSec - 2 * CMC_STEP;
    let body: string;
    try {
      const res = await (cfg.fetch ?? fetch)(CMC_API + cmcHistoryPath([cmcId], from, nowSec), {
        headers: { [CMC_KEY_HEADER]: cfg.cmcApiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      body = await res.text();
    } catch {
      throw new Error(`${f.field}: CoinMarketCap: request failed`);
    }
    const h = decodeCmcHistory(body, [cmcId], r.decimals)[0];
    if ('error' in h) throw new Error(`${f.field}: ${h.error}`);
    const points = roundPoints(h.rounds);
    const hold = secondSourceHold(r.round.answer, points, nowSec);
    if (hold) throw new Error(`${f.field}: ${hold}`);
    if (cfg.atlasApiKey) {
      // As the CRE keeper: Atlas's own quality reading can hold the price; an unreachable one is skipped.
      try {
        const res = await (cfg.fetch ?? fetch)(ATLAS_API + ATLAS_PRICE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [ATLAS_KEY_HEADER]: cfg.atlasApiKey },
          body: atlasSignedBody([ref.atlasId]),
          signal: AbortSignal.timeout(10_000),
        });
        const quality = atlasQualityHolds(await res.text(), [ref.atlasId])[0];
        if (quality) throw new Error(`${f.field}: ${quality}`);
      } catch (e) {
        if ((e as Error).message.startsWith(`${f.field}:`)) throw e;
        cfg.log(`${f.field}: Atlas quality reading skipped`);
      }
    }
    return history ? { points, decimals: r.decimals } : price;
  }
  const [roundId, answer, , updatedAt, answeredInRound] = await client.readContract({
    address: f.feed as Address,
    abi: feedAbi,
    functionName: 'latestRoundData',
    ...block,
  });
  const decimals = await client.readContract({
    address: f.feed as Address,
    abi: feedAbi,
    functionName: 'decimals',
    ...block,
  });
  const latest = checkRound(
    { roundId, answer, updatedAt, answeredInRound },
    decimals,
    nowSec,
    f.staleness,
    cfg.finalityAllowanceSec,
  );
  if (!history) return latest;
  // The past rounds a fixing window needs, as the CRE keeper reads them (roundOffsets back from the latest, never
  // below the first of the proxy's phase) at the same block.
  const inPhase = roundId & ((1n << 64n) - 1n);
  const ids = roundOffsets(ROUND_CALLS_PER_REQUEST)
    .filter((o) => BigInt(o) < inPhase)
    .map((o) => roundId - BigInt(o));
  const points: PricePoint[] = [];
  for (let i = 0; i < ids.length; i += 12) {
    const rounds = await Promise.all(
      ids.slice(i, i + 12).map((id) =>
        client
          .readContract({
            address: f.feed as Address,
            abi: roundAbi,
            functionName: 'getRoundData',
            args: [id],
            ...block,
          })
          .catch(() => null),
      ),
    );
    for (const r of rounds) if (r && r[3] !== 0n && r[1] > 0n) points.push({ at: Number(r[3]), answer: r[1] });
  }
  if (!points.length) throw new Error(`${f.field}: no past round could be read (fixing window)`);
  return { points, decimals };
}

export interface RunResult {
  due: number;
  written: string[];
  failed: string[];
}

/** One pass: what is due on the chain, observed and submitted. */
export async function runOnce(cfg: FallbackConfig, nowSec = Math.floor(Date.now() / 1000)): Promise<RunResult> {
  const c = cfg.chain;
  const reporter = await c.client.readContract({ address: c.engine, abi: engineAbi, functionName: 'fallbackReporter' });
  if (reporter.toLowerCase() !== c.wallet.account.address.toLowerCase()) {
    throw new Error(
      `${c.name}: this key (${c.wallet.account.address}) is not the engine's fallback reporter (${reporter})`,
    );
  }
  const { due, running, unpublished } = await readDue(
    { client: c.client, lens: c.lens, blockTag: cfg.blockTag },
    nowSec,
  );
  cfg.log(
    `${c.name}: ${running} running, ${due.length} report(s) due${unpublished.length ? `, ${unpublished.length} definition(s) not on the lens` : ''}`,
  );
  const prices = new Map<string, bigint>();
  const price = async (f: FeedRef) => {
    const k = `${f.feedChain}:${f.feed.toLowerCase()}:${f.staleness}`;
    if (!prices.has(k)) prices.set(k, await readFeed(cfg, f, nowSec));
    return prices.get(k)!;
  };
  const written: string[] = [],
    failed: string[] = [];
  for (const d of due.slice(0, cfg.maxReportsPerRun) as DueReport[]) {
    const tag = `${c.name} pid ${d.process} ${d.stepId}`;
    try {
      const feeds = d.feeds.map((f) => routeFeed(f, cfg.feedRoutes));
      // The step's windowed feeds are fixed over one window, as the CRE keeper does (stepFixing): ending at the
      // step's date, postponed together by the disruption rule.
      const windowed = feeds.filter((f) => f.window && !isRhMultiplierRef(f));
      const fixes = new Map<FeedRef, bigint>();
      if (windowed.length) {
        const hs: Array<{ points: PricePoint[]; decimals: number }> = [];
        for (const f of windowed) hs.push(await readFeed(cfg, f, nowSec, true));
        const fx = stepFixing(
          hs.map((h) => h.points),
          {
            window: Math.max(...windowed.map((f) => f.window!)),
            nowSec,
            dueAt: d.at,
            disruptionBps: windowed.find((f) => f.disruption)?.disruption,
          },
        );
        if ('wait' in fx) {
          cfg.log(`${tag} -> waits: ${fx.wait}`);
          continue;
        }
        windowed.forEach((f, i) => fixes.set(f, feedToFixed(fx.answers[i], hs[i].decimals)));
      }
      const values: bigint[] = [];
      for (const f of feeds) values.push(fixes.get(f) ?? (await price(f)));
      const hash = await c.wallet.writeContract({
        address: c.engine,
        abi: engineAbi,
        functionName: 'fallbackReport',
        args: [reportHex(d, values)],
        gas: cfg.gasLimit,
      });
      const receipt = await c.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`reverted (${hash})`);
      cfg.log(`${tag} [${values.join(',')}] -> written ${hash} (gas ${receipt.gasUsed})`);
      written.push(tag);
    } catch (e) {
      cfg.log(`${tag} -> failed: ${(e as Error).message.split('\n')[0]}`);
      failed.push(tag);
    }
  }
  return { due: due.length, written, failed };
}

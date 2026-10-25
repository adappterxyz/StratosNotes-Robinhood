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
import { checkRound, routeFeed, type DueReport, type FeedReadAt, type FeedRef, type FeedRoutes } from '@sn/core';
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
  log: (line: string) => void;
}

export async function readFeed(cfg: FallbackConfig, f: FeedRef, nowSec: number): Promise<bigint> {
  const client = cfg.feedClients[f.feedChain];
  if (!client) throw new Error(`no RPC for feed chain ${f.feedChain}`);
  const at = cfg.feedReadAt?.[f.feedChain];
  const block =
    at?.lagBlocks !== undefined
      ? { blockNumber: (await client.getBlockNumber()) - BigInt(at.lagBlocks) }
      : { blockTag: at?.blockTag ?? (cfg.blockTag === 'latest' ? ('latest' as const) : ('finalized' as const)) };
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
  return checkRound(
    { roundId, answer, updatedAt, answeredInRound },
    decimals,
    nowSec,
    f.staleness,
    cfg.finalityAllowanceSec,
  );
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
      const values: bigint[] = [];
      for (const f of d.feeds) values.push(await price(routeFeed(f, cfg.feedRoutes)));
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

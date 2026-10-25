/**
 * The Worker's cron: index every configured chain into D1, then send due notifications, within one invocation's
 * budgets.
 *
 * Budgets (one cron invocation): Workers allow 1,000 D1 queries (each batch statement counts), 1,000
 * subrequests on the paid plan (50 on free; every JSON-RPC call is one) and 30 s of CPU by default. The cron
 * spends conservatively from those and stops early; whatever is left is picked up next minute, because the
 * cursor only moves when a batch commits.
 */
import { createPublicClient, http, type PublicClient } from 'viem';
import { evmSource, type ChainSource } from '@sn/indexer/src/source';
import { indexerChains, type EdgeConfig } from './config';
import type { Store } from './d1';
import { D1Ingestor, DEFAULT_LIMITS, type ChainConfig, type StepResult } from './ingest';
import type { EmailSender } from '@sn/notifier';
import { notifierTick, type TickResult } from './notify';

export interface CronBudget {
  /** D1 queries this invocation may use (the platform limit is 1,000 on paid). */
  queries: number;
  /** JSON-RPC calls this invocation may make (subrequests: 1,000 on paid, 50 on free). */
  rpcCalls: number;
  /** Wall time to stop starting new steps after, ms. */
  wallMs: number;
}
export const DEFAULT_BUDGET: CronBudget = { queries: 800, rpcCalls: 700, wallMs: 20_000 };

/** Upper bound on the RPC calls and D1 queries one ingest step can make, so a step never starts past the budget. */
const STEP_RPC_MAX = 8 + DEFAULT_LIMITS.maxEvents; // head/finalized, cursor block, logs, one per block with events, definitions
const STEP_QUERY_MAX = 12 + DEFAULT_LIMITS.maxNotes * 8 + Math.ceil(DEFAULT_LIMITS.maxEvents / 11) + 10;

export class CountedSource implements ChainSource {
  calls = 0;
  constructor(private readonly src: ChainSource) {}
  private n<T>(p: Promise<T>) {
    this.calls++;
    return p;
  }
  head() {
    return this.n(this.src.head());
  }
  finalized() {
    return this.n(this.src.finalized());
  }
  block(n: bigint) {
    return this.n(this.src.block(n));
  }
  logs(from: bigint, to: bigint) {
    return this.n(this.src.logs(from, to));
  }
  definitionCore(id: string) {
    return this.n(this.src.definitionCore(id));
  }
  fallbackReporterAt(block: bigint) {
    return this.n(this.src.fallbackReporterAt(block));
  }
}

/** A JSON-RPC source for the Worker: one retry, a short timeout (the cron retries next minute anyway). */
export function workerSource(c: ChainConfig): ChainSource {
  const client = createPublicClient({ transport: http(c.rpc, { retryCount: 1, timeout: 10_000 }) }) as PublicClient;
  return evmSource(c.rpc, c.engine, client);
}

export interface CronReport {
  chains: Array<{ chain: string; engine: string; steps: StepResult[]; error?: string; rpcCalls: number }>;
  queries: number;
  sent: number;
  /** The notifier pass (null when it did not run: out of budget, or disabled). */
  notify: TickResult | null;
  ms: number;
}

export async function runCron(opts: {
  store: Store;
  config: EdgeConfig;
  source?: (c: ChainConfig) => ChainSource;
  /** Email Service sender; null keeps queued emails pending. */
  sender?: EmailSender | null;
  /** Public origin for links in emails. */
  siteUrl?: string;
  /** Chain key -> display name, for emails. */
  chainLabel?: (key: string) => string;
  budget?: Partial<CronBudget>;
  now?: () => number;
}): Promise<CronReport> {
  const budget = { ...DEFAULT_BUDGET, ...opts.budget };
  const t0 = Date.now();
  const chains = indexerChains(opts.config);
  const report: CronReport = { chains: [], queries: 0, sent: 0, notify: null, ms: 0 };
  let rpc = 0;
  // Share the budget fairly: every chain gets a turn each round, so one busy chain cannot starve the others.
  const ingestors = chains.map((c) => ({
    c,
    src: new CountedSource((opts.source ?? workerSource)(c)),
    steps: [] as StepResult[],
    done: false,
    error: undefined as string | undefined,
  }));
  for (const x of ingestors) {
    try {
      await new D1Ingestor(opts.store, x.c, x.src).init();
    } catch (e) {
      x.error = e instanceof Error ? e.message : String(e);
      x.done = true;
    }
  }
  const left = () =>
    Date.now() - t0 < budget.wallMs &&
    opts.store.queries + STEP_QUERY_MAX < budget.queries &&
    rpc + STEP_RPC_MAX < budget.rpcCalls;
  while (ingestors.some((x) => !x.done) && left()) {
    for (const x of ingestors) {
      if (x.done || !left()) continue;
      const before = x.src.calls;
      try {
        const r = await new D1Ingestor(opts.store, x.c, x.src).step();
        x.steps.push(r);
        if (r.idle) x.done = true;
      } catch (e) {
        x.error = e instanceof Error ? e.message : String(e);
        x.done = true; // try again next minute
      }
      rpc += x.src.calls - before;
    }
  }
  for (const x of ingestors)
    report.chains.push({
      chain: x.c.indexKey ?? x.c.key,
      engine: x.c.engine.toLowerCase(),
      steps: x.steps,
      error: x.error,
      rpcCalls: x.src.calls,
    });

  // Housekeeping: live-update rows older than a day, expired rate-limit windows.
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  if (opts.store.queries + 4 < budget.queries) {
    await opts.store.run('DELETE FROM changes WHERE at < ?1', [now - 86_400]);
    await opts.store.run('DELETE FROM rate_limits WHERE window_start < ?1', [now - 7_200]);
  }
  // The notifier: plan recently active notes, queue emails for verified addresses, send what is due. It needs
  // room for a handful of queries per note plus the sends; with less left it runs next minute.
  if (opts.store.queries + 250 < budget.queries) {
    try {
      report.notify = await notifierTick(opts.store, {
        sender: opts.sender ?? null,
        siteUrl: opts.siteUrl ?? 'https://notes.markets',
        now,
        chainLabel: opts.chainLabel ?? ((k) => k),
      });
      report.sent = report.notify.sent ?? 0;
    } catch (e) {
      console.error('notifier', e instanceof Error ? e.message : e);
    }
  }
  report.queries = opts.store.queries;
  report.ms = Date.now() - t0;
  return report;
}

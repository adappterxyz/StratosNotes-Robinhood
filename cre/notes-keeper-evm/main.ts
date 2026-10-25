// StratosNotes keeper (EVM): one Chainlink CRE workflow that is the calculation agent for EVERY note on every
// configured EVM chain: Robinhood Chain testnet, where notes run.
//
// Each cron run, per chain:
//  1. Reads every running process through the chain's NotesLens at the last FINALIZED block (one call), and
//     each distinct definition's full bytes (the oracle feeds live in its metadata).
//  2. Decides what is due with the shared keeper logic (packages/core/src/keeper.ts): a strike fixing or an
//     observation whose date has come, or a plain timer to advance.
//  3. For each due oracle step, reads the Chainlink price feed of every underlying it captures (one for a
//     single-asset note, several for a worst-of basket), on the chain the feed lives on, at a finalized block,
//     staleness-checked against the feed's heartbeat. A feed chain CRE has no EVM read capability for
//     (Robinhood Chain mainnet, the stock tokens' native chain) is read over the HTTP capability instead: one
//     batched JSON-RPC eth_call request per chain per run, every node decoding it to the same readings
//     (httpFeedChains, packages/core/src/feed-rpc.ts).
//  4. Writes a DON-signed report to the chain's FlowEngine through the KeystoneForwarder:
//     abi.encode(uint256 pid, uint16 step, int256[] values). The engine bounds-checks every value, runs the
//     step and everything after it that needs nobody (coupons, autocall, redemption) in that transaction.
//  5. Cross-chain auto-release (planned, HomeGateway v2, docs/CROSS-CHAIN.md; off while `gateways` is empty): reads each home chain's
//     gateway queue (one call) and, when releases wait and the fee pool pays for them, writes a flush report
//     abi.encode(uint8 1, uint256 maxItems) to the gateway, which sends them over CCIP. Counts as a report.
import {
  bytesToHex,
  CronCapability,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  prepareReportRequest,
  Runner,
  TxStatus,
  type Runtime,
} from '@chainlink/cre-sdk';
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { decodeEvmDef, encodeEvmReport } from '../../packages/core/src/compile-evm';
import { checkRound, dueReports, routeFeed, type DueReport, type FeedRef } from '../../packages/core/src/keeper';
import {
  collateralShortfalls,
  describeFlush,
  encodeFlushReport,
  erc20ReadAbi,
  planFlush,
  releaseQueueAbi,
  releaseQueueReading,
  remoteVaultAbi,
  type VaultReading,
} from '../../packages/core/src/crosschain';
import type { WorkflowDef } from '../../packages/core/src/def-types';
import { readingToRound } from '../../packages/core/src/feed-rpc';
import { feedAbi, lensAbi } from '../../packages/sdk/src/evm/abi';
import { hexToBytes, snapshotToState } from '../../packages/sdk/src/evm/state';
import { httpFeedChainsSchema, httpFeedReadings } from './http-feeds';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/** An engine or lens: the zero address means "not deployed yet" and fails the config, closed. */
const deployed = address.refine(
  (a) => !/^0x0{40}$/.test(a),
  'not deployed yet (zero address): run scripts/cre-config.ts after deploying',
);

const configSchema = z.object({
  /** 6-field cron, e.g. "0 * * * * *" = every minute. */
  schedule: z.string(),
  chains: z
    .array(
      z.object({
        /** CRE chain-selector name, e.g. robinhood-testnet. */
        chainSelectorName: z.string(),
        engine: deployed,
        lens: deployed,
        /** Gas for one report: a coupon to a full book (62 holders) needs ~2.3M of execution, plus L1 data gas (Orbit chain). */
        gasLimit: z.string().regex(/^\d+$/),
        /** First pid to scan (skip finished history) and how many pids one lens call scans / returns. */
        fromPid: z.number().int().positive(),
        scan: z.number().int().positive(),
        maxProcesses: z.number().int().positive(),
        /**
         * Block to read the engine at. 'finalized' (default) needs an RPC that serves recent historical state; public
         * testnet RPCs (Robinhood Chain testnet) refuse it, so they read 'latest'. Safe either way: the engine re-checks
         * on-chain that a step is due before it applies a report. Feeds are always read at a finalized block.
         */
        stateBlock: z.enum(['finalized', 'latest']).optional(),
      }),
    )
    .min(1),
  /** Reports written per run across all chains (each is one transaction). */
  maxReportsPerRun: z.number().int().positive(),
  /** Feeds are read at a finalized block, which lags the head: allowed on top of each feed's heartbeat. */
  finalityAllowanceSec: z.number().int().nonnegative(),
  /** Optional: send a recorded feed (lowercase address) to another source, e.g. a chain's own feeds. */
  feedRoutes: z
    .record(z.object({ feed: address, feedChain: z.string(), staleness: z.number().int().positive().optional() }))
    .optional(),
  /**
   * Optional: feed chains read over the HTTP capability (JSON-RPC eth_call) because CRE has no EVM read capability
   * for them, by chain-selector name, e.g. { "robinhood-mainnet": { "rpc": "https://rpc.mainnet.chain.robinhood.com",
   * "blockTag": "safe" } }. One batched request per chain per run. blockTag defaults to 'finalized'; use 'safe' where
   * the RPC does not keep the finalized block's state.
   */
  httpFeedChains: httpFeedChainsSchema.optional(),
  /**
   * Optional: cross-chain collateral (planned; none configured today). For each vault on a remote asset chain and
   * its receipt on the home chain (Robinhood Chain), check every run that the vault still backs the receipts (packages/core/src/crosschain.ts).
   */
  /**
   * Optional: auto-release gateways (HomeGateway v2), one per home chain. Each run reads the release queue (one
   * call; 'latest' by default, the gateway re-checks everything) and, when planFlush says so, writes a flush report
   * to the gateway. A flush counts against maxReportsPerRun. Gas: baseGas + gasPerItem x releases; maxItems caps
   * one report (the gateway sends at most 25).
   */
  gateways: z
    .array(
      z.object({
        chainSelectorName: z.string(),
        gateway: deployed,
        maxItems: z.number().int().min(1).max(25).optional(),
        baseGas: z.string().regex(/^\d+$/).optional(),
        gasPerItem: z.string().regex(/^\d+$/).optional(),
        stateBlock: z.enum(['finalized', 'latest']).optional(),
      }),
    )
    .optional(),
  vaults: z
    .array(
      z.object({
        homeChain: z.string(),
        receipt: address,
        assetChain: z.string(),
        vault: address,
        token: address,
        label: z.string().optional(),
        stateBlock: z.enum(['finalized', 'latest']).optional(),
      }),
    )
    .optional(),
});
type Config = z.infer<typeof configSchema>;
type ChainConfig = Config['chains'][number];

function client(name: string): EVMClient {
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: name });
  if (!network) throw new Error(`unknown chain-selector name: ${name}`);
  return new EVMClient(network.chainSelector.selector);
}

/**
 * Chain reads this run. CRE caps EVM reads per workflow run (PerWorkflow.ChainRead.CallLimit, 15 in the
 * simulator), so optional checks (vault backing) only spend what the reports leave.
 */
const READ_LIMIT = 15;
let readsThisRun = 0;
/** One view call, at the last finalized block unless `at` is 'latest'; returns the raw result. */
function view(
  runtime: Runtime<Config>,
  evm: EVMClient,
  to: string,
  data: Hex,
  at: 'finalized' | 'latest' = 'finalized',
): Hex {
  readsThisRun++;
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: to as Address, data }),
      blockNumber: at === 'latest' ? LATEST_BLOCK_NUMBER : LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  return bytesToHex(reply.data);
}

/** What is due on one chain: running processes from the lens, their definitions, the shared keeper logic. */
function dueOn(runtime: Runtime<Config>, chain: ChainConfig, nowSec: number): DueReport[] {
  const evm = client(chain.chainSelectorName);
  const out: DueReport[] = [];
  const defs = new Map<string, WorkflowDef | null>();
  let from = BigInt(chain.fromPid);
  for (let page = 0; page < 4; page++) {
    const raw = view(
      runtime,
      evm,
      chain.lens,
      encodeFunctionData({
        abi: lensAbi,
        functionName: 'running',
        args: [from, BigInt(chain.scan), BigInt(chain.maxProcesses)],
      }),
      chain.stateBlock ?? 'finalized',
    );
    const [snaps, next] = decodeFunctionResult({ abi: lensAbi, functionName: 'running', data: raw });
    for (const s of snaps) {
      const p = snapshotToState({ ...s, tokens: s.tokens, values: s.values, balances: s.balances });
      if (!defs.has(p.definition)) {
        const bytes = decodeFunctionResult({
          abi: lensAbi,
          functionName: 'definitionBytes',
          data: view(
            runtime,
            evm,
            chain.lens,
            encodeFunctionData({ abi: lensAbi, functionName: 'definitionBytes', args: [p.definition as Hex] }),
            chain.stateBlock ?? 'finalized',
          ),
        });
        defs.set(p.definition, bytes === '0x' ? null : decodeEvmDef(hexToBytes(bytes)));
      }
      const def = defs.get(p.definition);
      if (!def) {
        runtime.log(
          `${chain.chainSelectorName} pid ${p.id}: definition ${p.definition} not published on the lens; skipped`,
        );
        continue;
      }
      out.push(...dueReports(p, def, nowSec));
    }
    if (next === 0n) break;
    from = next;
  }
  return out;
}

/** A Chainlink feed's latest answer as engine fixed point (10 decimals), finalized block, staleness-checked. */
function readFeed(runtime: Runtime<Config>, f: FeedRef, nowSec: number): bigint {
  const evm = client(f.feedChain);
  const [roundId, answer, , updatedAt, answeredInRound] = decodeFunctionResult({
    abi: feedAbi,
    functionName: 'latestRoundData',
    data: view(runtime, evm, f.feed, encodeFunctionData({ abi: feedAbi, functionName: 'latestRoundData' })),
  });
  const decimals = decodeFunctionResult({
    abi: feedAbi,
    functionName: 'decimals',
    data: view(runtime, evm, f.feed, encodeFunctionData({ abi: feedAbi, functionName: 'decimals' })),
  });
  return checkRound(
    { roundId, answer, updatedAt, answeredInRound },
    decimals,
    nowSec,
    f.staleness,
    runtime.config.finalityAllowanceSec,
  );
}

export const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const nowSec = Math.floor(runtime.now().getTime() / 1000);
  readsThisRun = 0;
  const written: string[] = [];
  const failed: string[] = [];
  let due = 0;
  let budget = cfg.maxReportsPerRun;
  // What is due everywhere first, so feeds on the HTTP feed chains can be read in one request per chain.
  const work: Array<{ chain: ChainConfig; d: DueReport; feeds: FeedRef[] }> = [];
  for (const chain of cfg.chains) {
    const reports = dueOn(runtime, chain, nowSec);
    due += reports.length;
    runtime.log(`${chain.chainSelectorName}: ${reports.length} report(s) due`);
    for (const d of reports) {
      if (budget <= 0) break;
      budget--;
      work.push({ chain, d, feeds: d.feeds.map((f) => routeFeed(f, cfg.feedRoutes)) });
    }
  }
  const httpReadings = httpFeedReadings(
    runtime,
    work.flatMap((w) => w.feeds),
  );
  // A basket reads one feed per underlying; read each feed at most once per run, whatever needs it.
  const prices = new Map<string, bigint>();
  const price = (f: FeedRef) => {
    const k = `${f.feedChain}:${f.feed.toLowerCase()}:${f.staleness}`;
    if (!prices.has(k)) {
      const reading = httpReadings.get(`${f.feedChain}:${f.feed.toLowerCase()}`);
      if (reading) {
        const { round, decimals } = readingToRound(reading);
        prices.set(k, checkRound(round, decimals, nowSec, f.staleness, cfg.finalityAllowanceSec));
      } else {
        prices.set(k, readFeed(runtime, f, nowSec));
      }
    }
    return prices.get(k)!;
  };
  for (const { chain, d, feeds } of work) {
    const evm = client(chain.chainSelectorName);
    const tag = `${chain.chainSelectorName} pid ${d.process} ${d.stepId}`;
    let values: bigint[];
    try {
      values = feeds.map(price);
    } catch (e) {
      runtime.log(`${tag} -> skipped: ${(e as Error).message}`);
      failed.push(tag);
      continue;
    }
    const report = runtime
      .report(prepareReportRequest(bytesToHex(encodeEvmReport(BigInt(d.process), d.step, values))))
      .result();
    const resp = evm
      .writeReport(runtime, { receiver: chain.engine, report, gasConfig: { gasLimit: chain.gasLimit } })
      .result();
    const done = resp.txStatus === TxStatus.SUCCESS && !!resp.txHash && resp.txHash.length > 0;
    runtime.log(
      `${tag} [${values.join(',')}] -> ${done ? `written ${bytesToHex(resp.txHash!)}` : `failed: ${resp.errorMessage || resp.txStatus}`}`,
    );
    (done ? written : failed).push(tag);
  }
  // Auto-release: flush each home chain's gateway queue when releases wait and the fee pool can pay for them.
  // One read per gateway; the write counts as a report. Engine reports go first: they are due at a date.
  const flushed: string[] = [];
  for (const g of cfg.gateways ?? []) {
    const tag = g.chainSelectorName;
    if (readsThisRun >= READ_LIMIT) {
      runtime.log(`${tag} gateway flush: skipped (no chain reads left this run)`);
      continue;
    }
    const evm = client(g.chainSelectorName);
    let reading;
    try {
      reading = releaseQueueReading(
        decodeFunctionResult({
          abi: releaseQueueAbi,
          functionName: 'releaseQueue',
          data: view(
            runtime,
            evm,
            g.gateway,
            encodeFunctionData({ abi: releaseQueueAbi, functionName: 'releaseQueue' }),
            g.stateBlock ?? 'latest',
          ),
        }),
      );
    } catch (e) {
      runtime.log(`${tag} gateway flush: queue read failed: ${(e as Error).message}`);
      failed.push(`${tag} gateway flush`);
      continue;
    }
    const plan = planFlush(reading, {
      maxItems: g.maxItems,
      baseGas: g.baseGas !== undefined ? BigInt(g.baseGas) : undefined,
      gasPerItem: g.gasPerItem !== undefined ? BigInt(g.gasPerItem) : undefined,
    });
    if (plan.flush && budget <= 0) {
      runtime.log(`${describeFlush(tag, reading, plan)}: deferred (maxReportsPerRun reached)`);
      continue;
    }
    runtime.log(describeFlush(tag, reading, plan));
    if (!plan.flush) continue;
    budget--;
    const report = runtime.report(prepareReportRequest(encodeFlushReport(plan.maxItems))).result();
    const resp = evm
      .writeReport(runtime, { receiver: g.gateway, report, gasConfig: { gasLimit: plan.gasLimit.toString() } })
      .result();
    const done = resp.txStatus === TxStatus.SUCCESS && !!resp.txHash && resp.txHash.length > 0;
    const ftag = `${tag} gateway flush ${plan.maxItems}`;
    runtime.log(
      `${ftag} -> ${done ? `written ${bytesToHex(resp.txHash!)}` : `failed: ${resp.errorMessage || resp.txStatus}`}`,
    );
    (done ? flushed : failed).push(ftag);
  }
  // Cross-chain collateral: does every vault still back the receipts outstanding at home?
  // Four reads per vault, within what this run has left; a rotating start so every vault is checked in turn.
  const readings: VaultReading[] = [];
  const all = cfg.vaults ?? [];
  const fit = Math.max(0, Math.floor((READ_LIMIT - readsThisRun) / 4));
  const start = all.length ? Math.floor(nowSec / 60) % all.length : 0;
  const turn = Array.from({ length: Math.min(fit, all.length) }, (_, i) => all[(start + i) % all.length]);
  for (const w of turn) {
    const at = w.stateBlock ?? 'finalized';
    const asset = client(w.assetChain);
    const home = client(w.homeChain);
    const num = (
      evm: EVMClient,
      to: string,
      abi: typeof remoteVaultAbi | typeof erc20ReadAbi,
      functionName: string,
      args: unknown[],
    ) =>
      decodeFunctionResult({
        abi,
        functionName,
        data: view(runtime, evm, to, encodeFunctionData({ abi, functionName, args } as never), at),
      } as never) as unknown as bigint;
    readings.push({
      watch: w,
      locked: num(asset, w.vault, remoteVaultAbi, 'locked', [w.token]),
      unclaimedTotal: num(asset, w.vault, remoteVaultAbi, 'unclaimedTotal', [w.token]),
      vaultBalance: num(asset, w.token, erc20ReadAbi, 'balanceOf', [w.vault]),
      receiptsOutstanding: num(home, w.receipt, erc20ReadAbi, 'totalSupply', []),
    });
  }
  const shortfalls = collateralShortfalls(readings).map(
    (s) => `${s.watch.label ?? s.watch.token} ${s.kind} missing ${s.missing}`,
  );
  for (const s of shortfalls) runtime.log(`[collateral shortfall] ${s}`);
  return JSON.stringify({
    due,
    written,
    failed,
    ...(cfg.gateways?.length ? { flushed } : {}),
    ...(cfg.vaults?.length ? { vaults: readings.length, shortfalls } : {}),
  });
};

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCron),
];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();

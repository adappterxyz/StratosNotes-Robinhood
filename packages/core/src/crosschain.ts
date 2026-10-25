/**
 * Cross-chain collateral (planned, docs/CROSS-CHAIN.md): a note runs on its home chain (Robinhood Chain) while
 * collateral stays locked in a RemoteVault on another chain. The home side holds RemoteReceipts, which the engine
 * treats as ordinary collateral. Nothing is deployed yet: the keeper's `gateways` and `vaults` are empty, so none of
 * this runs. The mechanism was proven live in the earlier Arbitrum build (home Arbitrum Sepolia, vault on Robinhood
 * Chain); the gas figures below were measured there. The keeper (CRE) checks every run that each vault still backs its receipts:
 *
 *   vault backing   = token.balanceOf(vault) - unclaimedTotal(token)   (what the vault can still pay)
 *   vault liability = locked(token)                                     (receipts outstanding + releases in flight)
 *   receipts        = receipt.totalSupply() at home
 *
 * In-flight messages only ever make `locked` exceed `receipts` (a lock not yet credited at home, a redemption
 * burned at home not yet paid on the asset chain, or an auto-release burned at home and still queued at the
 * gateway), never the reverse, so:
 *   - backing < locked     -> the token took tokens back from the vault (paused, frozen, clawed back);
 *   - receipts > locked    -> receipts exist that the vault does not account for (must never happen).
 * Both are reported as shortfalls; the first one also makes the note's coverage overstated, so the app and the
 * keeper surface it next to the note's margin.
 */
export interface VaultWatch {
  /** Home chain (CRE chain-selector name) and its receipt contract. */
  homeChain: string;
  receipt: string;
  /** Asset chain (CRE chain-selector name), the vault there and the locked token. */
  assetChain: string;
  vault: string;
  token: string;
  /** Label for logs, e.g. "USDC on Ethereum". */
  label?: string;
}

export interface VaultReading {
  watch: VaultWatch;
  locked: bigint;
  unclaimedTotal: bigint;
  vaultBalance: bigint;
  receiptsOutstanding: bigint;
}

export type ShortfallKind = 'vault-backing' | 'receipts-exceed-locked';

export interface Shortfall {
  watch: VaultWatch;
  kind: ShortfallKind;
  /** Base units of the token missing. */
  missing: bigint;
}

export function collateralShortfalls(readings: VaultReading[]): Shortfall[] {
  const out: Shortfall[] = [];
  for (const r of readings) {
    const backing = r.vaultBalance - r.unclaimedTotal;
    if (backing < r.locked) out.push({ watch: r.watch, kind: 'vault-backing', missing: r.locked - backing });
    if (r.receiptsOutstanding > r.locked)
      out.push({ watch: r.watch, kind: 'receipts-exceed-locked', missing: r.receiptsOutstanding - r.locked });
  }
  return out;
}

/** The ABI fragments the keeper reads (RemoteVault on the asset chain, RemoteReceipt at home). */
export const remoteVaultAbi = [
  {
    type: 'function',
    name: 'locked',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'unclaimedTotal',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const erc20ReadAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

// ---- Auto-release (HomeGateway v2): the queue the keeper flushes ----------------------------------------------

/**
 * Receipts leaving the engine (payouts after a default, the issuer's collateral at maturity, any withdraw or push)
 * are burned and queued at the HomeGateway as RELEASEs to the same address on the asset chain. Anyone may flush the
 * queue (fees from the gateway's ETH pool); the CRE keeper does it with a report. Its per-run read and write:
 *
 *   read   HomeGateway.releaseQueue() -> (pending, head, queued, pool, nextFee)        one call, home chain
 *   write  report abi.encode(uint8 kind = 1, uint256 maxItems) to the gateway           receiver = the gateway
 *          (onReport through the KeystoneForwarder; the gateway checks the forwarder like the engine does)
 *
 * The report never reverts on an empty queue, an empty pool or a pause; it sends at most 25 releases.
 */
export const releaseQueueAbi = [
  {
    type: 'function',
    name: 'releaseQueue',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'pending', type: 'uint256' },
      { name: 'head', type: 'uint256' },
      { name: 'queued', type: 'uint256' },
      { name: 'pool', type: 'uint256' },
      { name: 'nextFee', type: 'uint256' },
    ],
  },
] as const;

/** Report kind: flush queued releases. */
export const REPORT_FLUSH = 1;
/** The gateway sends at most this many per flush. */
export const MAX_FLUSH = 25;

export interface ReleaseQueueReading {
  pending: bigint;
  head: bigint;
  queued: bigint;
  pool: bigint;
  nextFee: bigint;
}

export interface FlushPlan {
  flush: boolean;
  /** Releases to ask for in the report. */
  maxItems: number;
  /** Gas for the report's transaction (base + per release). */
  gasLimit: bigint;
  /** Why not, when flush is false (for logs). */
  reason?: 'empty' | 'pool-short' | 'no-vault';
}

/**
 * Whether the keeper should write a flush report this run, and how big. `nextFee` is the fee of the oldest release
 * waiting; 0 with something pending means its chain has no vault configured (an operator issue: logged, no write).
 * Gas: about 60k of report overhead plus one CCIP send per release (~200k on Arbitrum Sepolia's router, with margin).
 */
export function planFlush(
  q: ReleaseQueueReading,
  opts: { maxItems?: number; baseGas?: bigint; gasPerItem?: bigint } = {},
): FlushPlan {
  const cap = Math.max(1, Math.min(opts.maxItems ?? 10, MAX_FLUSH));
  const base = opts.baseGas ?? 150_000n;
  const per = opts.gasPerItem ?? 300_000n;
  if (q.pending === 0n) return { flush: false, maxItems: 0, gasLimit: 0n, reason: 'empty' };
  if (q.nextFee === 0n) return { flush: false, maxItems: 0, gasLimit: 0n, reason: 'no-vault' };
  if (q.pool < q.nextFee) return { flush: false, maxItems: 0, gasLimit: 0n, reason: 'pool-short' };
  // Fees are close to equal per message: send what the pool can pay for, within the cap.
  const affordable = q.pool / q.nextFee;
  const n = Number([q.pending, affordable, BigInt(cap)].reduce((a, b) => (a < b ? a : b)));
  return { flush: true, maxItems: n, gasLimit: base + per * BigInt(n) };
}

/** `releaseQueue()`'s decoded outputs, in order, as a reading for planFlush. */
export function releaseQueueReading(r: readonly [bigint, bigint, bigint, bigint, bigint]): ReleaseQueueReading {
  const [pending, head, queued, pool, nextFee] = r;
  return { pending, head, queued, pool, nextFee };
}

/** The keeper's one log line per gateway and run: what waits, and what it does about it. */
export function describeFlush(tag: string, q: ReleaseQueueReading, plan: FlushPlan): string {
  const state = `${q.pending} release(s) waiting (head ${q.head}, queued ${q.queued}), fee pool ${q.pool} wei, next fee ${q.nextFee} wei`;
  if (plan.flush) return `${tag} gateway flush: ${state} -> flush up to ${plan.maxItems} (gas ${plan.gasLimit})`;
  const why =
    plan.reason === 'pool-short'
      ? 'pool-short: the fee pool cannot pay the next release, top it up'
      : plan.reason === 'no-vault'
        ? "no-vault: the next release's chain has no vault configured (operator)"
        : 'nothing to send';
  return `${tag} gateway flush: ${state} -> no report (${why})`;
}

/** The keeper's gateway entry per home chain (CRE config `gateways`), with the flush gas settings. */
export interface KeeperGateway {
  chainSelectorName: string;
  gateway: string;
  maxItems: number;
  baseGas: string;
  gasPerItem: string;
  stateBlock?: 'finalized' | 'latest';
}

/**
 * The gateway the keeper flushes, from deployments/crosschain-testnet.json: only an auto-release gateway
 * (home.version >= 2; a v1 gateway has no queue). `creNames` maps deployment chain names to CRE selector names.
 */
export function keeperGateways(
  x: { home: { chain: string; gateway?: string; version?: number } },
  creNames: Record<string, string>,
  opts: { stateBlock?: 'finalized' | 'latest' } = {},
): KeeperGateway[] {
  const h = x.home;
  if (!h.gateway || (h.version ?? 1) < 2) return [];
  const chainSelectorName = creNames[h.chain];
  if (!chainSelectorName) throw new Error(`no CRE chain name for ${h.chain}`);
  // Base gas above planFlush's 150k default: one release through the KeystoneForwarder measured ~395k on an Arbitrum
  // Sepolia fork (450k would leave ~12%), and Arbitrum also charges L1 data gas inside the limit.
  return [
    {
      chainSelectorName,
      gateway: h.gateway,
      maxItems: 10,
      baseGas: '250000',
      gasPerItem: '300000',
      ...(opts.stateBlock ? { stateBlock: opts.stateBlock } : {}),
    },
  ];
}

const word = (v: bigint) => BigInt.asUintN(256, v).toString(16).padStart(64, '0');

/** The flush report: abi.encode(uint8 kind = REPORT_FLUSH, uint256 maxItems), as 0x-hex (64 bytes). */
export function encodeFlushReport(maxItems: number): `0x${string}` {
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error('maxItems must be a positive integer');
  return `0x${word(BigInt(REPORT_FLUSH))}${word(BigInt(maxItems))}`;
}

/** The gateway's queue events (for the app and indexers): a release queued for `account`, and its CCIP send. */
export const releaseEventsAbi = [
  {
    type: 'event',
    name: 'ReleaseQueued',
    anonymous: false,
    inputs: [
      { name: 'index', type: 'uint256', indexed: true },
      { name: 'releaseId', type: 'bytes32', indexed: true },
      { name: 'account', type: 'address', indexed: true },
      { name: 'receipt', type: 'address', indexed: false },
      { name: 'to', type: 'address', indexed: false },
      { name: 'added', type: 'uint256', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ReleaseSent',
    anonymous: false,
    inputs: [
      { name: 'index', type: 'uint256', indexed: true },
      { name: 'releaseId', type: 'bytes32', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'receipt', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'messageId', type: 'bytes32', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'fromPool', type: 'bool', indexed: false },
    ],
  },
] as const;

// ---- Auto-release automation (the issuer bot): receipts never wait inside the engine ----------------------------

/**
 * The gateway's receipt registry: `receiptInfo(token)` is (chain selector, locked token) for a receipt this gateway
 * created, zero for any other token. `VERSION()` is 2 for an auto-release gateway.
 */
export const gatewayRegistryAbi = [
  { type: 'function', name: 'VERSION', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'receiptInfo',
    stateMutability: 'view',
    inputs: [{ name: 'receipt', type: 'address' }],
    outputs: [
      { name: 'chainSelector', type: 'uint64' },
      { name: 'remoteToken', type: 'address' },
    ],
  },
] as const;

/** Whether a `receiptInfo` reading names a receipt (a registered one has a non-zero locked token). */
export function isReceiptInfo(info: readonly [bigint, string]): boolean {
  return BigInt(info[1]) !== 0n;
}

const LEDGER_SCALE = 10n ** 10n;

/**
 * The ERC-20 base units of an engine ledger balance (10-decimal fixed point) that `FlowEngine.withdraw` accepts:
 * floored to whole base units, so the amount converts back exactly (the engine refuses one that does not). What
 * does not fit one base unit stays on the ledger.
 */
export function withdrawableBase(balance: bigint, decimals: number): bigint {
  if (balance <= 0n) return 0n;
  return (balance * 10n ** BigInt(decimals)) / LEDGER_SCALE;
}

/** One cash asset of a note on an account's engine ledger. */
export interface LedgerAsset {
  asset: number;
  token: string;
  decimals: number;
  balance: bigint;
}

/**
 * Which receipts an issuer withdraws from a note (each withdraw burns them and queues a release to the issuer on the
 * asset chain): every receipt asset with at least one whole base unit on the issuer's ledger, once the note no longer
 * runs (paid in full, the collateral released to the issuer; or the excess after a capped default). While a note
 * runs its ledger may hold what a workflow step is about to move, so nothing is withdrawn then.
 */
export function planReceiptWithdrawals(
  noteRunning: boolean,
  assets: readonly LedgerAsset[],
  isReceipt: (token: string) => boolean,
): Array<{ asset: number; token: string; base: bigint }> {
  if (noteRunning) return [];
  return assets
    .filter((a) => isReceipt(a.token))
    .map((a) => ({ asset: a.asset, token: a.token, base: withdrawableBase(a.balance, a.decimals) }))
    .filter((w) => w.base > 0n);
}

/**
 * The holders to push a receipt payout to (a default's collateral, claim-by-default otherwise), in batches of at
 * most `batch` for `pushTo`: everyone owed at least one whole base unit (less cannot be sent and stays on the
 * account). Each pushed receipt burns and queues a release inside the engine's 150k per-transfer cap (~102k worst
 * case), so a batch costs up to ~150k gas per holder plus the call (see `receiptPushGas`).
 */
export function planReceiptPush(
  holders: readonly string[],
  owed: readonly bigint[],
  decimals: number,
  batch: number,
): string[][] {
  if (holders.length !== owed.length) throw new Error('holders and owed differ in length');
  if (!Number.isInteger(batch) || batch < 1) throw new Error('batch must be a positive integer');
  const due = holders.filter((_, i) => withdrawableBase(owed[i], decimals) > 0n);
  const out: string[][] = [];
  for (let i = 0; i < due.length; i += batch) out.push(due.slice(i, i + batch));
  return out;
}

/**
 * Gas for a `pushTo` of receipts to `holders` addresses. Set explicitly, not estimated: the engine gives each
 * transfer at most 150k and a transfer that runs out defers the payment instead of reverting, so an estimate that
 * just avoids a revert could leave every holder deferred.
 */
export function receiptPushGas(holders: number, opts: { baseGas?: bigint; perHolder?: bigint } = {}): bigint {
  return (opts.baseGas ?? 200_000n) + (opts.perHolder ?? 250_000n) * BigInt(holders);
}

/**
 * How many queued releases a FALLBACK flusher (the issuer bot) may send: Chainlink CRE is the primary flusher, so
 * only releases that have waited longer than `flushAfter` seconds count. Walks the queue from `head` in index order
 * (flush sends oldest first, skipping releases already sent with `sendQueued`) and counts the unsent releases whose
 * queued time (`queuedAt`, the block time of their first ReleaseQueued) is more than `flushAfter` before `now`;
 * stops at the first unsent release that is younger or whose time is unknown. At most `cap`.
 */
export function overdueReleases(
  q: Pick<ReleaseQueueReading, 'head' | 'queued'>,
  queuedAt: ReadonlyMap<bigint, number>,
  sent: ReadonlySet<bigint>,
  now: number,
  flushAfter: number,
  cap = MAX_FLUSH,
): number {
  let n = 0;
  for (let i = q.head; i <= q.queued && n < cap; i++) {
    if (sent.has(i)) continue;
    const t = queuedAt.get(i);
    if (t === undefined || now - t <= flushAfter) break;
    n++;
  }
  return n;
}

export interface FallbackFlushPlan extends Omit<FlushPlan, 'reason'> {
  reason?: FlushPlan['reason'] | 'cre-window';
}

/**
 * The fallback flush: planFlush (pool, vault, cap), limited to the releases CRE has had `flushAfter` seconds to send
 * (`overdue`, from overdueReleases). Nothing overdue: no flush (`cre-window`), CRE is expected to send them.
 */
export function planFallbackFlush(
  q: ReleaseQueueReading,
  overdue: number,
  opts: { maxItems?: number; baseGas?: bigint; gasPerItem?: bigint } = {},
): FallbackFlushPlan {
  const plan = planFlush(q, opts);
  if (!plan.flush) return plan;
  if (overdue <= 0) return { flush: false, maxItems: 0, gasLimit: 0n, reason: 'cre-window' };
  const n = Math.min(plan.maxItems, overdue);
  const per = opts.gasPerItem ?? 300_000n;
  return { flush: true, maxItems: n, gasLimit: (opts.baseGas ?? 150_000n) + per * BigInt(n) };
}

/**
 * The issuer's side of its notes, automated for demos and tests: whenever a payment falls due (an observation
 * fixed what a period owes) and the escrow does not hold it yet, fund the shortfall through that period's
 * "Fund Payment" window; fund deliveries for physical settlement; optionally top up collateral in a margin
 * call. Leave chosen payments unfunded (MISS) to show a default: the note then pays the holders from escrow.
 *
 * Payouts are CLAIMED by default: Chainlink CRE pays each coupon and the redemption into the note on its payment
 * date, and each holder claims from the portfolio when they like (pushTo for themselves, their own gas, a receipt
 * per claim). This bot pushes payouts to holders' wallets only where that was chosen (packages/sdk payout-policy.ts):
 *   PUSH unset   push only notes whose terms opt in (term sheet `payouts: 'push'`, chosen at issuance: "Paid to
 *                your wallet automatically, issuer covers gas"); every other note stays claim-only
 *   PUSH=1       push every note this bot looks after (or PIDS), opted in or not
 *   PUSH=0       push nothing, not even opted-in notes
 *   PUSH_MIN=x   when pushing, only holders owed at least x of the asset (e.g. 0.5 = 0.5 USDG), with pushTo in
 *                batches; smaller amounts stay claimable. Without it, the round's cursor is walked (pushPayouts)
 *                and anyone the cursor missed is swept with pushTo.
 *   PUSH_BATCH   holders per transaction (default 100); PUSH_ASSETS limits pushing to some assets (e.g. 1: the
 *                stablecoin). PUSH_ONLY=1 makes it a payout keeper for every note (or PIDS) under the same
 *                policy, funding nothing: any funded account will do, since pushing is permissionless.
 *
 * Robinhood Chain testnet (legacy notes). Every note is issued on Arbitrum Sepolia; Robinhood Chain testnet is a
 * collateral chain only (the vault behind Arbitrum notes). The bot instance pointed at Robinhood Chain's FlowEngine v4
 * (0xf1a1Fa45770582d1EeBC173d9076E95f9cFA0244) keeps running only to finish the notes already issued there (fund
 * their payments, push opted-in payouts, fund deliveries) until each has matured; it never issues, and nothing new
 * is issued there. Stop it once those notes are all redeemed or defaulted. The marketplace no longer lists them.
 *
 * Cross-chain collateral (HomeGateway v2, docs/CROSS-CHAIN.md). Collateral stays on its own chain; Arbitrum is only
 * the anchor, so receipts never wait inside the engine: they burn and queue a release on the asset chain only when
 * they LEAVE the engine, and this bot makes them leave (RECEIPTS=0 turns both off):
 *   - Paid in full (or the excess after a capped default): the engine credits the released receipts to the
 *     issuer's ledger. Once the note no longer runs, the bot withdraws every receipt asset on its ledger: the
 *     receipts burn and the gateway queues a release to the issuer's own address on the asset chain.
 *   - Default: the collateral is distributed to the holders as a payout. For receipt assets only, the bot pushes
 *     it to every holder owed one (`pushTo`, permissionless, RECEIPT_BATCH holders per transaction, default 25,
 *     with gas set for the engine's 150k per-transfer cap; the receipt hook takes ~102k), whatever PUSH says, so
 *     each holder's collateral is released on the asset chain without them acting. Cash payouts (USDG) stay
 *     claim-by-default under PUSH as above. With PUSH_ONLY=1 it does this for every note (or PIDS).
 *   A receipt is a token the gateway's registry knows (`receiptInfo`); the gateway must be VERSION 2.
 * Chainlink CRE flushes the release queue (about every minute). This bot is only the fallback: it calls `flush`
 * for releases that have waited more than FLUSH_AFTER seconds (default 180; the queued time is the block time of
 * the release's first ReleaseQueued event) when the fee pool can pay (FLUSH=0: never; FLUSH_MAX: releases per
 * transaction, default 10). Flushing is permissionless: any funded key will do.
 * The gateway is GATEWAY, or else home.gateway of CROSSCHAIN_CONFIG (default deployments/crosschain-testnet.json)
 * when its home chain id and engine are this bot's (GATEWAY= empty: none). Its events are read from
 * GATEWAY_FROM_BLOCK (default: the config's gatewayBlock, else FROM_BLOCK), LOG_CHUNK blocks per query (50000).
 *
 *   RPC=... CHAIN_ID=421614 ENGINE=0x... LENS=0x... ISSUER_KEY_FILE=path [FROM_BLOCK=n] [GATEWAY=0x...] \
 *   [PIDS=3,4] [MISS=4:1,7:2] [MINT=1] [TOP_UP=1] [PUSH=1|0] [PUSH_MIN=0.5] [RECEIPTS=0] [RECEIPT_BATCH=25] \
 *   [FLUSH_AFTER=180] [INTERVAL=10] npx tsx scripts/issuer-bot.ts [--once]
 *
 * PIDS: the notes to look after (default: every note whose Issuer role is this key). MISS: pid:period payments
 * to leave unfunded. MINT=1: mint tokens the wallet lacks where the key may mint (a local MockERC20, or the retired
 * tUSD older demo notes settle in, as its owner). Real tokens (USDG, WETH, Robinhood's stock tokens) must already be
 * in the wallet. The key is read from a file (a
 * `cast wallet new --json` array, or a bare hex key) or ISSUER_KEY, and never printed.
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CHAIN_TOKENS,
  collateralSymbolOfAsset,
  dec,
  gatewayRegistryAbi,
  isReceiptInfo,
  MAX_FLUSH,
  overdueReleases,
  planFallbackFlush,
  planReceiptPush,
  planReceiptWithdrawals,
  receiptPushGas,
  releaseEventsAbi,
  releaseQueueAbi,
  releaseQueueReading,
  toBase,
} from '@sn/core';
import {
  CHAINS,
  engineAbi,
  EvmAdapter,
  issuerActions,
  lensAbi,
  noteId,
  noteView,
  pushesNote,
  pushPolicyFromEnv,
  type ChainInfo,
} from '@sn/sdk';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`set ${k}`);
  return v;
};
const keyHex = (): Hex => {
  if (process.env.ISSUER_KEY) return process.env.ISSUER_KEY as Hex;
  const raw = readFileSync(env('ISSUER_KEY_FILE'), 'utf8').trim();
  const k = raw.startsWith('[') ? (JSON.parse(raw) as Array<{ private_key: string }>)[0].private_key : raw;
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const rpc = env('RPC');
const chainId = Number(env('CHAIN_ID'));
const chain = defineChain({
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const client = createPublicClient({ chain, transport: http(rpc) });
const account = privateKeyToAccount(keyHex());
const wallet = createWalletClient({ chain, account, transport: http(rpc) });
const info: ChainInfo = Object.values(CHAINS).find((c) => c.chainId === chainId) ?? { ...CHAINS.local, chainId };
const engine = env('ENGINE') as Address;
const lens = env('LENS') as Address;
const adapter = new EvmAdapter(info, client as never, { engine, lens, fromBlock: BigInt(env('FROM_BLOCK', '0')) });
const miss = new Set(
  (process.env.MISS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const only = process.env.PIDS ? new Set(process.env.PIDS.split(',').map((s) => s.trim())) : null;
const mintAbi = parseAbi(['function mint(address to, uint256 amount)']);
const log = (s: string) => console.log(`[issuer-bot] ${s}`);
const flushAbi = parseAbi(['function flush(uint256 maxItems) returns (uint256 sent)']);
/** The HomeGateway (v2) and the block its events start at: GATEWAY, else the cross-chain config's for this engine. */
function gatewayOf(): { gateway?: Address; fromBlock: bigint } {
  const from = BigInt(env('FROM_BLOCK', '0'));
  const explicit = process.env.GATEWAY;
  if (explicit !== undefined) {
    const gateway = /^0x[0-9a-fA-F]{40}$/.test(explicit) ? (explicit as Address) : undefined;
    return { gateway, fromBlock: BigInt(process.env.GATEWAY_FROM_BLOCK ?? from) };
  }
  try {
    const x = JSON.parse(
      readFileSync(process.env.CROSSCHAIN_CONFIG ?? 'deployments/crosschain-testnet.json', 'utf8'),
    ) as { home?: { chainId?: number; engine?: string; gateway?: string; gatewayBlock?: number; version?: number } };
    const h = x.home;
    if (
      h?.gateway &&
      h.chainId === chainId &&
      (h.version ?? 1) >= 2 &&
      h.engine?.toLowerCase() === engine.toLowerCase()
    )
      return {
        gateway: h.gateway as Address,
        fromBlock: BigInt(process.env.GATEWAY_FROM_BLOCK ?? h.gatewayBlock ?? from),
      };
  } catch {
    /* no config: no gateway */
  }
  return { fromBlock: from };
}
const gw = gatewayOf();
let gateway = gw.gateway;
/** Receipts leave the engine automatically (withdraw the issuer's, push holders'): on unless RECEIPTS=0. */
let autoRelease = !!gateway && process.env.RECEIPTS !== '0';
const flushAfter = Number(process.env.FLUSH_AFTER ?? 180);
const receiptBatch = Number(process.env.RECEIPT_BATCH ?? 25);
const logChunk = BigInt(process.env.LOG_CHUNK ?? 50_000);
if (gateway) {
  const version = await client
    .readContract({ address: gateway, abi: gatewayRegistryAbi, functionName: 'VERSION' })
    .catch(() => 0n);
  if (version < 2n) {
    console.log(
      `[issuer-bot] gateway ${gateway} is not an auto-release (v2) gateway (VERSION ${version}): no flush, no receipt release`,
    );
    gateway = undefined;
    autoRelease = false;
  } else {
    console.log(
      `[issuer-bot] gateway ${gateway} (v${version}): receipts ${autoRelease ? 'withdrawn / pushed automatically' : 'not moved (RECEIPTS=0)'}; fallback flush ${process.env.FLUSH === '0' ? 'off' : `after ${flushAfter} s`}`,
    );
  }
}
const policy = pushPolicyFromEnv(process.env);
const pushOnly = process.env.PUSH_ONLY === '1';
const pushBatch = policy.batch;
const MAX = 2n ** 256n - 1n;
/** Push rounds not settled yet: `${pid}:${asset}` -> period, from DistributionRecorded / DistributionSettled. */
const openRounds = new Map<string, bigint>();
let pushFrom = BigInt(env('FROM_BLOCK', '0'));

/** Holders of a note's units, paged through the lens. */
async function holdersOf(pid: bigint): Promise<readonly Address[]> {
  const out: Address[] = [];
  for (let start = 0n; ; start += 1000n) {
    const [who, , total] = await client.readContract({
      address: lens,
      abi: lensAbi,
      functionName: 'holders',
      args: [pid, 0n, start, 1000n],
    });
    out.push(...who);
    if (!who.length || start + 1000n >= total) return out;
  }
}

/** pushTo every holder owed at least `min` (engine fixed point), PUSH_BATCH per transaction. */
async function pushOwed(pid: bigint, asset: number, min: bigint, what: string) {
  const who = await holdersOf(pid);
  if (!who.length) return;
  const owed = await client.readContract({
    address: lens,
    abi: lensAbi,
    functionName: 'claimable',
    args: [pid, BigInt(asset), who],
  });
  const due = who.filter((_, i) => owed[i] >= min);
  for (let i = 0; i < due.length; i += Number(pushBatch)) {
    const batch = due.slice(i, i + Number(pushBatch));
    const hash = await wallet.writeContract({
      address: engine,
      abi: engineAbi,
      functionName: 'pushTo',
      args: [pid, asset, batch],
      chain,
      account,
    });
    const r = await client.waitForTransactionReceipt({ hash });
    log(`${noteId(info.key, engine, pid)}: ${what} ${batch.length} holder(s) on asset ${asset} (${r.gasUsed} gas)`);
  }
  if (due.length < who.length && min > 10_000n)
    log(
      `${noteId(info.key, engine, pid)}: ${who.length - due.length} holder(s) owed less than PUSH_MIN stay claimable`,
    );
}

/**
 * Push the open payout rounds of the notes this bot pushes for (`push`: its policy said yes for the note), to the
 * end of each holder set; with PUSH_MIN, only to holders owed at least that.
 */
async function scanRounds() {
  const head = await client.getBlockNumber();
  if (head >= pushFrom) {
    const [rec, settled] = await Promise.all([
      client.getContractEvents({
        address: engine,
        abi: engineAbi,
        eventName: 'DistributionRecorded',
        fromBlock: pushFrom,
        toBlock: head,
      }),
      client.getContractEvents({
        address: engine,
        abi: engineAbi,
        eventName: 'DistributionSettled',
        fromBlock: pushFrom,
        toBlock: head,
      }),
    ]);
    const all = [...rec.map((l) => ({ l, open: true })), ...settled.map((l) => ({ l, open: false }))].sort(
      (a, b) => Number(a.l.blockNumber - b.l.blockNumber) || a.l.logIndex - b.l.logIndex,
    );
    for (const { l, open } of all) {
      const a = l.args as { pid: bigint; asset: number; period: bigint };
      const key = `${a.pid}:${a.asset}`;
      if (open) openRounds.set(key, a.period);
      else if (openRounds.get(key) === a.period) openRounds.delete(key);
    }
    pushFrom = head + 1n;
  }
}

async function pushPayouts(push: Set<string>) {
  for (const [key] of [...openRounds]) {
    const [pid, asset] = key.split(':');
    if (!push.has(pid) || (policy.assets && !policy.assets.has(asset))) continue;
    if (await roundIsReceipt(key)) continue; // receipts: pushReceiptRounds, whatever the cash policy
    if (policy.min > 0n) {
      openRounds.delete(key);
      await pushOwed(BigInt(pid), Number(asset), policy.min, 'paid');
      continue;
    }
    let left = 1n;
    for (let n = 0; left > 0n && n < 50; n++) {
      const { result } = await client.simulateContract({
        address: engine,
        abi: engineAbi,
        functionName: 'pushPayouts',
        args: [BigInt(pid), Number(asset), MAX, pushBatch],
        account,
      });
      const hash = await wallet.writeContract({
        address: engine,
        abi: engineAbi,
        functionName: 'pushPayouts',
        args: [BigInt(pid), Number(asset), MAX, pushBatch],
        chain,
        account,
      });
      const r = await client.waitForTransactionReceipt({ hash });
      left = result;
      log(
        `${noteId(info.key, engine, BigInt(pid))}: pushed payouts of asset ${asset} (${r.gasUsed} gas, ${left} holders left)`,
      );
    }
    if (left > 0n) continue;
    openRounds.delete(key);
    // The holder set can reorder mid-round (a holder selling out swaps the last one into its slot), and a
    // payment can be deferred: sweep once with pushTo for every holder still owed at least one base unit.
    await pushOwed(BigInt(pid), Number(asset), 10_000n, 'swept');
  }
}

/** Make sure the wallet holds `base` of `token` (minting test tokens if allowed). */
async function ensure(token: Address, base: bigint) {
  const have = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  if (have >= base) return true;
  if (process.env.MINT !== '1') {
    log(`short of ${token}: ${have} < ${base}`);
    return false;
  }
  const hash = await wallet.writeContract({
    address: token,
    abi: mintAbi,
    functionName: 'mint',
    args: [account.address, base - have],
    chain,
    account,
  });
  await client.waitForTransactionReceipt({ hash });
  return true;
}

const ceil6 = (x: number) => Math.ceil(x * 1e6 - 1e-6) / 1e6;

// ---- Cross-chain collateral: receipts leave the engine; CRE flushes, this bot only as a late fallback ----------

const receiptTokens = new Map<string, boolean>();
/** Whether `token` is a receipt of the gateway (cached: the registry only grows, and a token never changes). */
async function isReceipt(token: string): Promise<boolean> {
  if (!gateway || BigInt(token) === 0n) return false;
  const k = token.toLowerCase();
  let yes = receiptTokens.get(k);
  if (yes === undefined) {
    yes = isReceiptInfo(
      await client.readContract({
        address: gateway,
        abi: gatewayRegistryAbi,
        functionName: 'receiptInfo',
        args: [token as Address],
      }),
    );
    receiptTokens.set(k, yes);
  }
  return yes;
}

/** The releases a transaction queued at the gateway, for the log. */
function queuedIn(r: TransactionReceipt): string {
  const q = parseEventLogs({ abi: releaseEventsAbi, logs: r.logs, eventName: 'ReleaseQueued' }).filter(
    (l) => l.address.toLowerCase() === gateway?.toLowerCase(),
  );
  return q.length ? q.map((l) => `#${l.args.index} ${l.args.added} to ${l.args.to}`).join(', ') : 'none';
}

/** Notes whose receipts are all off the issuer's ledger after the note ended: nothing more can come. */
const withdrawn = new Set<string>();
/**
 * Paid in full (or the excess after a capped default): the engine credited the released receipts to the issuer's
 * ledger. Withdraw them: each burns and queues a release to the issuer's own address on the asset chain.
 */
async function withdrawReceipts(
  pid: bigint,
  running: boolean,
  assetTokens: readonly string[],
  decimals: readonly number[],
) {
  if (!autoRelease || running || withdrawn.has(pid.toString())) return;
  const id = noteId(info.key, engine, pid);
  const ledger = [];
  for (let i = 0; i < assetTokens.length; i++) {
    if (!(await isReceipt(assetTokens[i]))) continue;
    const balance = await client.readContract({
      address: engine,
      abi: engineAbi,
      functionName: 'balanceOf',
      args: [pid, account.address, BigInt(i)],
    });
    ledger.push({ asset: i, token: assetTokens[i], decimals: decimals[i], balance });
  }
  const plan = planReceiptWithdrawals(running, ledger, () => true);
  for (const w of plan) {
    const hash = await wallet.writeContract({
      address: engine,
      abi: engineAbi,
      functionName: 'withdraw',
      args: [pid, w.asset, w.base],
      chain,
      account,
    });
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`withdraw of receipt asset ${w.asset} reverted (${hash})`);
    log(
      `${id}: withdrew ${w.base} base units of receipt asset ${w.asset} (${w.token}): burned, release queued to the issuer on the asset chain [${queuedIn(r)}] (tx ${hash})`,
    );
  }
  if (!plan.length) withdrawn.add(pid.toString());
}

const roundTokens = new Map<string, string>();
/** Whether a payout round (`pid:asset`) pays a receipt asset (and receipts are released automatically). */
async function roundIsReceipt(key: string): Promise<boolean> {
  if (!autoRelease) return false;
  let token = roundTokens.get(key);
  if (token === undefined) {
    const [pid, asset] = key.split(':');
    token = await client.readContract({
      address: engine,
      abi: engineAbi,
      functionName: 'assetTokenOf',
      args: [BigInt(pid), BigInt(asset)],
    });
    roundTokens.set(key, token);
  }
  return isReceipt(token);
}

const tokenDecimals = new Map<string, number>();
/**
 * A default paid the holders in collateral receipts: push each holder's share out of the engine (`pushTo`,
 * permissionless), so it burns and is released to them on the asset chain without any holder action. Cash payouts
 * are not touched here (claim by default, PUSH). One pass per payout round; what could not be sent (under one base
 * unit, or a deferred transfer) stays claimable and is logged.
 */
async function pushReceiptRounds(pids: Set<string>) {
  if (!autoRelease) return;
  for (const [key] of [...openRounds]) {
    const [pid, asset] = key.split(':');
    if (!pids.has(pid) || !(await roundIsReceipt(key))) continue;
    const id = noteId(info.key, engine, BigInt(pid));
    const token = roundTokens.get(key)! as Address;
    let decimals = tokenDecimals.get(token);
    if (decimals === undefined) {
      decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
      tokenDecimals.set(token, decimals);
    }
    const who = await holdersOf(BigInt(pid));
    const owed = who.length
      ? await client.readContract({
          address: lens,
          abi: lensAbi,
          functionName: 'claimable',
          args: [BigInt(pid), BigInt(asset), who],
        })
      : [];
    const batches = planReceiptPush(who, owed, decimals, receiptBatch);
    for (const batch of batches) {
      const hash = await wallet.writeContract({
        address: engine,
        abi: engineAbi,
        functionName: 'pushTo',
        args: [BigInt(pid), Number(asset), batch as Address[]],
        gas: receiptPushGas(batch.length),
        chain,
        account,
      });
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(`pushTo of receipt asset ${asset} reverted (${hash})`);
      const deferred = parseEventLogs({ abi: engineAbi, logs: r.logs, eventName: 'PayoutDeferred' }).length;
      log(
        `${id}: pushed receipt collateral (asset ${asset}) to ${batch.length} holder(s), released on the asset chain [${queuedIn(r)}]${deferred ? `, ${deferred} deferred` : ''} (${r.gasUsed} gas, tx ${hash})`,
      );
    }
    const pushed = batches.flat() as Address[];
    if (pushed.length) {
      const left = await client.readContract({
        address: lens,
        abi: lensAbi,
        functionName: 'claimable',
        args: [BigInt(pid), BigInt(asset), pushed],
      });
      const stuck = planReceiptPush(pushed, left, decimals, receiptBatch).flat().length;
      if (stuck)
        log(
          `${id}: ${stuck} holder(s) still hold receipt asset ${asset} in the engine (transfer deferred): claimable, not retried`,
        );
    }
    openRounds.delete(key);
  }
}

/** Release queue bookkeeping from the gateway's events: when each release was first queued, and which were sent. */
const releaseBlock = new Map<bigint, bigint>();
const queuedAt = new Map<bigint, number>();
const releaseSent = new Set<bigint>();
const blockTime = new Map<bigint, number>();
let gatewayFrom = gw.fromBlock;
let noEventLogged = -1n;

async function scanGateway(head: bigint) {
  while (gateway && gatewayFrom <= head) {
    const to = gatewayFrom + logChunk - 1n < head ? gatewayFrom + logChunk - 1n : head;
    const [queued, sent] = await Promise.all([
      client.getContractEvents({
        address: gateway,
        abi: releaseEventsAbi,
        eventName: 'ReleaseQueued',
        fromBlock: gatewayFrom,
        toBlock: to,
      }),
      client.getContractEvents({
        address: gateway,
        abi: releaseEventsAbi,
        eventName: 'ReleaseSent',
        fromBlock: gatewayFrom,
        toBlock: to,
      }),
    ]);
    for (const l of queued) if (!releaseBlock.has(l.args.index!)) releaseBlock.set(l.args.index!, l.blockNumber);
    for (const l of sent) releaseSent.add(l.args.index!);
    gatewayFrom = to + 1n;
  }
}

/**
 * Fallback to Chainlink CRE (the primary flusher, about every minute): send queued releases only once they have
 * waited more than FLUSH_AFTER seconds, and only when the gateway's fee pool can pay. The gateway re-checks
 * everything; a flush racing CRE's simply finds less to send.
 */
async function flushReleases() {
  if (!gateway || process.env.FLUSH === '0') return;
  const q = releaseQueueReading(
    await client.readContract({ address: gateway, abi: releaseQueueAbi, functionName: 'releaseQueue' }),
  );
  if (q.pending === 0n) return;
  const latest = await client.getBlock();
  await scanGateway(latest.number);
  const now = Number(latest.timestamp);
  const maxItems = Number(process.env.FLUSH_MAX ?? 10);
  for (let i = q.head; i <= q.queued && i < q.head + BigInt(MAX_FLUSH); i++) {
    if (releaseSent.has(i) || queuedAt.has(i)) continue;
    const b = releaseBlock.get(i);
    if (b === undefined) {
      // Its event is older than GATEWAY_FROM_BLOCK: count from now (never ahead of CRE on a guess).
      queuedAt.set(i, now);
      if (noEventLogged !== i) {
        log(
          `gateway: no ReleaseQueued event for release #${i} since block ${gw.fromBlock}: counting its wait from now`,
        );
        noEventLogged = i;
      }
      continue;
    }
    let t = blockTime.get(b);
    if (t === undefined) {
      t = Number((await client.getBlock({ blockNumber: b })).timestamp);
      blockTime.set(b, t);
    }
    queuedAt.set(i, t);
  }
  const overdue = overdueReleases(q, queuedAt, releaseSent, now, flushAfter);
  const plan = planFallbackFlush(q, overdue, { maxItems });
  if (!plan.flush) {
    if (plan.reason !== 'empty' && plan.reason !== 'cre-window')
      log(
        `gateway: ${q.pending} release(s) waiting, not flushed (${plan.reason}; pool ${q.pool} wei, next fee ${q.nextFee} wei)`,
      );
    return;
  }
  const hash = await wallet.writeContract({
    address: gateway,
    abi: flushAbi,
    functionName: 'flush',
    args: [BigInt(plan.maxItems)],
    chain,
    account,
  });
  const r = await client.waitForTransactionReceipt({ hash });
  const sent = parseEventLogs({ abi: releaseEventsAbi, logs: r.logs, eventName: 'ReleaseSent' }).map(
    (l) => `#${l.args.index}`,
  );
  log(
    `gateway: CRE had not sent ${overdue} release(s) waiting over ${flushAfter} s: flushed ${sent.join(', ') || 'none'} of ${q.pending} queued (${r.gasUsed} gas, tx ${hash})`,
  );
  for (const i of [...queuedAt.keys()]) if (i < q.head) queuedAt.delete(i); // bounded memory
}

async function tick() {
  await flushReleases().catch((err) =>
    log(`flush: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`),
  );
  const count = await client.readContract({ address: engine, abi: engineAbi, functionName: 'processCount' });
  const mine = new Set<string>();
  if (pushOnly) {
    for (let pid = 1n; pid <= count; pid++) if (!only || only.has(pid.toString())) mine.add(pid.toString());
    await scanRounds();
    await pushReceiptRounds(mine);
    if (policy.mode !== 'off') await pushPayouts(await toPush(mine));
    return;
  }
  for (let pid = 1n; pid <= count; pid++) {
    if (only && !only.has(pid.toString())) continue;
    const id = noteId(info.key, engine, pid);
    const s = await adapter.getNote(id);
    if (!s) continue;
    const def = await adapter.getDefinition(s.definition);
    if (!def) continue;
    const issuerRole = def.roles.indexOf('Issuer');
    if (issuerRole < 0 || s.roles[issuerRole] !== account.address.toLowerCase()) continue;
    mine.add(pid.toString()); // a completed note may still have its redemption to push
    // Its collateral receipts back on the issuer's ledger once the note ended: release them on the asset chain.
    await withdrawReceipts(
      pid,
      s.status === 0,
      s.assetTokens,
      def.assets.map((a) => a.decimals),
    ).catch((err) =>
      log(`${id}: receipt withdraw: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`),
    );
    if (s.status !== 0) continue;
    const now = Number((await client.getBlock()).timestamp);
    const v = noteView(def, s, now);
    const e = v.economics;
    if (!e) continue;
    const actions = issuerActions(def, s, now); // windows still open: the engine refuses a late one
    const field = (name: string) => def.fields.findIndex((f) => f.name === name);
    const run = async (step: number, fieldName: string, amount: number, assetName: string, label: string) => {
      // The cash asset is USDG on new notes and USDC (tUSD) on notes issued before USDG.
      const asset = def.assets.findIndex((a) => a.name === assetName || (assetName === 'USDG' && a.name === 'USDC'));
      const token = s.assetTokens[asset] as Address;
      if (!(await ensure(token, toBase(dec(amount.toFixed(9)), def.assets[asset].decimals)))) return;
      await adapter.executeStep(wallet as never, id, step, {
        [field(fieldName)]: { kind: 'number', value: dec(amount.toFixed(9)) },
      });
      log(`${id}: ${label} ${amount}`);
    };
    const call = e.nextCall;
    if (call && !call.funded && !miss.has(`${pid}:${call.period}`)) {
      const step = actions.fund.find((f) => f.period === call.period);
      if (step)
        await run(step.step, 'fundAmount', ceil6(call.total - e.escrowCash), 'USDG', `funded payment ${call.period}:`);
      else log(`${id}: payment ${call.period}'s funding window has closed`);
    } else if (call && miss.has(`${pid}:${call.period}`)) {
      log(`${id}: leaving payment ${call.period} unfunded (MISS)`);
    }
    const period = e.periods.find((p) => p.deliver && (p.status === 'due' || p.status === 'grace'));
    if (period?.deliver && !miss.has(`${pid}:${period.k}`)) {
      const d = actions.delivery.find((x) => x.symbol === period.deliver!.symbol);
      // The real token delivered for the underlying (WETH for ETH, Robinhood's TSLA…); older notes named it tTSLA.
      const sym = period.deliver.symbol;
      const names = new Set([
        sym,
        `t${sym}`,
        ...Object.values(CHAIN_TOKENS)
          .flatMap((c) => Object.values(c))
          .filter((t) => t.valuedAs === sym)
          .map((t) => t.token),
      ]);
      const asset = def.assets.findIndex((a) => names.has(a.name));
      const assetName = asset >= 0 ? def.assets[asset].name : sym;
      const escrowRole = def.roleFlags.findIndex((f) => (f & 1) === 1);
      const held =
        Number(BigInt(s.holdings.find((h) => h.asset === asset && h.owner === s.roles[escrowRole])?.balance ?? '0')) /
        1e10;
      const need = period.deliver.perUnit * v.sold - held;
      if (d && need > 1e-9)
        await run(
          d.step,
          `fundDelivery_${period.deliver.symbol}`,
          Math.ceil(need * 1e9) / 1e9 + 1e-9,
          assetName,
          `funded ${assetName} delivery:`,
        );
    }
    if (e.marginCall && process.env.TOP_UP === '1' && e.required !== null && e.coverage !== null) {
      const c = e.collateral.find((x) => x.price && x.haircut) ?? e.collateral[0];
      const t = actions.topUp.find((x) => x.symbol === c.symbol);
      const need = (e.required - e.coverage) / ((c.price ?? 1) * (c.haircut || 1));
      const colName =
        def.assets.find((a) => collateralSymbolOfAsset(a.name) === c.symbol)?.name ?? `Collateral ${c.symbol}`;
      if (t && need > 0)
        await run(
          t.step,
          `topUp_${c.symbol}`,
          Math.ceil(need * 1.01 * 1e6) / 1e6,
          colName,
          `topped up ${c.symbol} collateral:`,
        );
    }
  }
  await scanRounds();
  // A default's collateral receipts to the holders' wallets, so they are released on the asset chain (always).
  await pushReceiptRounds(mine).catch((err) =>
    log(`receipt push: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`),
  );
  if (policy.mode !== 'off') await pushPayouts(await toPush(mine));
}

/** Of these notes, the ones this bot pushes for: all of them with PUSH=1, else those whose terms opt in. */
const pushChoice = new Map<string, boolean>();
async function toPush(pids: Set<string>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const pid of pids) {
    let yes = pushChoice.get(pid);
    if (yes === undefined) {
      if (policy.mode === 'all') yes = true;
      else {
        const s = await adapter.getNote(noteId(info.key, engine, BigInt(pid)));
        const def = s ? await adapter.getDefinition(s.definition) : null;
        yes = !!def && pushesNote(policy, def);
        if (yes)
          log(
            `${noteId(info.key, engine, BigInt(pid))}: its terms opt in to paying holders' wallets: pushing its payouts`,
          );
      }
      pushChoice.set(pid, yes);
    }
    if (yes) out.add(pid);
  }
  return out;
}

const once = process.argv.includes('--once');
for (;;) {
  try {
    await tick();
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    if (once) process.exit(1);
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, Number(process.env.INTERVAL ?? 10) * 1000));
}

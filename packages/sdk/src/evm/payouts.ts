/**
 * Payout receipts (FlowEngine v4, docs/ERC20-NOTES.md): every pushed payment carries a payoutId, every
 * distribution a commitment hash, and every push round a rolling hash of its payoutIds in push order. Anyone can
 * recompute all three from the logs alone, and check them against what the chain logged.
 *
 *   distributionHash = keccak256(abi.encode(chainId, engine, pid, asset, period, perUnit, supplyAtPayment))
 *   payoutId         = keccak256(abi.encode(chainId, engine, pid, asset, period, holder, amount))
 *   rollingHash      = r_n where r_0 = 0x00…00, r_i = keccak256(abi.encode(r_{i-1}, payoutId_i))
 *
 * `amount` is in the cash token's base units (what reached the wallet); `perUnit` is engine fixed point.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import type { EngineEvent } from '../events';

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

export interface PayoutScope {
  chainId: number | bigint;
  engine: string;
}

export function distributionHash(
  scope: PayoutScope,
  pid: bigint | string,
  asset: number,
  period: number,
  perUnit: bigint | string,
  supply: bigint | string,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'int256' },
        { type: 'uint256' },
      ],
      [
        BigInt(scope.chainId),
        scope.engine as Address,
        BigInt(pid),
        BigInt(asset),
        BigInt(period),
        BigInt(perUnit),
        BigInt(supply),
      ],
    ),
  );
}

export function payoutId(
  scope: PayoutScope,
  pid: bigint | string,
  asset: number,
  period: number,
  holder: string,
  amount: bigint | string,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        BigInt(scope.chainId),
        scope.engine as Address,
        BigInt(pid),
        BigInt(asset),
        BigInt(period),
        holder as Address,
        BigInt(amount),
      ],
    ),
  );
}

/** Chain payoutIds in push order (the round's DistributionSettled.rollingHash). */
export function rollingHash(ids: readonly Hex[]): Hex {
  let r = ZERO32;
  for (const id of ids) r = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [r, id]));
  return r;
}

export interface RoundCheck {
  pid: string;
  asset: number;
  period: number;
  paidCount: number;
  paidTotal: bigint;
  rollingHash: Hex;
  /**
   * False for a round still open at the end of the events: nobody pushed it to the last holder and no later
   * distribution superseded it yet (the usual case for the latest payment once holders claim). Its payoutIds are
   * checked; its count, total and rolling hash are what was logged so far, with nothing settled to compare.
   */
  settled: boolean;
  /** Every payoutId recomputed matches the logged one, and the rolling hash and totals match DistributionSettled. */
  ok: boolean;
  problems: string[];
}

/**
 * Check every payout round in a note's events (in chain order): each PayoutPaid's payoutId (a holder's claim or a
 * push), each DistributionRecorded's hash, and each DistributionSettled's count, total and rolling hash. Rounds not
 * settled yet come last, with `settled: false`.
 */
export function verifyPayouts(scope: PayoutScope, events: readonly EngineEvent[]): RoundCheck[] {
  const open = new Map<string, { ids: Hex[]; total: bigint; problems: string[] }>();
  const out: RoundCheck[] = [];
  for (const e of events) {
    if (e.name === 'DistributionRecorded') {
      const key = `${e.pid}|${e.asset}|${e.period}`;
      const problems: string[] = [];
      if (distributionHash(scope, e.pid, e.asset, e.period, e.perUnit, e.supply).toLowerCase() !== e.hash.toLowerCase())
        problems.push(`distribution ${key}: hash mismatch`);
      open.set(key, { ids: [], total: 0n, problems });
    } else if (e.name === 'PayoutPaid') {
      const key = `${e.pid}|${e.asset}|${e.period}`;
      const r = open.get(key) ?? { ids: [], total: 0n, problems: [`payout before its distribution ${key}`] };
      const id = payoutId(scope, e.pid, e.asset, e.period, e.holder, e.amount);
      if (id.toLowerCase() !== e.payoutId.toLowerCase()) r.problems.push(`payout to ${e.holder}: payoutId mismatch`);
      r.ids.push(id);
      r.total += BigInt(e.amount);
      open.set(key, r);
    } else if (e.name === 'DistributionSettled') {
      const key = `${e.pid}|${e.asset}|${e.period}`;
      const r = open.get(key) ?? { ids: [], total: 0n, problems: [] };
      const rolling = rollingHash(r.ids);
      const problems = [...r.problems];
      if (rolling.toLowerCase() !== e.rollingHash.toLowerCase()) problems.push(`round ${key}: rolling hash mismatch`);
      if (r.ids.length !== e.paidCount)
        problems.push(`round ${key}: ${r.ids.length} payouts logged, ${e.paidCount} settled`);
      if (r.total !== BigInt(e.paidTotal))
        problems.push(`round ${key}: total ${r.total} logged, ${e.paidTotal} settled`);
      out.push({
        pid: e.pid,
        asset: e.asset,
        period: e.period,
        paidCount: e.paidCount,
        paidTotal: BigInt(e.paidTotal),
        rollingHash: e.rollingHash as Hex,
        settled: true,
        ok: !problems.length,
        problems,
      });
      open.delete(key);
    }
  }
  for (const [key, r] of open) {
    const [pid, asset, period] = key.split('|');
    out.push({
      pid,
      asset: Number(asset),
      period: Number(period),
      paidCount: r.ids.length,
      paidTotal: r.total,
      rollingHash: rollingHash(r.ids),
      settled: false,
      ok: !r.problems.length,
      problems: r.problems,
    });
  }
  return out;
}

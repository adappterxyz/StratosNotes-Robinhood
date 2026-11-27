/**
 * A note replayed on real price history (docs/ATLAS-CMC.md): what its terms would have paid had it started on each
 * past day, from CoinMarketCap's daily prices of the underlyings (the stock tokens of BNB Chain have traded since
 * June 2026). The same reference payoff the on-chain workflow is tested against (payoff.ts), so the replay and the
 * note cannot disagree. A summary of the past, not a forecast.
 *
 * Pure: no I/O.
 */
import type { ProductParams } from './params';
import { simulateWorstOf, totalPerUnit } from './payoff';

/** Daily prices, oldest first: [unix seconds, USD price]. */
export type DailySeries = ReadonlyArray<readonly [number, number]>;

export interface BacktestResult {
  /** Start days replayed, and the first and last of them (unix seconds). */
  starts: number;
  from: number;
  to: number;
  /** Starts redeemed early (autocall). */
  calledEarly: number;
  /** Starts that paid a coupon at every observation they reached. */
  allCoupons: number;
  /** Starts that ended below the knock-in barrier: less than the face back. */
  loss: number;
  /** Per unit of face, coupons and redemption together: the average, the worst and the best start. */
  avgTotal: number;
  worstTotal: number;
  bestTotal: number;
  /** The lowest worst-performer level seen at any observation (1 = at the start price). */
  lowestLevel: number;
}

const DAY = 86_400;

/**
 * Replay `p` from every day the history allows: the start price is that day's, observation k is `offsetsDays[k-1]`
 * days later (whole days, at least one), each underlying read from `series[symbol]`. Null when an underlying has no
 * series or fewer than `minStarts` starts fit (the term is longer than the history).
 */
export function backtestNote(
  p: ProductParams,
  series: Record<string, DailySeries>,
  offsetsDays: readonly number[],
  minStarts = 5,
): BacktestResult | null {
  const syms = p.underlyings.map((u) => u.symbol);
  if (!syms.length || offsetsDays.length !== p.observations) return null;
  if (offsetsDays.some((d, i) => !Number.isInteger(d) || d < 1 || (i > 0 && d <= offsetsDays[i - 1]))) return null;
  // Each underlying's price by day number.
  const byDay = syms.map((s) => new Map((series[s] ?? []).map(([t, px]) => [Math.floor(t / DAY), px])));
  if (byDay.some((m) => !m.size)) return null;
  const first = Math.max(...byDay.map((m) => Math.min(...m.keys())));
  const last = Math.min(...byDay.map((m) => Math.max(...m.keys())));
  const term = offsetsDays[offsetsDays.length - 1];
  const out: BacktestResult = {
    starts: 0,
    from: 0,
    to: 0,
    calledEarly: 0,
    allCoupons: 0,
    loss: 0,
    avgTotal: 0,
    worstTotal: Infinity,
    bestTotal: -Infinity,
    lowestLevel: Infinity,
  };
  let sum = 0;
  for (let d = first; d + term <= last; d++) {
    const strikes = byDay.map((m) => m.get(d));
    const paths = offsetsDays.map((o) => byDay.map((m) => m.get(d + o)));
    // A day CoinMarketCap has no price for (rare): that start is left out, never interpolated.
    if (strikes.some((x) => !x) || paths.some((row) => row.some((x) => !x))) continue;
    const r = simulateWorstOf(p, strikes as number[], paths as number[][]);
    const reached = r.calledAt ?? p.observations;
    const total = totalPerUnit(r);
    for (let k = 0; k < reached; k++)
      out.lowestLevel = Math.min(out.lowestLevel, ...paths[k].map((x, i) => (x as number) / (strikes[i] as number)));
    if (!out.starts) out.from = d * DAY;
    out.to = d * DAY;
    out.starts += 1;
    if (r.calledAt !== undefined) out.calledEarly += 1;
    if (r.coupons.length === reached && r.coupons.every((c) => c > 0)) out.allCoupons += 1;
    if (r.redemptionCash < 1) out.loss += 1;
    out.worstTotal = Math.min(out.worstTotal, total);
    out.bestTotal = Math.max(out.bestTotal, total);
    sum += total;
  }
  if (out.starts < minStarts) return null;
  out.avgTotal = sum / out.starts;
  return out;
}

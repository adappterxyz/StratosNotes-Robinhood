import type { ProductParams } from './params';

/**
 * Reference payoff (Flow's products/payoff.ts): for a price path, what ONE
 * unit of face is paid. It is the specification the on-chain workflow is
 * tested against (test/products.e2e.test.ts).
 *
 * Per observation k = 1..n, strike S, price o_k:
 *  - FCN / reverse convertible: coupon every period.
 *  - Phoenix: coupon only if o_k >= S x couponBarrier; with memory it also
 *    pays every coupon missed since the last one paid.
 *  - Snowball: no periodic coupon; an autocall pays 1 + rate x k.
 *  - Autocall (FCN, phoenix, snowball), after the period's coupon, for
 *    autocallFrom <= k < n: o_k >= S x autocallLevel redeems at 1 (snowball
 *    1 + rate x k).
 *  - Maturity: snowball pays 1 + rate x n if o_n >= S x autocallLevel.
 *    Otherwise o_n >= S x knockIn redeems at 1; below it, o_n / S in cash.
 *  - PPN: protection + participation x max(0, o_n / S - 1).
 *
 * Worst-of baskets replace o_k / S with the worst performer's min(o_ik / S_i).
 */
export interface PayoffResult {
  coupons: number[];
  calledAt?: number;
  redemptionCash: number;
}

export function simulatePayoff(p: ProductParams, strike: number, prices: number[]): PayoffResult {
  return run(
    p,
    prices.length,
    (k, lvl) => prices[k - 1] >= (strike * lvl) / 100,
    (k) => prices[k - 1] / strike,
  );
}

/**
 * Worst-of: `strikes[i]` per underlying, `paths[k - 1][i]` its level at
 * observation k. Every test uses the worst performance min(level_i / strike_i)
 * (a single underlying gives the same result as simulatePayoff).
 */
export function simulateWorstOf(p: ProductParams, strikes: number[], paths: number[][]): PayoffResult {
  return simulatePerf(
    p,
    paths.map((row) => Math.min(...row.map((o, i) => o / strikes[i]))),
  );
}

/** Payoff from the worst performance at each observation (1 = at strike). */
export function simulatePerf(p: ProductParams, perfs: number[]): PayoffResult {
  return run(
    p,
    perfs.length,
    (k, lvl) => perfs[k - 1] >= lvl / 100,
    (k) => perfs[k - 1],
  );
}

function run(
  p: ProductParams,
  len: number,
  atLeast: (k: number, levelPct: number) => boolean,
  ratio: (k: number) => number,
): PayoffResult {
  const n = p.observations;
  if (len !== n) throw new Error(`need ${n} observations, got ${len}`);
  const rate = (p.couponRatePct ?? 0) / 100;
  const from = p.autocallFromPeriod ?? 1;
  const coupons: number[] = [];
  let missed = 0;
  for (let k = 1; k <= n; k++) {
    let c = 0;
    if (p.productType === 'fcn' || p.productType === 'reverse-convertible') c = rate;
    if (p.productType === 'phoenix') {
      if (atLeast(k, p.couponBarrierPct ?? 0)) {
        c = rate * (p.memory ? missed + 1 : 1);
        missed = 0;
      } else missed += 1;
    }
    coupons.push(c);
    const autocalls = p.productType === 'fcn' || p.productType === 'phoenix' || p.productType === 'snowball';
    if (autocalls && k >= from && k < n && atLeast(k, p.autocallLevelPct ?? 0)) {
      return { coupons, calledAt: k, redemptionCash: 1 + (p.productType === 'snowball' ? rate * k : 0) };
    }
  }
  const r = ratio(n);
  if (p.productType === 'ppn') {
    const up = r > 1 ? ((p.participationPct ?? 0) / 100) * (r - 1) : 0;
    return { coupons, redemptionCash: (p.protectionPct ?? 0) / 100 + up };
  }
  if (p.productType === 'snowball' && atLeast(n, p.autocallLevelPct ?? 0))
    return { coupons, redemptionCash: 1 + rate * n };
  if (atLeast(n, p.knockInBarrierPct ?? 0)) return { coupons, redemptionCash: 1 };
  return { coupons, redemptionCash: r };
}

/** Total cash one unit receives along the path. */
export const totalPerUnit = (r: PayoffResult) => r.coupons.reduce((a, b) => a + b, 0) + r.redemptionCash;

// ---- The issuer's side: funding calls, margin, default ------------------------------------------------------

/** One collateral asset in escrow: amount of its token, haircut (fraction), and its price at the strike and each observation. */
export interface CollateralPosition {
  symbol: string;
  amount: number;
  haircut: number;
  /** prices[0] at the strike, prices[k] at observation k (USD: all 1). */
  prices: number[];
}

/** How the issuer behaves along the note's life (everything else: it funds each payment on time). */
export interface IssuerBehaviour {
  /** The period (1-based) whose payment the issuer never funds: the note defaults when its grace ends. */
  missPayment?: number;
  /** The period funded late, inside the grace period: paid, and the note continues. */
  curePayment?: number;
  /** The period funded only partly (fraction of what is due): the note defaults when grace ends. */
  partialPayment?: { period: number; fraction: number };
  /**
   * A margin call at `period` (0 = the strike): `topUp` adds collateral (by symbol, token amounts) within grace,
   * which cures it if coverage then meets the requirement; without it the note defaults.
   */
  marginCall?: { period: number; topUp?: Record<string, number> };
}

export interface NoteScenario {
  /** Worst performance per observation (1 = at strike), as simulatePerf takes. */
  perfs: number[];
  /** Physical settlement: the worst performer's symbol and strike at maturity (units / strike delivered). */
  worstAtMaturity?: { symbol: string; strike: number };
  sold: number;
  /** Required collateral value as a fraction of the outstanding notional. */
  ratio: number;
  collateral: CollateralPosition[];
  behaviour?: IssuerBehaviour;
  /** A fee paid to the paying agent with each coupon, funded with it (servicing-fee template). */
  feePerCoupon?: number;
}

export interface FundingCall {
  period: number;
  /** Cash per unit due to holders (coupon, plus redemption on the final payment). */
  perUnit: number;
  /** Deliverable tokens per unit (physical settlement below the knock-in barrier). */
  deliver?: { symbol: string; perUnit: number };
  fee: number;
  /** Total stablecoin the issuer must fund: perUnit x units sold + fee. */
  total: number;
  final: boolean;
  outcome: 'paid' | 'cured' | 'missed';
}

export interface NoteOutcome {
  calls: FundingCall[];
  /** Coverage at the strike (index 0) and each observation reached, and whether it met the requirement. */
  coverage: Array<{ period: number; value: number; required: number; met: boolean; cured?: boolean }>;
  defaulted?: { period: number; reason: 'payment' | 'margin' };
  /** What one unit of the note received in the end: cash, delivered tokens, collateral in kind. */
  perUnit: { cash: number; deliver: Record<string, number>; collateral: Record<string, number> };
  /** What goes back to the issuer at release, or after a default under 'cap-at-owed' what the holders were not owed. */
  released: Record<string, number>;
  /** Stablecoin left in escrow and returned to the issuer (after a default: what the holders were not owed). */
  leftoverCash: number;
  /** Fees paid to the paying agent. */
  fees: number;
}

/**
 * The note's life with the issuer in the loop: the reference the engine is tested against for funding, margin
 * calls and defaults. Payouts follow simulatePerf; each payment is funded (or not) as `behaviour` says; a
 * default distributes the escrow (collateral in kind, plus any partial funding) pro rata to units.
 */
export function simulateNote(p: ProductParams, s: NoteScenario): NoteOutcome {
  const b = s.behaviour ?? {};
  const ref = simulatePerf(p, s.perfs);
  const n = p.observations;
  const col = s.collateral.map((c) => ({ ...c }));
  const required = s.ratio * s.sold;
  const out: NoteOutcome = {
    calls: [],
    coverage: [],
    perUnit: { cash: 0, deliver: {}, collateral: {} },
    released: {},
    leftoverCash: 0,
    fees: 0,
  };
  let escrowCash = 0;
  const value = (k: number) => col.reduce((a, c) => a + c.amount * (c.prices[k] ?? 1) * c.haircut, 0);
  /**
   * Default at `period`. 'all-to-holders': the whole escrow, pro rata. 'cap-at-owed' (the default rule): the
   * holders take what they are owed, `owedPerUnit` (the missed payment, plus par unless that payment was a
   * redemption), stablecoin first, then each collateral asset at its price then (no haircut); the issuer gets the rest.
   */
  const defaultNow = (period: number, reason: 'payment' | 'margin', owedPerUnit: number) => {
    out.defaulted = { period, reason };
    if ((p.defaultRule ?? 'cap-at-owed') === 'all-to-holders') {
      out.perUnit.cash += escrowCash / s.sold;
      for (const c of col) out.perUnit.collateral[c.symbol] = c.amount / s.sold;
      return out;
    }
    let rem = owedPerUnit * s.sold;
    const cash = Math.max(0, Math.min(escrowCash, rem));
    rem -= cash;
    out.perUnit.cash += cash / s.sold;
    out.leftoverCash = escrowCash - cash;
    for (const c of col) {
      const px = c.prices[period] ?? 1;
      const take = Math.max(0, Math.min(c.amount, rem / px));
      rem -= take * px;
      out.perUnit.collateral[c.symbol] = take / s.sold;
      if (c.amount - take > 0) out.released[c.symbol] = c.amount - take;
    }
    return out;
  };
  const margin = (k: number) => {
    const v = value(k);
    if (v >= required) {
      out.coverage.push({ period: k, value: v, required, met: true });
      return true;
    }
    const call = b.marginCall?.period === k ? b.marginCall : undefined;
    for (const [sym, amt] of Object.entries(call?.topUp ?? {})) {
      const c = col.find((x) => x.symbol === sym);
      if (c) c.amount += amt;
    }
    const cured = !!call?.topUp && value(k) >= required;
    out.coverage.push({ period: k, value: v, required, met: false, cured });
    return cured;
  };
  if (!margin(0)) return defaultNow(0, 'margin', 1);
  const last = ref.calledAt ?? n;
  for (let k = 1; k <= last; k++) {
    if (!margin(k)) return defaultNow(k, 'margin', 1);
    const final = k === last;
    const coupon = ref.coupons[k - 1] ?? 0;
    const knocked =
      final &&
      !ref.calledAt &&
      p.settlement === 'physical' &&
      s.worstAtMaturity &&
      ref.redemptionCash < 1 &&
      p.productType !== 'ppn';
    let perUnit = coupon;
    let deliver: FundingCall['deliver'];
    if (final) {
      if (knocked) deliver = { symbol: s.worstAtMaturity!.symbol, perUnit: 1 / s.worstAtMaturity!.strike };
      else perUnit += ref.redemptionCash;
    }
    if (perUnit <= 0 && !deliver) continue; // nothing due this period
    const fee = s.feePerCoupon && coupon > 0 ? s.feePerCoupon : 0;
    const total = perUnit * s.sold + fee;
    const missed = b.missPayment === k;
    const partial = b.partialPayment?.period === k ? b.partialPayment.fraction : undefined;
    const call: FundingCall = {
      period: k,
      perUnit,
      ...(deliver ? { deliver } : {}),
      fee,
      total,
      final,
      outcome: missed || partial !== undefined ? 'missed' : b.curePayment === k ? 'cured' : 'paid',
    };
    out.calls.push(call);
    if (missed) return defaultNow(k, 'payment', perUnit + (final && !deliver ? 0 : 1));
    if (partial !== undefined) {
      escrowCash += total * partial;
      return defaultNow(k, 'payment', perUnit + (final && !deliver ? 0 : 1));
    }
    out.perUnit.cash += perUnit;
    out.fees += fee;
    if (deliver) out.perUnit.deliver[deliver.symbol] = (out.perUnit.deliver[deliver.symbol] ?? 0) + deliver.perUnit;
  }
  for (const c of col) out.released[c.symbol] = c.amount;
  out.leftoverCash = escrowCash;
  return out;
}

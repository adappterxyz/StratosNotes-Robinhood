/**
 * The note explorer's model: goals, presets and the term sheet it builds. Every payoff number comes from the
 * reference payoff the engine is tested against (packages/core/src/products/payoff.ts); nothing here
 * re-implements it.
 */
import {
  simulatePerf,
  simulateWorstOf,
  totalPerUnit,
  type PayoffResult,
} from '../../../packages/core/src/products/payoff';
import {
  deliverableToken,
  EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF,
  FEEDS,
  HOME_CHAIN,
  PRODUCT_LABELS,
  productUses,
  type ProductParams,
  type ProductType,
} from '../../../packages/core/src/products/params';

export { PRODUCT_LABELS, productUses, totalPerUnit };
export type { ProductType, PayoffResult };

export type Role = 'investor' | 'issuer';
export type Sym = keyof typeof FEEDS;
export const CRYPTO: Sym[] = ['ETH', 'BTC', 'SOL'];
export const STOCKS: Sym[] = ['TSLA', 'AMZN', 'AMD', 'PLTR', 'NVDA', 'AAPL', 'SPY'];

/** What a physically settled note delivers: the real token on Robinhood Chain, where every note is issued (Robinhood's
 * TSLA, AMZN, AMD, PLTR; WETH for ETH), or null: BTC, SOL and the other stocks settle in cash. */
export const deliveredToken = (sym: string) => deliverableToken({ chain: HOME_CHAIN }, sym)?.token ?? null;
/** Physical delivery needs a real token on Robinhood Chain for every underlying. */
export const physicalPossible = (syms: string[]) => syms.every((s) => !!deliveredToken(s));
export const PRODUCTS: ProductType[] = ['fcn', 'reverse-convertible', 'phoenix', 'snowball', 'ppn'];

/** Quarterly over 12 months: four observations, the last one is maturity. */
export const N = 4;
export const MONTHS = [3, 6, 9, 12];

export const SHORT: Record<ProductType, string> = {
  fcn: 'FCN',
  'reverse-convertible': 'Reverse convertible',
  phoenix: 'Phoenix',
  snowball: 'Snowball',
  ppn: 'Protected note',
};

export const BLURB: Record<ProductType, string> = {
  fcn: 'A fixed coupon every period. Called early if the underlying is at or above the autocall level; principal at risk below the knock-in at maturity.',
  'reverse-convertible':
    'A higher fixed coupon every period, held to maturity. Below the knock-in the holder takes the loss, in cash or in the underlying itself.',
  phoenix:
    'A coupon only for periods the underlying holds above the coupon barrier; with memory, missed coupons are paid later. Called early above the autocall level.',
  snowball:
    'No periodic coupon: the coupon accrues and is paid all at once when the note is called, so the longer it runs the more it pays.',
  ppn: 'Principal protected at maturity, plus a share of any rise. No coupons and no knock-in.',
};

export interface Goal {
  id: string;
  label: string;
  detail: string;
  picks: Array<{ t: ProductType; why: string }>;
}

export const GOALS: Record<Role, Goal[]> = {
  investor: [
    {
      id: 'yield',
      label: 'Earn yield',
      detail: 'Income above a USDG savings rate, in exchange for taking some market risk.',
      picks: [
        { t: 'phoenix', why: 'Coupons while the market holds above a barrier; memory catches up missed ones.' },
        { t: 'fcn', why: 'A fixed coupon every period, whatever the market does, until it is called.' },
        { t: 'reverse-convertible', why: 'The highest fixed coupon, if you accept the downside below the knock-in.' },
      ],
    },
    {
      id: 'protect',
      label: 'Protect capital',
      detail: 'Get your money back at maturity and keep some upside.',
      picks: [{ t: 'ppn', why: 'Principal protected at maturity, plus a share of any rise.' }],
    },
    {
      id: 'exposure',
      label: 'Get exposure',
      detail: 'A defined position on a stock, an index or a basket of crypto.',
      picks: [
        { t: 'ppn', why: 'Upside on TSLA, NVDA or a basket, without the downside.' },
        { t: 'snowball', why: 'A larger payout the longer the underlying stays up.' },
        { t: 'phoenix', why: 'A worst-of basket: higher coupons for exposure to several names.' },
      ],
    },
    {
      id: 'hedge',
      label: 'Hedge',
      detail: 'Trade upside you do not need for income, or cap the downside of what you hold.',
      picks: [
        {
          t: 'reverse-convertible',
          why: 'On a stock you hold: earn a coupon, and take delivery of the stock below the barrier.',
        },
        { t: 'ppn', why: 'Keep the upside of a position while principal is protected.' },
      ],
    },
  ],
  issuer: [
    {
      id: 'fund',
      label: 'Raise funding',
      detail: 'Stablecoins now, against pledged collateral, repaid on a schedule.',
      picks: [
        { t: 'fcn', why: 'Predictable funding calls: the same coupon each period.' },
        { t: 'ppn', why: 'No coupons to fund; you repay principal plus a share of any rise.' },
      ],
    },
    {
      id: 'clients',
      label: 'Offer clients a product',
      detail: 'A defined-outcome note your clients already know how to read.',
      picks: [
        { t: 'phoenix', why: 'The most common autocallable: coupons with a barrier, memory and early call.' },
        { t: 'snowball', why: 'One payout at call: simple to explain, and nothing to fund until it calls.' },
        { t: 'ppn', why: 'For clients who need their principal back.' },
      ],
    },
    {
      id: 'view',
      label: 'Express a market view',
      detail: 'Coupons and redemption depend on the market, so the cost of funds does too.',
      picks: [
        { t: 'phoenix', why: 'In a falling market fewer coupons are due.' },
        {
          t: 'reverse-convertible',
          why: 'Below the knock-in you repay less than you raised, or deliver the underlying.',
        },
      ],
    },
  ],
};

export type Preset = 'Rally' | 'Flat' | 'Choppy' | 'Dip & recover' | 'Crash';
export const PRESETS: Record<Preset, number[]> = {
  Rally: [106, 114, 122, 131],
  Flat: [101, 98, 102, 100],
  Choppy: [88, 109, 80, 104],
  'Dip & recover': [93, 71, 86, 107],
  Crash: [84, 63, 52, 46],
};
/** Per-underlying spread around the preset, so a basket's paths differ and one is clearly worst. */
const SPREAD = [1, 1.18, 0.82];
export function presetPaths(p: Preset, count: number): number[][] {
  return Array.from({ length: count }, (_, i) =>
    PRESETS[p].map((v) => clamp(Math.round(100 + (v - 100) * SPREAD[i] + (i === 1 ? -3 : i === 2 ? 2 : 0)), LO, HI)),
  );
}

export const LO = 30,
  HI = 170;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export interface Terms {
  type: ProductType;
  syms: Sym[];
  coupon: number;
  couponBarrier: number;
  memory: boolean;
  autocall: number;
  knockIn: number;
  protection: number;
  participation: number;
  physical: boolean;
}

export function defaultTerms(type: ProductType, syms: Sym[]): Terms {
  const ex = syms.length > 1 && type === 'phoenix' ? EXAMPLE_WORST_OF : EXAMPLE_PRODUCTS[type];
  return {
    type,
    syms,
    coupon: ex.couponRatePct ?? 2.5,
    couponBarrier: ex.couponBarrierPct ?? 70,
    memory: ex.memory ?? true,
    autocall: ex.autocallLevelPct ?? 100,
    knockIn: ex.knockInBarrierPct ?? 60,
    protection: ex.protectionPct ?? 100,
    participation: ex.participationPct ?? 50,
    physical: false,
  };
}

/** The term sheet the reference payoff runs on (four quarterly observations, issued at par). */
export function toParams(t: Terms): ProductParams {
  const ex = EXAMPLE_PRODUCTS[t.type];
  return {
    ...ex,
    name: `${PRODUCT_LABELS[t.type]} on ${t.syms.join(', ')}`,
    observations: N,
    issuePricePct: 100,
    underlyings: t.syms.map((s) => FEEDS[s]),
    couponRatePct: t.coupon,
    couponBarrierPct: t.couponBarrier,
    memory: t.memory,
    autocallLevelPct: t.autocall,
    autocallFromPeriod: ex.autocallFromPeriod ?? 1,
    knockInBarrierPct: t.knockIn,
    protectionPct: t.protection,
    participationPct: t.participation,
    settlement: t.physical && t.type !== 'ppn' ? 'physical' : 'cash',
  };
}

export interface Outcome {
  r: PayoffResult;
  perfs: number[];
  /** Index of the worst performer at each observation. */
  worstIdx: number[];
  total: number;
  /** Observations that actually happened (stops at the call). */
  ran: number;
  knockedIn: boolean;
}

/** Paths are % of strike, one row per underlying. Strikes are 100 for every underlying. */
export function outcome(t: Terms, paths: number[][]): Outcome {
  const p = toParams(t);
  const rows = Array.from({ length: N }, (_, k) => paths.map((path) => path[k]));
  const r =
    t.syms.length > 1
      ? simulateWorstOf(
          p,
          t.syms.map(() => 100),
          rows,
        )
      : simulatePerf(
          p,
          rows.map((row) => row[0] / 100),
        );
  const perfs = rows.map((row) => Math.min(...row) / 100);
  const worstIdx = rows.map((row) => row.indexOf(Math.min(...row)));
  const ran = r.calledAt ?? N;
  const knockedIn =
    !r.calledAt &&
    t.type !== 'ppn' &&
    !(t.type === 'snowball' && perfs[N - 1] * 100 >= t.autocall) &&
    perfs[N - 1] * 100 < t.knockIn;
  return { r, perfs, worstIdx, total: totalPerUnit(r), ran, knockedIn };
}

const pct = (v: number) => `${(v * 100).toFixed((v * 100) % 1 ? 1 : 0)}%`;

/** A plain-English account of what happened, from the investor's side. */
export function explain(t: Terms, o: Outcome): string {
  const u = t.syms.length > 1 ? 'the worst performer' : t.syms[0];
  const lv = (k: number) => pct(o.perfs[k - 1]);
  if (t.type === 'ppn') {
    const f = o.perfs[N - 1];
    return f > 1
      ? `At maturity ${u} was at ${lv(N)} of strike. You get ${t.protection}% of face back plus ${t.participation}% of the ${pct(f - 1)} rise: ${pct(o.r.redemptionCash)} of face.`
      : `At maturity ${u} was at ${lv(N)} of strike, so there is no upside to share. Protection returns ${t.protection}% of face.`;
  }
  const paid = o.r.coupons.filter((c) => c > 0).length;
  const parts: string[] = [];
  if (t.type === 'phoenix') {
    const missed = o.ran - paid;
    parts.push(
      paid === 0
        ? `${u} never closed above the ${t.couponBarrier}% coupon barrier, so no coupon was paid.`
        : missed > 0 && t.memory && o.r.coupons.some((c) => c > t.coupon / 100 + 1e-9)
          ? `${paid} coupon payment${paid > 1 ? 's' : ''}; memory paid the missed ones when ${u} recovered above ${t.couponBarrier}%.`
          : `${paid} of ${o.ran} coupons paid${missed ? `; ${missed} missed below the ${t.couponBarrier}% barrier` : ''}.`,
    );
  } else if (t.type !== 'snowball') {
    parts.push(`${o.ran} fixed coupon${o.ran > 1 ? 's' : ''} of ${t.coupon}%.`);
  }
  if (o.r.calledAt) {
    parts.push(
      `At observation ${o.r.calledAt} ${u} was at ${lv(o.r.calledAt)}, at or above the ${t.autocall}% autocall level: called early and repaid ${pct(o.r.redemptionCash)} of face${t.type === 'snowball' ? ` (par plus ${o.r.calledAt} accrued coupons)` : ''}.`,
    );
  } else if (t.type === 'snowball' && o.perfs[N - 1] * 100 >= t.autocall) {
    parts.push(
      `Not called before maturity; at maturity ${u} was at ${lv(N)}, so the snowball pays par plus all four coupons.`,
    );
  } else if (o.knockedIn) {
    parts.push(
      t.physical
        ? `At maturity ${u} was at ${lv(N)}, below the ${t.knockIn}% knock-in: instead of cash you receive ${u === t.syms[0] && t.syms.length === 1 ? deliveredToken(t.syms[0]) : `the worst performer's token`} (1 ÷ strike per unit), worth ${lv(N)} of face today.`
        : `At maturity ${u} was at ${lv(N)}, below the ${t.knockIn}% knock-in: you are repaid ${lv(N)} of face in cash and take the loss.`,
    );
  } else {
    parts.push(`Held to maturity; ${u} ended at ${lv(N)}, above the ${t.knockIn}% knock-in, so you get par back.`);
  }
  return parts.join(' ');
}

export interface Collateral {
  id: string;
  label: string;
  haircut: number;
}
export const COLLATERAL: Collateral[] = [
  { id: 'USDG', label: 'USDG (Global Dollar)', haircut: 100 },
  { id: 'ETH', label: 'ETH (as WETH)', haircut: 70 },
  { id: 'TSLA', label: 'Robinhood Chain TSLA', haircut: 60 },
  { id: 'AMZN', label: 'Robinhood Chain AMZN', haircut: 60 },
  { id: 'AMD', label: 'Robinhood Chain AMD', haircut: 60 },
  { id: 'PLTR', label: 'Robinhood Chain PLTR', haircut: 60 },
];

export interface Call {
  k: number;
  month: number;
  label: string;
  amount: number;
}

/** The issuer's funding calls per unit of face: each period's coupon, and the redemption when it falls due. */
export function calls(t: Terms, o: Outcome): Call[] {
  const out: Call[] = [];
  for (let k = 1; k <= o.ran; k++) {
    const c = o.r.coupons[k - 1] ?? 0;
    const last = k === o.ran;
    const red = last ? o.r.redemptionCash : 0;
    if (c > 0 || last) {
      const what = [
        c > 0 ? (t.type === 'phoenix' && c > t.coupon / 100 + 1e-9 ? 'coupons (memory)' : 'coupon') : '',
        last ? (o.r.calledAt ? 'early redemption' : 'redemption') : '',
      ]
        .filter(Boolean)
        .join(' + ');
      out.push({ k, month: MONTHS[k - 1], label: what || 'redemption', amount: c + red });
    }
  }
  return out;
}

/**
 * What an investor needs to know about a note, in plain words: the headline yield as an annual rate (labelled
 * honestly: fixed, "up to … if …", or paid at redemption), the term, when you get your money back, early repayment,
 * the collateral behind it, the price per unit and what's left. No product jargon (worst-of, memory, autocall,
 * knock-in, % of strike): those stay under "Full terms" on the note page.
 *
 * The annual rate comes from the coupon per period and how many periods fit in a year. A note's own schedule sets
 * that when its term is a month or more; demo notes run on compressed schedules (minutes or days apart), so for them
 * the rate comes from the product's design (its name's "12M" and number of periods) and says so.
 */
import { payoutMethodOf, type ProductParams } from '@sn/core';

export const ASSET_NAME: Record<string, string> = {
  ETH: 'Ethereum',
  BTC: 'Bitcoin',
  SOL: 'Solana',
  TSLA: 'Tesla',
  NVDA: 'NVIDIA',
  AAPL: 'Apple',
  AMZN: 'Amazon',
  NFLX: 'Netflix',
  SPY: 'S&P 500',
};
const STOCKS = new Set(['TSLA', 'NVDA', 'AAPL', 'AMZN', 'NFLX', 'SPY']);
const YEAR = 365.25 * 86400;
const MONTH = YEAR / 12;

export interface Schedule {
  strikeDate?: number;
  obsDates?: number[];
}

export interface Yield {
  /** e.g. "10%", "Up to 10%" (with rateLabel), or "90% protected + 100% of the upside". */
  headline: string;
  /** Small label under a rate headline: "est. annualized return" (absent for protected notes). */
  rateLabel?: string;
  /** e.g. "in USDG, paid every 3 months". */
  sub: string;
  /** A condition, when the rate is not fixed: "if Tesla stays above 70%". */
  qualifier: string | null;
  /** The annual rate in % (null for protected notes): for sorting. */
  apr: number | null;
  guaranteed: boolean;
}

export interface Listing {
  yield: Yield;
  /** "Tesla & NVIDIA: the weaker one counts". */
  assets: string;
  kind: 'stocks' | 'crypto' | 'mixed';
  goal: 'yield' | 'protect';
  /** "12 months", or "about 3 days (demo schedule)". */
  term: string;
  demo: boolean;
  /** "Your money back if Tesla stays above 60%" / "At least 90% back at the end". */
  protection: string | null;
  /** "Can end early from month 6 if above 100%". */
  early: string | null;
  /** How the money reaches the holder's wallet: claimed by default, or pushed when the issuer opted in. */
  payout: { method: 'claim' | 'push'; text: string; detail: string };
}

/** The payout method line on the term sheet and listing (docs/ERC20-NOTES.md, "Why claim by default"). */
export const PAYOUT_TEXT = {
  claim: {
    text: 'Claim any time from your portfolio',
    detail:
      'Your coupons and redemption build up until you claim them from your portfolio. One claim at maturity collects everything, with a receipt per claim.',
  },
  push: {
    text: 'Paid to your wallet automatically (issuer covers gas)',
    detail:
      'The issuer sends each coupon and the redemption to your wallet and pays the gas, with a receipt per payment. You can also claim yourself from your portfolio at any time.',
  },
} as const;

const round = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
const pct = (x: number) => `${round(x)}%`;

export function assetsPhrase(syms: string[]): string {
  const names = syms.map((s) => ASSET_NAME[s] ?? s);
  if (names.length <= 1) return names[0] ?? 'the underlying';
  const list =
    names.length === 2 ? `${names[0]} & ${names[1]}` : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
  return `${list}: the ${names.length === 2 ? 'weaker one' : 'weakest'} counts`;
}

/** Who the condition is about: "Tesla", or "the weaker one" for a basket. */
const subject = (syms: string[]) =>
  syms.length > 1
    ? syms.length === 2
      ? 'the weaker one'
      : 'the weakest'
    : (ASSET_NAME[syms[0]] ?? syms[0] ?? 'the underlying');

/** The designed term in months, from a product name like "12M Phoenix…" (12 by default). */
function designMonths(p: ProductParams) {
  const m = /(\d+)\s*M\b/i.exec(p.name);
  return m ? Number(m[1]) : 12;
}

/** Length of one period and of the whole note, and whether the dates are a compressed demo. */
export function periods(p: ProductParams, s: Schedule = {}) {
  const n = Math.max(1, p.observations);
  const end = s.obsDates?.[s.obsDates.length - 1];
  const termSec = s.strikeDate && end ? end - s.strikeDate : null;
  if (termSec && termSec >= MONTH) return { n, periodSec: termSec / n, termSec, demo: false };
  const months = designMonths(p);
  return {
    n,
    periodSec: (months * MONTH) / n,
    termSec: months * MONTH,
    demo: !!termSec,
    actualTermSec: termSec ?? undefined,
  };
}

const everyPhrase = (sec: number) => {
  const months = sec / MONTH;
  if (months >= 0.9) {
    const m = Math.round(months);
    return m === 1 ? 'every month' : m === 12 ? 'every year' : `every ${m} months`;
  }
  const days = Math.round(sec / 86400);
  return days <= 1 ? 'every day' : `every ${days} days`;
};
const termPhrase = (sec: number) => {
  const months = Math.round(sec / MONTH);
  if (months >= 1) return months === 12 ? '12 months' : months === 1 ? '1 month' : `${months} months`;
  const days = sec / 86400;
  if (days >= 1) return `about ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  const hours = sec / 3600;
  return hours >= 1 ? `about ${Math.round(hours)} hours` : `about ${Math.max(1, Math.round(sec / 60))} minutes`;
};

export function listingOf(p: ProductParams, s: Schedule = {}, cash = 'USDG'): Listing {
  const syms = p.underlyings.map((u) => u.symbol);
  const who = subject(syms);
  const per = periods(p, s);
  const perYear = YEAR / per.periodSec;
  const rate = p.couponRatePct ?? 0;
  const apr = rate * perYear;
  const every = everyPhrase(per.periodSec);
  let y: Yield;
  if (p.productType === 'ppn') {
    y = {
      headline: `${p.protectionPct ?? 100}% protected + ${p.participationPct ?? 0}% of the upside`,
      sub: `in ${cash} at the end`,
      qualifier: null,
      apr: null,
      guaranteed: (p.protectionPct ?? 0) >= 100,
    };
  } else if (p.productType === 'phoenix') {
    y = {
      headline: `Up to ${pct(apr)}`,
      rateLabel: 'est. annualized return',
      sub: `in ${cash}, paid ${every}`,
      qualifier: `if ${who} stays above ${p.couponBarrierPct ?? 0}%`,
      apr,
      guaranteed: false,
    };
  } else if (p.productType === 'snowball') {
    y = {
      headline: `Up to ${pct(apr)}`,
      rateLabel: 'est. annualized return',
      sub: `in ${cash}, paid at redemption`,
      qualifier: `only if it ends early or ${who} is above ${p.autocallLevelPct ?? 100}% at the end`,
      apr,
      guaranteed: false,
    };
  } else {
    y = {
      headline: `${pct(apr)}`,
      rateLabel: 'est. annualized return',
      sub: `in ${cash}, paid ${every}`,
      qualifier: null,
      apr,
      guaranteed: true,
    };
  }
  let protection: string | null = null;
  if (p.productType === 'ppn') protection = `At least ${p.protectionPct ?? 100}% of your money back at the end`;
  else if (p.knockInBarrierPct)
    protection = `Your money back if ${who} stays above ${p.knockInBarrierPct}%${p.settlement === 'physical' ? '; below it, you get the stock' : ''}`;
  let early: string | null = null;
  if (p.autocallLevelPct && (p.productType === 'fcn' || p.productType === 'phoenix' || p.productType === 'snowball')) {
    const from = Math.max(1, p.autocallFromPeriod ?? 1);
    const at = per.demo
      ? `from date ${from}`
      : (() => {
          const m = Math.round((from * per.periodSec) / MONTH);
          return m >= 1 ? `from month ${m}` : `from date ${from}`;
        })();
    early = `Can end early ${at} if above ${p.autocallLevelPct}%`;
  }
  const stocks = syms.filter((x) => STOCKS.has(x)).length;
  return {
    yield: y,
    assets: assetsPhrase(syms),
    kind: stocks === syms.length ? 'stocks' : stocks === 0 ? 'crypto' : 'mixed',
    goal: p.productType === 'ppn' ? 'protect' : 'yield',
    term: per.demo && per.actualTermSec ? `${termPhrase(per.actualTermSec)} (demo schedule)` : termPhrase(per.termSec),
    demo: per.demo,
    protection,
    early,
    payout: { method: payoutMethodOf(p), ...PAYOUT_TEXT[payoutMethodOf(p)] },
  };
}

export type SimpleStatus = 'open' | 'running' | 'paid' | 'defaulted';
export const SIMPLE_STATUS_LABEL: Record<SimpleStatus, string> = {
  open: 'Open',
  running: 'Running',
  paid: 'Paid in full',
  defaulted: 'Defaulted',
};
export function simpleStatus(phase: string): SimpleStatus {
  if (phase === 'book') return 'open';
  if (phase === 'redeemed') return 'paid';
  if (phase === 'defaulted') return 'defaulted';
  return 'running';
}

/** "in 2 days", "in 5 hours", "in 12 minutes". */
export function inTime(at: number, now: number) {
  const s = at - now;
  if (s <= 0) return 'now';
  if (s >= 86400) {
    const d = Math.round(s / 86400);
    return `in ${d} day${d === 1 ? '' : 's'}`;
  }
  if (s >= 3600) {
    const h = Math.round(s / 3600);
    return `in ${h} hour${h === 1 ? '' : 's'}`;
  }
  const m = Math.max(1, Math.round(s / 60));
  return `in ${m} minute${m === 1 ? '' : 's'}`;
}

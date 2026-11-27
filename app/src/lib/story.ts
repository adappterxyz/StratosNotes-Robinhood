/**
 * A note in plain words and pictures, from its terms (@sn/core): a name a person would use ("Income while Tesla and
 * NVIDIA hold 70%"), the lines that decide it (money-back, coupon, early repayment), where each underlying sits
 * against them now, what holders got when it finished, and "play the note": what a path of prices would pay, worked
 * out with the reference payoff (simulatePerf), never with maths of its own.
 *
 * Nothing here knows a chain or a token list: names come from the Chainlink catalogue and each chain's own tokens, so
 * new underlyings and chains show up without changes.
 */
import { catalogueFeed, CHAIN_TOKENS, simulatePerf, type ProductParams, type ProductType } from '@sn/core';
import type { NoteView } from '@sn/sdk';
import { periods, type Schedule } from './listing';

// ---- names ------------------------------------------------------------------------------------------------------

const OVERRIDE: Record<string, string> = { SPY: 'S&P 500', EUR: 'the euro', GBP: 'the pound', JPY: 'the yen' };

/** "Tesla", "Bitcoin", "NVIDIA": the catalogue's name, else a chain token's, else the ticker. */
export function assetName(sym: string): string {
  const base = sym.replace(/\.[a-z]+$/, '');
  if (OVERRIDE[base]) return OVERRIDE[base];
  const f = catalogueFeed(base);
  if (f) return f.name.replace(/ \(.*\)$/, '');
  for (const chain of Object.values(CHAIN_TOKENS)) {
    const t = chain[base];
    if (t) return t.name;
  }
  return base;
}

type Kind = 'stock' | 'coin' | 'currency' | 'asset';
const kindOf = (sym: string): Kind => {
  const c = catalogueFeed(sym)?.assetClass;
  return c === 'Stocks' || c === 'Stock tokens'
    ? 'stock'
    : c === 'Crypto'
      ? 'coin'
      : c === 'Forex'
        ? 'currency'
        : 'asset';
};
/** What a basket is made of: "stock" when every one is a stock, and so on. */
export function basketKind(syms: string[]): Kind {
  const k = syms.map(kindOf);
  return k.every((x) => x === k[0]) ? (k[0] ?? 'asset') : 'asset';
}

/** "Tesla", "Tesla and NVIDIA", "Ethereum, Bitcoin and Solana". */
export function namesList(syms: string[]): string {
  const n = syms.map(assetName);
  if (n.length <= 1) return n[0] ?? 'the underlying';
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/** Who a condition is about: "Tesla", "the weaker stock", "the weakest of the three". */
export function subjectOf(syms: string[]): string {
  if (syms.length <= 1) return assetName(syms[0] ?? 'the underlying');
  const k = basketKind(syms);
  const what = k === 'asset' ? 'one' : k;
  return syms.length === 2 ? `the weaker ${what}` : `the weakest ${what}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The product type as a short tag: "Phoenix · worst-of". */
export const PRODUCT_TAG: Record<ProductType, string> = {
  fcn: 'Fixed coupon',
  'reverse-convertible': 'Reverse convertible',
  phoenix: 'Phoenix',
  snowball: 'Snowball',
  ppn: 'Capital protected',
};
export const productTag = (p: ProductParams) =>
  `${PRODUCT_TAG[p.productType]}${p.underlyings.length > 1 ? ' · worst-of' : ''}`;

/**
 * The note's name in plain words, from its terms (not the issuer's name for it):
 *  phoenix   "Income while Tesla and NVIDIA hold 70%"
 *  fcn       "Fixed income on Ethereum, protected to 60%"
 *  rc        "High income on Tesla, protected to 70%"
 *  snowball  "Growing payout on Bitcoin, repaid above 100%"
 *  ppn       "90% protected, plus Solana's rise"
 */
export function plainName(p: ProductParams): string {
  const syms = p.underlyings.map((u) => u.symbol);
  const names = namesList(syms);
  const many = syms.length > 1;
  switch (p.productType) {
    case 'phoenix':
      return `Income while ${names} ${many ? 'hold' : 'holds'} ${p.couponBarrierPct ?? 0}%`;
    case 'fcn':
      return `Fixed income on ${names}${p.knockInBarrierPct ? `, protected to ${p.knockInBarrierPct}%` : ''}`;
    case 'reverse-convertible':
      return `High income on ${names}${p.knockInBarrierPct ? `, protected to ${p.knockInBarrierPct}%` : ''}`;
    case 'snowball':
      return `Growing payout on ${names}, repaid above ${p.autocallLevelPct ?? 100}%`;
    case 'ppn':
      return `${p.protectionPct ?? 100}% protected, plus ${many ? `the weakest of ${names}` : `${names}'s`} rise`;
  }
}

// ---- the lines ----------------------------------------------------------------------------------------------------

export type LineKey = 'knockIn' | 'coupon' | 'autocall' | 'start';
export interface NoteLine {
  key: LineKey;
  /** % of the starting price (the strike). */
  pct: number;
  label: string;
}
export type ZoneTone = 'loss' | 'safe' | 'coupon' | 'call' | 'gain';
export interface Zone {
  from: number;
  to: number;
  tone: ZoneTone;
  text: string;
}

const autocalls = (t: ProductType) => t === 'fcn' || t === 'phoenix' || t === 'snowball';
export const LINE_LABEL: Record<LineKey, string> = {
  knockIn: 'money-back line',
  coupon: 'coupon line',
  autocall: 'early-repayment line',
  start: 'starting price',
};

/** The lines that decide this note, lowest first (a product without a line simply has none). */
export function linesOf(p: ProductParams): NoteLine[] {
  const out: NoteLine[] = [];
  if (p.productType === 'ppn') return [{ key: 'start', pct: 100, label: LINE_LABEL.start }];
  if (p.knockInBarrierPct) out.push({ key: 'knockIn', pct: p.knockInBarrierPct, label: LINE_LABEL.knockIn });
  if (p.productType === 'phoenix' && p.couponBarrierPct !== undefined)
    out.push({ key: 'coupon', pct: p.couponBarrierPct, label: LINE_LABEL.coupon });
  if (autocalls(p.productType) && p.autocallLevelPct)
    out.push({ key: 'autocall', pct: p.autocallLevelPct, label: LINE_LABEL.autocall });
  return out.sort((a, b) => a.pct - b.pct);
}

/** What a level means for the note (at a check, or at maturity for the money-back line). */
function toneAt(p: ProductParams, x: number): ZoneTone {
  if (p.productType === 'ppn') return x >= 100 ? 'gain' : 'safe';
  if (autocalls(p.productType) && p.autocallLevelPct && x >= p.autocallLevelPct) return 'call';
  if (p.knockInBarrierPct && x < p.knockInBarrierPct) return 'loss';
  if (p.productType === 'phoenix') return x >= (p.couponBarrierPct ?? 0) ? 'coupon' : 'safe';
  if (p.productType === 'fcn' || p.productType === 'reverse-convertible') return 'coupon';
  return 'safe';
}

function zoneText(p: ProductParams, tone: ZoneTone): string {
  const physical = p.settlement === 'physical';
  switch (tone) {
    case 'loss':
      return p.productType === 'fcn' || p.productType === 'reverse-convertible'
        ? `coupons, but at the end you share the fall${physical ? ' (paid in the stock)' : ''}`
        : `at the end you share the fall${physical ? ' (paid in the stock)' : ''}`;
    case 'safe':
      return p.productType === 'ppn'
        ? `${p.protectionPct ?? 100}% back at the end`
        : p.productType === 'snowball'
          ? 'money back, payout keeps growing'
          : 'money back, no coupon';
    case 'coupon':
      return 'coupon paid';
    case 'call':
      return p.productType === 'snowball' ? 'repaid early with the payout' : 'repaid early';
    case 'gain':
      return `plus ${p.participationPct ?? 0}% of the rise`;
  }
}

/** The band's range (% of strike) for these lines and markers. */
export function bandRange(lines: NoteLine[], marks: number[] = []) {
  const all = [...lines.map((l) => l.pct), ...marks, 100];
  const lo = Math.max(0, Math.min(30, Math.floor((Math.min(...all) - 12) / 10) * 10));
  const hi = Math.max(130, Math.ceil((Math.max(...all) + 12) / 10) * 10);
  return { lo, hi: Math.min(hi, 400) };
}

/** The coloured zones between the lines, from `lo` to `hi`. */
export function zonesOf(p: ProductParams, lo: number, hi: number): Zone[] {
  const cuts = [
    lo,
    ...linesOf(p)
      .map((l) => l.pct)
      .filter((x) => x > lo && x < hi),
    hi,
  ];
  const zones: Zone[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const tone = toneAt(p, (cuts[i] + cuts[i + 1]) / 2);
    const last = zones[zones.length - 1];
    if (last && last.tone === tone) last.to = cuts[i + 1];
    else zones.push({ from: cuts[i], to: cuts[i + 1], tone, text: zoneText(p, tone) });
  }
  return zones;
}

// ---- where the note stands ---------------------------------------------------------------------------------------

export interface Mark {
  sym: string;
  /** % of its strike. */
  pct: number;
  worst: boolean;
}

/** Each underlying's latest level against its strike (none before the strike is fixed). */
export function marksOf(o: Pick<NoteView, 'unds'>): Mark[] {
  const m = o.unds
    .map((u) => {
      const last = u.observed[u.observed.length - 1];
      if (!u.strike) return null;
      return { sym: u.symbol, pct: last === undefined ? 100 : (last / u.strike) * 100, worst: false };
    })
    .filter((x): x is Mark => !!x);
  if (m.length) {
    const w = m.reduce((a, b) => (b.pct < a.pct ? b : a));
    w.worst = true;
  }
  return m;
}

const pts = (x: number) => `${Math.abs(x).toFixed(1)} point${Math.abs(x).toFixed(1) === '1.0' ? '' : 's'}`;

/** One plain sentence: where the weakest underlying sits against the line that matters most. */
export function barSentence(p: ProductParams, marks: Mark[], past = false): string | null {
  const w = marks.find((m) => m.worst);
  if (!w) return null;
  const syms = p.underlyings.map((u) => u.symbol);
  const name = syms.length > 1 ? `${subjectOf(syms)} (${assetName(w.sym)})` : assetName(syms[0] ?? w.sym);
  const who = past ? `At the last check, ${name}` : cap(name);
  const is = past ? 'was' : 'is';
  const lines = linesOf(p);
  if (p.productType === 'ppn') {
    const d = w.pct - 100;
    return d >= 0
      ? `${who} ${is} ${pts(d)} above its starting price: holders share the rise.`
      : `${who} ${is} ${pts(d)} below its starting price: ${p.protectionPct ?? 100}% comes back at the end anyway.`;
  }
  const below = [...lines].reverse().find((l) => w.pct >= l.pct);
  if (!below) {
    const first = lines[0];
    if (!first) return null;
    return `${who} ${is} ${pts(first.pct - w.pct)} below the ${first.label}.`;
  }
  const above = lines.find((l) => l.pct > w.pct);
  const base = `${who} ${is} ${pts(w.pct - below.pct)} above the ${below.label}`;
  if (below.key === 'autocall') return past ? `${base}.` : `${base}: on a check that allows it, the note repays early.`;
  if (above && !past) return `${base}, ${pts(above.pct - w.pct)} short of the ${above.label}.`;
  return `${base}.`;
}

// ---- what you get, the main risk ---------------------------------------------------------------------------------

/** What you get, in one sentence. */
export function getLine(p: ProductParams, cash: string): string {
  const syms = p.underlyings.map((u) => u.symbol);
  const who = subjectOf(syms);
  const rate = p.couponRatePct ?? 0;
  const n = p.observations;
  switch (p.productType) {
    case 'phoenix':
      return `${rate}% in ${cash} at each of ${n} checks where ${who} is at or above ${p.couponBarrierPct}% of its starting price${p.memory ? ', and any coupons missed before' : ''}.`;
    case 'fcn':
    case 'reverse-convertible':
      return `${rate}% in ${cash} at each of ${n} checks, whatever the price does.`;
    case 'snowball':
      return `${rate}% for every check so far, paid when the note repays: early if ${who} is at or above ${p.autocallLevelPct ?? 100}%.`;
    case 'ppn':
      return `At least ${p.protectionPct ?? 100}% of your money back at the end, plus ${p.participationPct ?? 0}% of any rise in ${who}.`;
  }
}

/** The main risk, in one sentence. */
export function riskLine(p: ProductParams, cash: string): string {
  const syms = p.underlyings.map((u) => u.symbol);
  const who = subjectOf(syms);
  if (p.productType === 'ppn')
    return (p.protectionPct ?? 100) >= 100
      ? `If ${who} ends below its starting price you earn nothing on top, and you rely on the issuer's collateral.`
      : `If ${who} falls, you get back ${p.protectionPct}%: up to ${100 - (p.protectionPct ?? 100)}% less than you paid.`;
  const ki = p.knockInBarrierPct;
  if (!ki) return `Payments rely on the issuer's collateral.`;
  return p.settlement === 'physical'
    ? `If ${who} ends below ${ki}% of its starting price, you get the stock instead of your ${cash}, worth less than you paid.`
    : `If ${who} ends below ${ki}% of its starting price, you get back only what it is worth then (for example 50 per 100 if it halved).`;
}

// ---- status, countdown and what holders got ------------------------------------------------------------------------

/** The next check (or the book closing) and how long until it, for a note still running. */
export function nextCheck(o: NoteView, now: number): { label: string; at: number } | null {
  if (o.phase === 'book') return o.strikeDate ? { label: 'Book closes', at: o.strikeDate } : null;
  if (o.phase === 'fixing') return o.strikeDate ? { label: 'Starting price fixed', at: o.strikeDate } : null;
  if (o.phase !== 'live') return null;
  const k = o.perfs.length;
  const at = o.obsDates[k];
  if (!at) return null;
  return { label: k === o.obsDates.length - 1 ? 'Final check' : `Check ${k + 1}`, at: Math.max(at, now - 1) };
}

/** "2d 4h", "3:42", "now". */
export function countdown(at: number, now: number): string {
  let s = Math.round(at - now);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export type Calm = 'open' | 'running' | 'repaid-early' | 'matured' | 'loss' | 'collateral';
export const CALM_LABEL: Record<Calm, string> = {
  open: 'Open to buy',
  running: 'Running',
  'repaid-early': 'Repaid early',
  matured: 'Finished',
  loss: 'Finished below the line',
  collateral: 'Paid from collateral',
};

/**
 * The note's status, calm: a default reads as "Paid from collateral" with what holders received, not an alarm.
 * `story` says what happened, for a finished note.
 */
export function statusOf(o: NoteView, cash: string): { key: Calm; story: string | null } {
  const l = periods(o.params, { strikeDate: o.strikeDate, obsDates: o.obsDates });
  const demo = l.demo && l.actualTermSec ? ` This was a ${termWords(l.actualTermSec)} demo.` : '';
  const paid = o.outcome?.perUnit ?? 0;
  if (o.phase === 'book') return { key: 'open', story: null };
  if (o.phase === 'fixing' || o.phase === 'live') return { key: 'running', story: null };
  if (o.phase === 'defaulted') {
    const e = o.economics;
    const missed = e?.periods.find((x) => x.status === 'missed');
    const final = missed && missed.k === (o.outcome?.calledAt ?? o.params.observations);
    const owed = missed?.perUnit != null ? missed.perUnit + (final ? 0 : 1) : null;
    const margin = e?.milestones.some((m) => m.name === 'margin-call') && !missed;
    const before = paid > 0 ? `After ${fmt(paid)} ${cash} of coupons, the` : 'The';
    const what = margin
      ? 'did not top up its collateral'
      : `missed the payment${missed ? ` due at check ${missed.k}` : ''}`;
    const rule =
      e?.defaultRule === 'all-to-holders'
        ? 'holders received everything locked in the note'
        : owed !== null
          ? `holders were paid what they were owed, ${fmt(owed)} ${cash} per unit, from the collateral locked for them`
          : 'holders were paid what they were owed from the collateral locked for them';
    return { key: 'collateral', story: `${before} issuer ${what}, so ${rule}.${demo}` };
  }
  // redeemed
  if (o.outcome?.calledAt)
    return {
      key: 'repaid-early',
      story: `Repaid early at check ${o.outcome.calledAt}: holders got ${fmt(paid)} ${cash} per unit in all.${demo}`,
    };
  const last = o.perfs[o.perfs.length - 1];
  const ki = o.params.knockInBarrierPct;
  if (ki && last !== undefined && last * 100 < ki && o.params.productType !== 'ppn')
    return {
      key: 'loss',
      story: `Ended at ${(last * 100).toFixed(1)}%, below the ${ki}% money-back line: holders got ${o.params.settlement === 'physical' ? 'the stock' : `${fmt(paid)} ${cash} per unit`}.${demo}`,
    };
  return { key: 'matured', story: `Held to the end: holders got ${fmt(paid)} ${cash} per unit in all.${demo}` };
}

const fmt = (x: number) => (Math.round(x * 10000) / 10000).toString();
/** The term in a few words: "12 months", or "3-day demo" for a compressed demo schedule. */
export function termShort(p: ProductParams, s: Schedule = {}): string {
  const per = periods(p, s);
  if (per.demo && per.actualTermSec) return `${termWords(per.actualTermSec)} demo`;
  const m = Math.round(per.termSec / ((365.25 * 86400) / 12));
  return m === 1 ? '1 month' : `${m} months`;
}

function termWords(sec: number) {
  const d = sec / 86400;
  if (d >= 1) return `${Math.round(d)}-day`;
  const h = sec / 3600;
  return h >= 1 ? `${Math.round(h)}-hour` : `${Math.max(1, Math.round(sec / 60))}-minute`;
}

// ---- play the note --------------------------------------------------------------------------------------------------

export type EventKind = 'coupon' | 'none' | 'call' | 'par' | 'loss' | 'protected';
export interface PlayEvent {
  /** Check number (1-based). */
  k: number;
  kind: EventKind;
  /** Per 100 of face. */
  amount: number;
  text: string;
}
export interface Played {
  events: PlayEvent[];
  /** Everything 100 of face receives. */
  total: number;
  coupons: number;
  how: 'call' | 'par' | 'loss' | 'protected';
  calledAt?: number;
}

/**
 * Plays a path through the note: `perfs[k - 1]` is the worst level (% of strike) at check k. The amounts are the
 * reference payoff's (simulatePerf), per 100 of face; this only puts them into words.
 */
export function playOut(p: ProductParams, perfs: number[]): Played {
  const r = simulatePerf(
    p,
    perfs.map((x) => x / 100),
  );
  const n = p.observations;
  const rate = p.couponRatePct ?? 0;
  const last = r.calledAt ?? n;
  const events: PlayEvent[] = [];
  const syms = p.underlyings.map((u) => u.symbol);
  const who = cap(subjectOf(syms));
  const at = (k: number) => `${Math.round(perfs[k - 1])}%`;
  for (let k = 1; k <= last; k++) {
    const c = (r.coupons[k - 1] ?? 0) * 100;
    if (k === r.calledAt) {
      const red = r.redemptionCash * 100;
      events.push({
        k,
        kind: 'call',
        amount: red + c,
        text: `Check ${k}: ${at(k)}, at or above ${p.autocallLevelPct}%. Repaid early: ${p.productType === 'snowball' ? `100 plus ${round(red - 100)} for ${k} period${k === 1 ? '' : 's'}` : `100 back${c ? ' with the coupon' : ''}`}.`,
      });
      break;
    }
    if (k < n || (k === n && c > 0)) {
      if (c > 0) {
        const memo = rate > 0 && c > rate * 1.0001 ? `, with ${Math.round(c / rate) - 1} missed before` : '';
        events.push({
          k,
          kind: 'coupon',
          amount: c,
          text: `Check ${k}: ${at(k)}. Coupon paid${memo}.`,
        });
      } else if (k < n) {
        events.push({
          k,
          kind: 'none',
          amount: 0,
          text:
            p.productType === 'phoenix'
              ? `Check ${k}: ${at(k)}, below the ${p.couponBarrierPct}% coupon line. No coupon this time.`
              : p.productType === 'snowball'
                ? `Check ${k}: ${at(k)}, below ${p.autocallLevelPct}%. Not repaid yet; the payout grows.`
                : `Check ${k}: ${at(k)}.`,
        });
      }
    }
    if (k === n) {
      const red = r.redemptionCash * 100;
      if (p.productType === 'ppn') {
        events.push({
          k,
          kind: 'protected',
          amount: red,
          text:
            red > (p.protectionPct ?? 100)
              ? `End: ${at(k)}. ${p.protectionPct}% back plus ${p.participationPct}% of the ${round(perfs[k - 1] - 100)}-point rise.`
              : `End: ${at(k)}. ${p.protectionPct}% back, whatever happened.`,
        });
      } else if (red >= 100) {
        events.push({
          k,
          kind: 'par',
          amount: red,
          text:
            p.productType === 'snowball' && red > 100
              ? `End: ${at(k)}, at or above ${p.autocallLevelPct}%. 100 back plus ${round(red - 100)} for every period.`
              : `End: ${at(k)}${p.knockInBarrierPct ? `, above the ${p.knockInBarrierPct}% money-back line` : ''}. The full 100 comes back.`,
        });
      } else {
        events.push({
          k,
          kind: 'loss',
          amount: red,
          text: `End: ${at(k)}, below the ${p.knockInBarrierPct}% money-back line. ${who} lost ${round(100 - red)}%, so you get ${round(red)} per 100${p.settlement === 'physical' ? ', paid in the stock' : ''}.`,
        });
      }
    }
  }
  const total = events.reduce((a, e) => a + e.amount, 0);
  const red = r.redemptionCash * 100;
  return {
    events,
    total,
    coupons: round(total - red),
    how: r.calledAt ? 'call' : p.productType === 'ppn' ? 'protected' : red >= 100 ? 'par' : 'loss',
    calledAt: r.calledAt,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;

export interface Scenario {
  id: string;
  label: string;
  perfs: number[];
}

/** A few paths through the note, shaped by its own lines, so each shows something different. */
export function scenarios(p: ProductParams): Scenario[] {
  const n = Math.max(1, p.observations);
  const ki = p.knockInBarrierPct ?? 60;
  const t = (k: number) => k / n;
  const path = (f: (x: number) => number) =>
    Array.from({ length: n }, (_, i) => Math.round(Math.max(20, Math.min(180, f(t(i + 1))))));
  const syms = p.underlyings.map((u) => u.symbol);
  const who = syms.length > 1 ? 'Everything' : assetName(syms[0] ?? '');
  return [
    { id: 'rally', label: `${who} rallies`, perfs: path((x) => 104 + 18 * x) },
    { id: 'drift', label: 'Drifts lower', perfs: path((x) => 98 - (100 - ki - 6) * x) },
    {
      id: 'dip',
      label: 'Dips, then recovers',
      perfs: n === 1 ? [92] : path((x) => (x < 0.99 ? ki - 4 + 30 * Math.abs(x - 0.5) : 96)),
    },
    { id: 'crash', label: 'Crashes', perfs: path((x) => 90 - (100 - ki + 15) * x) },
  ];
}

/** What a check is called on the note's own calendar: "month 4", or "check 2" when the schedule is a demo. */
export function checkWhen(p: ProductParams, k: number, s: Schedule = {}): string {
  const per = periods(p, s);
  if (per.demo) return `check ${k}`;
  const m = Math.round((k * per.periodSec) / ((365.25 * 86400) / 12));
  return m >= 1 ? `month ${m}` : `check ${k}`;
}

// ---- for issuers: a simple risk reading ----------------------------------------------------------------------------

/**
 * A rough 1–5 reading of how much an investor can lose and how likely, for the issue preview: a deep money-back
 * line and a modest coupon read low, a shallow line, a basket, a long term and a rich coupon read higher. A guide
 * for people, not a model.
 */
export function riskLevel(p: ProductParams): { level: 1 | 2 | 3 | 4 | 5; text: string } {
  if (p.productType === 'ppn') {
    const prot = p.protectionPct ?? 100;
    return prot >= 100
      ? { level: 1, text: 'Low: all the money back at the end, whatever happens.' }
      : { level: 2, text: `Low to moderate: at most ${100 - prot}% can be lost.` };
  }
  const ki = p.knockInBarrierPct ?? 0;
  const rate = (p.couponRatePct ?? 0) * Math.max(1, p.observations);
  let score = (ki - 40) / 15 + rate / 12 + (p.underlyings.length - 1) * 0.6 + (p.observations > 6 ? 0.4 : 0);
  if (!ki) score = 1;
  const level = Math.max(1, Math.min(5, Math.round(score))) as 1 | 2 | 3 | 4 | 5;
  const fall = 100 - ki;
  const text = [
    'Low: a deep money-back line and a modest coupon.',
    `Low to moderate: investors lose money only after a fall of more than ${fall}%.`,
    `Moderate: a fall of more than ${fall}% by the end costs investors money.`,
    `High: investors share any loss below ${ki}%${p.underlyings.length > 1 ? ', and the weakest of several decides' : ''}.`,
    `Very high: a shallow money-back line at ${ki}% for this coupon.`,
  ][level - 1];
  return { level, text };
}

/**
 * Term sheet -> ProductParams + this issuance's schedule (Flow's
 * ai/extract-product.ts, for StratosNotes). The generation model fills a flat
 * JSON schema (null for anything not stated); deterministic code converts
 * coupons, applies documented defaults (each one a visible note), and
 * validates; errors go back to the model for a bounded repair. What reaches
 * the issuer is always a valid input to a verified payoff engine.
 */
import type { AiRunner, ChatMessage } from './runner';
import {
  COLLATERAL_SYMBOLS,
  DEFAULT_HAIRCUT,
  FEEDS,
  PRODUCT_LABELS,
  productUses,
  validateProductParams,
  type CollateralSymbol,
  type ProductParams,
  type ProductType,
} from '../products/params';

export interface Schedule {
  /** Observation spacing and count; the strike date is set when issuing. */
  every: number;
  unit: 'months' | 'days' | 'minutes';
  count: number;
  /** Size of this issuance, when stated. */
  size?: number;
}
export interface ExtractedProduct {
  params: ProductParams;
  schedule: Schedule;
  notes: string[];
}

interface Draft {
  productType: ProductType | null;
  name: string | null;
  size: number | null;
  issuePricePct: number | null;
  underlyingSymbols: string[] | null;
  observationEveryMonths: number | null;
  observationCount: number | null;
  couponRatePct: number | null;
  couponAsStated: string | null;
  couponRateBasis: 'per-annum' | 'per-period' | null;
  couponBarrierPct: number | null;
  memory: boolean | null;
  autocallLevelPct: number | null;
  autocallFromPeriod: number | null;
  knockInBarrierPct: number | null;
  protectionPct: number | null;
  participationPct: number | null;
  collateralSymbols: string[] | null;
  collateralRatioPct: number | null;
  haircutPcts: number[] | null;
  settlementLagDays: number | null;
  gracePeriodDays: number | null;
}

const num = { type: ['number', 'null'] };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    productType: { type: ['string', 'null'], enum: [...Object.keys(PRODUCT_LABELS), null] },
    name: { type: ['string', 'null'], description: 'Short display name, e.g. "12M Phoenix on ETH"' },
    size: { ...num, description: 'Issuance size in USDG of face' },
    issuePricePct: { ...num, description: 'Issue price, % of face' },
    underlyingSymbols: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description: 'Tickers, e.g. ["ETH"]; several for a worst-of basket, e.g. ["ETH", "BTC"]',
    },
    observationEveryMonths: { type: ['integer', 'null'] },
    observationCount: { type: ['integer', 'null'], description: 'Number of observations; the last one is maturity' },
    couponRatePct: { ...num, description: 'The coupon rate exactly as stated, % of face' },
    couponAsStated: {
      type: ['string', 'null'],
      description: 'The words of the request that state the coupon, copied exactly',
    },
    couponRateBasis: { type: ['string', 'null'], enum: ['per-annum', 'per-period', null] },
    couponBarrierPct: { ...num, description: '% of the initial level' },
    memory: { type: ['boolean', 'null'] },
    autocallLevelPct: { ...num, description: '% of the initial level' },
    autocallFromPeriod: { type: ['integer', 'null'], description: 'First observation (1-based) that can autocall' },
    knockInBarrierPct: { ...num, description: '% of the initial level' },
    protectionPct: { ...num, description: 'Capital protection, % of face' },
    participationPct: num,
    collateralSymbols: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description: `What the issuer pledges as collateral: ${COLLATERAL_SYMBOLS.join(', ')} (USD = the stablecoin)`,
    },
    collateralRatioPct: {
      ...num,
      description: 'Collateral value required, % of the outstanding notional (e.g. "fully secured" = 100)',
    },
    haircutPcts: {
      type: ['array', 'null'],
      items: { type: 'number' },
      description:
        'Share of market value counted per collateral asset, % (same order as collateralSymbols), only if stated',
    },
    settlementLagDays: { ...num, description: 'Days between an observation and its payment date, only if stated' },
    gracePeriodDays: { ...num, description: 'Grace period for a late payment, days (0-7), only if stated' },
  },
  required: [
    'productType',
    'name',
    'size',
    'issuePricePct',
    'underlyingSymbols',
    'observationEveryMonths',
    'observationCount',
    'couponRatePct',
    'couponAsStated',
    'couponRateBasis',
    'couponBarrierPct',
    'memory',
    'autocallLevelPct',
    'autocallFromPeriod',
    'knockInBarrierPct',
    'protectionPct',
    'participationPct',
    'collateralSymbols',
    'collateralRatioPct',
    'haircutPcts',
    'settlementLagDays',
    'gracePeriodDays',
  ],
};

function system(today: string): string {
  return `You extract structured-note term sheets into JSON for StratosNotes (notes run on Robinhood Chain, observed by Chainlink; each note is secured by collateral the issuer pledges on Robinhood Chain: USDG, WETH, or Robinhood's stock tokens TSLA, AMZN, AMD, PLTR). Today is ${today}.
Products: ${Object.entries(PRODUCT_LABELS)
    .map(([k, v]) => `${k} = ${v}`)
    .join('; ')}.
Rules:
- Use only terms the user states or that follow directly from them. Use null for anything not stated; never invent a level.
- Coupon: give the rate as stated and say whether it is per annum or per observation period; the conversion is done for you.
- Schedule: a 12-month note observed quarterly has 4 observations every 3 months.
- Barrier and autocall levels are % of the initial (strike) level.
- Several underlyings ("worst of ETH and BTC", "on a basket of BTC, ETH, SOL") make a worst-of note: list every ticker.
- Collateral: the assets the issuer pledges ("secured by USDG" or "USDC" -> ["USD"]; "ETH collateral" -> ["ETH"]) and the share of the notional it must cover; haircuts, settlement lag and grace period only if stated.
- Name: short, e.g. "12M Phoenix on ETH".`;
}

const ANNUAL = /\bp\.?\s?a\b|per\s+annum|(?<!semi-?\s?)annual|a\s+year|per\s+year|yearly/i;
export const SUPPORTED_UNDERLYINGS = Object.keys(FEEDS);

function toParams(d: Draft, prompt: string, notes: string[]): { params: ProductParams; schedule: Schedule } {
  const t = (d.productType ?? 'fcn') as ProductType;
  const dflt = <T>(v: T | null | undefined, fallback: T, note: string): T => {
    if (v === null || v === undefined) {
      if (note) notes.push(note);
      return fallback;
    }
    return v;
  };
  const every = dflt(d.observationEveryMonths, 3, 'Observation frequency not stated: quarterly assumed.');
  const count = dflt(
    d.observationCount,
    t === 'ppn' ? 1 : 4,
    `Number of observations not stated: ${t === 'ppn' ? 1 : 4} assumed.`,
  );
  // Unsupported symbols are refused before this.
  const syms = [...new Set((d.underlyingSymbols ?? []).map(cleanSymbol).filter((s) => s in FEEDS))] as Array<
    keyof typeof FEEDS
  >;
  const underlyings = syms.length ? syms.map((s) => FEEDS[s]) : [FEEDS.ETH];
  if (!syms.length) notes.push('Underlying not stated: ETH assumed.');
  const params: ProductParams = {
    productType: t,
    name: d.name || `${PRODUCT_LABELS[t]} on ${underlyings.map((u) => u.symbol).join('/')}`,
    issuePricePct: dflt(d.issuePricePct, 100, 'Issue price not stated: par (100%) assumed.'),
    underlyings,
    observations: count,
  };
  const use = productUses(t);
  // The coupon's rate and basis come from the words quoted from the request; annual rates are
  // converted here (the model's own arithmetic was unreliable in Flow's evaluation).
  const quoted = d.couponAsStated && prompt.includes(d.couponAsStated) ? d.couponAsStated : null;
  const quotedRate = quoted?.match(/(\d+(?:\.\d+)?)\s*%/);
  if (quotedRate) {
    d.couponRatePct = Number(quotedRate[1]);
    d.couponRateBasis = ANNUAL.test(quoted!) ? 'per-annum' : 'per-period';
  }
  if (use.coupon && d.couponRatePct !== null) {
    const perAnnum = d.couponRateBasis === 'per-annum' && ANNUAL.test(quoted ?? prompt);
    params.couponRatePct = perAnnum ? Math.round(((d.couponRatePct * every) / 12) * 1e6) / 1e6 : d.couponRatePct;
    if (perAnnum)
      notes.push(
        `Coupon ${d.couponRatePct}% p.a. paid every ${every} month${every === 1 ? '' : 's'}: ${params.couponRatePct}% per period.`,
      );
  }
  if (use.couponBarrier && d.couponBarrierPct !== null) params.couponBarrierPct = d.couponBarrierPct;
  if (t === 'phoenix') params.memory = dflt(d.memory, false, 'Memory not stated: no memory assumed.');
  if (use.autocall && d.autocallLevelPct !== null) params.autocallLevelPct = d.autocallLevelPct;
  if (use.autocall) params.autocallFromPeriod = dflt(d.autocallFromPeriod, 1, '');
  if (use.knockIn && d.knockInBarrierPct !== null) params.knockInBarrierPct = d.knockInBarrierPct;
  if (use.protection && d.protectionPct !== null) params.protectionPct = d.protectionPct;
  if (use.protection && d.participationPct !== null) params.participationPct = d.participationPct;
  // Collateral: what the request states; the haircut defaults per asset (each a visible note), never the asset.
  const cols = [
    ...new Set((d.collateralSymbols ?? []).map((s) => cleanSymbol(s).replace(/^USDC?$|^USDG$|^STABLECOIN$/, 'USD'))),
  ].filter((s) => (COLLATERAL_SYMBOLS as string[]).includes(s)) as CollateralSymbol[];
  if (cols.length) {
    params.collateral = cols.map((symbol, i) => {
      const stated = d.haircutPcts?.[i];
      if (stated === undefined || stated === null)
        notes.push(`${symbol} collateral haircut not stated: ${DEFAULT_HAIRCUT[symbol]}% of market value counted.`);
      return { symbol, haircutPct: stated ?? DEFAULT_HAIRCUT[symbol] };
    });
  }
  if (d.collateralRatioPct !== null) params.collateralRatioPct = d.collateralRatioPct;
  params.settlementLagDays = dflt(
    d.settlementLagDays,
    2,
    'Settlement lag not stated: payments 2 days after each observation.',
  );
  params.gracePeriodDays = dflt(d.gracePeriodDays, 2, 'Grace period not stated: 2 days.');
  return { params, schedule: { every, unit: 'months', count, ...(d.size ? { size: d.size } : {}) } };
}

export async function extractProduct(
  ai: AiRunner,
  prompt: string,
  product: ProductType,
  today: string,
  maxRepairs = 2,
): Promise<ExtractedProduct | { errors: string[] }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system(today) },
    { role: 'user', content: `Product type (already identified): ${product}.\n\nRequest:\n${prompt}` },
  ];
  let errors: string[] = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const draft = await ai.json<Draft>(messages, SCHEMA, 'term_sheet').catch(() => null);
    if (!draft) {
      errors = ['The reply was not valid JSON.'];
      continue;
    }
    draft.productType = draft.productType ?? product;
    const bad = (draft.underlyingSymbols ?? []).map(unsupportedUnderlying).find(Boolean);
    if (bad)
      return {
        errors: [
          `There is no Chainlink price feed for ${bad} set up here yet; notes can be issued on ${SUPPORTED_UNDERLYINGS.join(', ')}.`,
        ],
      };
    const notes: string[] = [];
    const { params, schedule } = toParams(draft, prompt, notes);
    delete params.chain; // never anything but the note chain (Robinhood Chain)
    errors = validateProductParams(params);
    if (!errors.length) return { params, schedule, notes };
    messages.push({ role: 'assistant', content: JSON.stringify(draft) });
    messages.push({
      role: 'user',
      content: `Those terms are not consistent:\n- ${errors.join('\n- ')}\nCorrect only what the request supports; use null where the request does not state a value.`,
    });
  }
  return { errors };
}

/** An underlying named in the request that has no Chainlink feed configured here, if any. */
const cleanSymbol = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z]/g, '');

export function unsupportedUnderlying(symbol: string | null | undefined): string | null {
  const s = cleanSymbol(symbol);
  return s && !(s in FEEDS) ? s : null;
}

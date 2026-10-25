/** A note's key terms in plain words, for investors deciding whether to subscribe. */
import type { ProductParams } from '@sn/core';

export interface PlainTerm {
  kind: 'good' | 'risk' | 'info';
  text: string;
}

export function plainTerms(p: ProductParams, sym: string, collateralRatioPct?: number): PlainTerm[] {
  const out: PlainTerm[] = [];
  const unds = p.underlyings.map((u) => u.symbol);
  const what = unds.length > 1 ? `the weakest of ${unds.join(', ')}` : (unds[0] ?? 'the underlying');
  const n = p.observations;
  const rate = p.couponRatePct ?? 0;
  if (p.productType === 'ppn') {
    out.push({
      kind: 'good',
      text: `At maturity you get at least ${p.protectionPct ?? 100}% of your money back in ${sym}.`,
    });
    out.push({ kind: 'good', text: `Plus ${p.participationPct ?? 0}% of any rise in ${what}.` });
  } else if (p.productType === 'snowball') {
    out.push({
      kind: 'good',
      text: `Earns ${rate}% per period, paid in ${sym} when the note is called early or at maturity.`,
    });
  } else if (p.productType === 'phoenix') {
    out.push({
      kind: 'good',
      text: `${rate}% coupon in ${sym} on each of ${n} dates, as long as ${what} is at or above ${p.couponBarrierPct}% of its starting price${p.memory ? '. Missed coupons are paid later if it recovers' : ''}.`,
    });
  } else {
    out.push({ kind: 'good', text: `${rate}% coupon in ${sym} on each of ${n} dates, whatever the price does.` });
  }
  if (p.autocallLevelPct && p.productType !== 'reverse-convertible' && p.productType !== 'ppn') {
    out.push({
      kind: 'info',
      text: `Ends early, with your money back, if ${what} is at or above ${p.autocallLevelPct}% of its starting price${p.autocallFromPeriod && p.autocallFromPeriod > 1 ? ` from date ${p.autocallFromPeriod}` : ''}.`,
    });
  }
  if (p.knockInBarrierPct && p.productType !== 'ppn') {
    out.push({
      kind: 'risk',
      text:
        p.settlement === 'physical'
          ? `If ${what} ends below ${p.knockInBarrierPct}% of its starting price, you receive the stock or token instead of your money, worth less than you paid.`
          : `If ${what} ends below ${p.knockInBarrierPct}% of its starting price, you get back only what it is worth then (for example 50% if it halved).`,
    });
  }
  if (collateralRatioPct)
    out.push({
      kind: 'info',
      text: `The issuer has locked collateral worth ${collateralRatioPct}% of the note. If they miss a payment, it goes to holders.`,
    });
  return out;
}

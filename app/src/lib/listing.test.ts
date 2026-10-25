import { describe, expect, it } from 'vitest';
import { EXAMPLE_PRODUCTS, EXAMPLE_WORST_OF, FEEDS, type ProductParams } from '@sn/core';
import { assetsPhrase, inTime, listingOf, simpleStatus } from './listing';

const DAY = 86400,
  YEAR = 365.25 * DAY;
// A real schedule: 4 quarterly observations over a year.
const quarterly = (start = 1_800_000_000) => ({
  strikeDate: start,
  obsDates: [1, 2, 3, 4].map((k) => start + (k * YEAR) / 4),
});

describe('listingOf: the annual rate and plain specs', () => {
  it('fixed coupon note: a fixed annual rate', () => {
    const p: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, couponRatePct: 2.5 };
    const l = listingOf(p, quarterly());
    expect(l.yield.headline).toBe('10%');
    expect(l.yield.rateLabel).toBe('est. annualized return');
    expect(l.yield.sub).toBe('in USDG, paid every 3 months');
    expect(l.yield.guaranteed).toBe(true);
    expect(l.yield.qualifier).toBeNull();
    expect(l.term).toBe('12 months');
  });

  it('reverse convertible: fixed rate, money back above the barrier, stock below when physical', () => {
    const p: ProductParams = {
      ...EXAMPLE_PRODUCTS['reverse-convertible'],
      underlyings: [FEEDS.TSLA],
      couponRatePct: 3,
      knockInBarrierPct: 60,
      settlement: 'physical',
    };
    const l = listingOf(p, quarterly());
    expect(l.yield.headline).toBe('12%');
    expect(l.protection).toBe('Your money back if Tesla stays above 60%; below it, you get the stock');
    expect(l.early).toBeNull();
    expect(l.kind).toBe('stocks');
  });

  it('phoenix with memory on a basket: "up to", conditional, early repayment in months', () => {
    const p: ProductParams = {
      ...EXAMPLE_WORST_OF,
      underlyings: [FEEDS.TSLA, FEEDS.NVDA],
      couponRatePct: 2.5,
      couponBarrierPct: 70,
      memory: true,
      autocallLevelPct: 100,
      autocallFromPeriod: 2,
      knockInBarrierPct: 60,
    };
    const l = listingOf(p, quarterly());
    expect(l.yield.headline).toBe('Up to 10%');
    expect(l.yield.qualifier).toBe('if the weaker one stays above 70%');
    expect(l.yield.guaranteed).toBe(false);
    expect(l.assets).toBe('Tesla & NVIDIA: the weaker one counts');
    expect(l.early).toBe('Can end early from month 6 if above 100%');
    expect(l.protection).toBe('Your money back if the weaker one stays above 60%');
  });

  it('snowball: up to, paid at redemption', () => {
    const l = listingOf({ ...EXAMPLE_PRODUCTS.snowball, couponRatePct: 2 }, quarterly());
    expect(l.yield.headline).toBe('Up to 8%');
    expect(l.yield.sub).toBe('in USDG, paid at redemption');
    expect(l.yield.guaranteed).toBe(false);
  });

  it('principal-protected: no APR, protection and upside', () => {
    const l = listingOf({ ...EXAMPLE_PRODUCTS.ppn, protectionPct: 90, participationPct: 100 }, quarterly());
    expect(l.yield.headline).toBe('90% protected + 100% of the upside');
    expect(l.yield.apr).toBeNull();
    expect(l.goal).toBe('protect');
    expect(l.protection).toBe('At least 90% of your money back at the end');
  });

  it('demo schedules annualise from the design and say so', () => {
    const start = 1_800_000_000;
    const p: ProductParams = {
      ...EXAMPLE_PRODUCTS.phoenix,
      name: '12M Phoenix on ETH',
      couponRatePct: 2.5,
      observations: 4,
    };
    const l = listingOf(p, { strikeDate: start, obsDates: [1, 2, 3, 4].map((k) => start + k * DAY) });
    expect(l.yield.headline).toBe('Up to 10%');
    expect(l.demo).toBe(true);
    expect(l.term).toBe('about 4 days (demo schedule)');
    expect(l.early).toMatch(/from date \d/);
  });

  it('without dates, the design sets the rate', () => {
    expect(
      listingOf({ ...EXAMPLE_PRODUCTS.fcn, name: '6M FCN on BTC', couponRatePct: 1, observations: 6 }).yield.headline,
    ).toBe('12%');
  });
});

describe('helpers', () => {
  it('names assets plainly', () => {
    expect(assetsPhrase(['ETH'])).toBe('Ethereum');
    expect(assetsPhrase(['ETH', 'BTC', 'SOL'])).toBe('Ethereum, Bitcoin & Solana: the weakest counts');
  });
  it('maps phases to simple statuses', () => {
    expect(['book', 'fixing', 'live', 'redeemed', 'defaulted'].map(simpleStatus)).toEqual([
      'open',
      'running',
      'running',
      'paid',
      'defaulted',
    ]);
  });
  it('says when, roughly', () => {
    expect(inTime(1000 + 2 * DAY, 1000)).toBe('in 2 days');
    expect(inTime(1000 + 5 * 3600, 1000)).toBe('in 5 hours');
    expect(inTime(900, 1000)).toBe('now');
  });
});

describe('listingOf: how holders get paid', () => {
  it('claim by default: claim any time from the portfolio', () => {
    const l = listingOf(EXAMPLE_PRODUCTS.phoenix);
    expect(l.payout.method).toBe('claim');
    expect(l.payout.text).toBe('Claim any time from your portfolio');
    expect(l.payout.detail).toMatch(/one claim at maturity collects everything, with a receipt per claim/i);
  });

  it('a note whose issuer opted in to push: paid to the wallet, issuer covers gas', () => {
    const l = listingOf({ ...EXAMPLE_PRODUCTS.phoenix, payouts: 'push' });
    expect(l.payout.method).toBe('push');
    expect(l.payout.text).toBe('Paid to your wallet automatically (issuer covers gas)');
  });
});

import { describe, expect, it } from 'vitest';
import { backtestNote, cmcDailyPath, decodeCmcDaily, EXAMPLE_PRODUCTS, FEEDS, type ProductParams } from '../src';

const DAY = 86_400;
const T0 = 20_000 * DAY;
const series = (prices: number[]) => prices.map((p, i) => [T0 + i * DAY, p] as const);
// A phoenix on two stock tokens: 3 observations 10 days apart, coupon and autocall as the example product has them.
const p: ProductParams = {
  ...EXAMPLE_PRODUCTS.phoenix,
  underlyings: [FEEDS.TSLAB, FEEDS.NVDAB],
  observations: 3,
  couponRatePct: 2,
  couponBarrierPct: 80,
  autocallLevelPct: 100,
  autocallFromPeriod: 1,
  knockInBarrierPct: 60,
  memory: false,
};

describe('a note replayed on daily price history', () => {
  it('redeems early every time on a market that only rises', () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i);
    const r = backtestNote(p, { TSLAB: series(up), NVDAB: series(up) }, [10, 20, 30])!;
    // 60 days of history, a 30-day term: starts on days 0..29.
    expect(r.starts).toBe(30);
    expect(r.from).toBe(T0);
    expect(r.to).toBe(T0 + 29 * DAY);
    expect(r.calledEarly).toBe(30);
    expect(r.loss).toBe(0);
    expect(r.allCoupons).toBe(30);
    expect(r.avgTotal).toBeCloseTo(1.02, 10);
    expect(r.lowestLevel).toBeGreaterThan(1);
  });

  it('counts the starts that ended below the barrier, on the worst performer', () => {
    // TSLAB flat; NVDAB slips a little every day (never back at its start price, so no early redemption), then
    // halves on day 35: starts whose final check falls after it lose.
    const flat = Array.from({ length: 60 }, () => 100);
    const crash = Array.from({ length: 60 }, (_, i) => (i < 35 ? 100 - i * 0.1 : 50));
    const r = backtestNote(p, { TSLAB: series(flat), NVDAB: series(crash) }, [10, 20, 30])!;
    expect(r.starts).toBe(30);
    expect(r.calledEarly).toBe(0);
    // Final check on day d + 30 >= 35: starts 5..29 lose; 0..4 get the face back.
    expect(r.loss).toBe(25);
    expect(r.worstTotal).toBeLessThan(0.6);
    expect(r.bestTotal).toBeCloseTo(1.06, 10);
    expect(r.lowestLevel).toBeCloseTo(50 / 99.5, 10);
  });

  it('says nothing when the history is shorter than the term, or an underlying has none', () => {
    const few = Array.from({ length: 32 }, () => 100);
    expect(backtestNote(p, { TSLAB: series(few), NVDAB: series(few) }, [10, 20, 30])).toBeNull();
    expect(backtestNote(p, { TSLAB: series(few) }, [1, 2, 3])).toBeNull();
    expect(backtestNote(p, { TSLAB: series(few), NVDAB: series(few) }, [1, 2])).toBeNull();
    expect(backtestNote(p, { TSLAB: series(few), NVDAB: series(few) }, [1, 2, 3])?.starts).toBe(29);
  });

  it('leaves out a start with a missing day instead of inventing a price', () => {
    const flat = Array.from({ length: 20 }, () => 100);
    const gap = series(flat).filter((_, i) => i !== 7);
    const r = backtestNote(p, { TSLAB: series(flat), NVDAB: gap }, [1, 2, 3])!;
    // Day 7 is a start, and an observation of the starts 4, 5 and 6.
    expect(r.starts).toBe(17 - 4);
  });

  it('reads the daily history from CoinMarketCap', () => {
    expect(cmcDailyPath([40215, 40214], 1_780_000_000, T0 + 5000)).toBe(
      `/v3/cryptocurrency/quotes/historical?id=40214,40215&time_start=1780000000&time_end=${T0}&interval=1d&convert=USD&aux=`,
    );
    const body = JSON.stringify({
      status: { error_code: 0 },
      data: {
        40214: {
          quotes: [
            { timestamp: '2026-06-13T00:00:00.000Z', quote: { USD: { price: 400.1234567891 } } },
            { timestamp: '2026-06-12T00:00:00.000Z', quote: { USD: { price: 398.9166119834572 } } },
          ],
        },
      },
    });
    expect(decodeCmcDaily(body, [40214, 9])).toEqual([
      [
        [1781222400, 398.916612],
        [1781308800, 400.123457],
      ],
      [],
    ]);
    expect(() => decodeCmcDaily(JSON.stringify({ status: { error_code: 1002 } }), [1])).toThrow(
      /refused \(code 1002\)/,
    );
  });
});

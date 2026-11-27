import { describe, expect, it } from 'vitest';
import {
  CMC_MAX_AGE,
  CMC_MAX_LOOKBACK,
  cmcEnd,
  cmcHistoryPath,
  decodeCmcHistory,
  roundPoints,
  newYorkOffset,
  secondSourceHold,
  secondSourceTolerance,
  usMarketOpen,
  stepFixing,
  usdToAnswer,
} from '../src';

const q = (ts: string, price: number) => ({ timestamp: ts, quote: { USD: { price } } });
const reply = (data: object) => JSON.stringify({ status: { error_code: 0 }, data });
// 2026-11-25T16:00:00Z
const T = 1795622400;

describe('CoinMarketCap as the second source', () => {
  it('asks every node for the same closed five-minute points', () => {
    // 16:01:58: the 16:00 point is 118 s old, already published.
    expect(cmcEnd(T + 118)).toBe(T);
    // 16:01:10: only 70 s old, the nodes read up to 15:55.
    expect(cmcEnd(T + 70)).toBe(T - 300);
    // A 15-minute window ending at 16:00: from 15:45, start exclusive one step earlier; ids sorted and deduplicated.
    expect(cmcHistoryPath([40215, 40214, 40215], T - 900, T + 118)).toBe(
      `/v3/cryptocurrency/quotes/historical?id=40214,40215&time_start=${T - 900 - 300}&time_end=${T}&interval=5m&convert=USD&aux=`,
    );
    // A keeper that is a day late does not ask for a day of history.
    expect(cmcHistoryPath([1], T - 86_400, T + 118)).toContain(`time_start=${T - CMC_MAX_LOOKBACK - 300}`);
  });

  it('decodes the history into points of the feed decimals, newest first', () => {
    const body = reply({
      40214: { quotes: [q('2026-11-25T15:55:00.000Z', 363.5), q('2026-11-25T16:00:00.000Z', 363.97012007256143)] },
      40215: {
        quotes: [
          q('2026-11-25T16:00:00.000Z', 142.61748127162855),
          { timestamp: 'x' },
          q('2026-11-25T15:50:00.000Z', -1),
        ],
      },
    });
    const [tsla, nvda, none] = decodeCmcHistory(body, [40214, 40215, 7], 18);
    expect(tsla).toEqual({ rounds: [`${T}:363970120070000000000`, `${T - 300}:363500000000000000000`] });
    expect(nvda).toEqual({ rounds: [`${T}:142617481270000000000`] });
    expect(none).toEqual({ error: 'CoinMarketCap: no price history for this token' });
    expect(usdToAnswer(363.5, 8)).toBe(36350000000n);
    expect(usdToAnswer(363.5, 6)).toBe(363500000n);
  });

  it('fails every token the same way when the request is refused', () => {
    const refused = JSON.stringify({ status: { error_code: 1008, error_message: 'rate limit, key abc' } });
    expect(decodeCmcHistory(refused, [1, 2], 18)).toEqual([
      { error: 'CoinMarketCap: request refused (code 1008)' },
      { error: 'CoinMarketCap: request refused (code 1008)' },
    ]);
    expect(decodeCmcHistory('<html>', [1], 18)).toEqual([{ error: 'CoinMarketCap: reply is not JSON' }]);
  });

  it('holds an Atlas price that CoinMarketCap does not confirm', () => {
    const pts = [
      { at: T, answer: usdToAnswer(364, 18) },
      { at: T - 300, answer: usdToAnswer(300, 18) },
    ];
    // T is a Wednesday, 16:00 UTC = 11:00 New York: the market is open, the limit is 3%.
    expect(usMarketOpen(T + 120)).toBe(true);
    expect(secondSourceHold(usdToAnswer(363.85, 18), pts, T + 120)).toBeNull();
    expect(secondSourceHold(usdToAnswer(374.9, 18), pts, T + 120)).toBeNull(); // 2.99%
    expect(secondSourceHold(usdToAnswer(376, 18), pts, T + 120)).toMatch(/disagree by 3\.29% \(limit 3\.00%\)/);
    expect(secondSourceHold(usdToAnswer(340, 18), pts, T + 120)).toMatch(/disagree by 6\.59%/);
    expect(secondSourceHold(usdToAnswer(364, 18), pts, T + CMC_MAX_AGE + 1)).toMatch(/newest price is 901s old/);
    expect(secondSourceHold(usdToAnswer(364, 18), [], T)).toMatch(/no price to compare/);
  });

  it('asks for closer agreement while the US stock market is closed', () => {
    // 2026-11-25 is a Wednesday (EST, UTC-5): open 14:30 to 21:00 UTC.
    const day = Date.UTC(2026, 10, 25) / 1000;
    expect(usMarketOpen(day + 14 * 3600 + 29 * 60)).toBe(false);
    expect(usMarketOpen(day + 14 * 3600 + 30 * 60)).toBe(true);
    expect(usMarketOpen(day + 20 * 3600 + 59 * 60)).toBe(true);
    expect(usMarketOpen(day + 21 * 3600)).toBe(false);
    // Saturday 28 November: closed all day.
    expect(usMarketOpen(day + 3 * 86_400 + 16 * 3600)).toBe(false);
    // Summer time (UTC-4): Wednesday 15 July 2026 opens at 13:30 UTC.
    const july = Date.UTC(2026, 6, 15) / 1000;
    expect(newYorkOffset(july)).toBe(-4);
    expect(usMarketOpen(july + 13 * 3600 + 30 * 60)).toBe(true);
    expect(usMarketOpen(july + 20 * 3600)).toBe(false);
    // The clocks change at 02:00 local: 8 March and 1 November 2026.
    expect(newYorkOffset(Date.UTC(2026, 2, 8, 6, 59) / 1000)).toBe(-5);
    expect(newYorkOffset(Date.UTC(2026, 2, 8, 7) / 1000)).toBe(-4);
    expect(newYorkOffset(Date.UTC(2026, 10, 1, 5, 59) / 1000)).toBe(-4);
    expect(newYorkOffset(Date.UTC(2026, 10, 1, 6) / 1000)).toBe(-5);
    // Thanksgiving, Thursday 26 November 2026: closed all day, so the closed-market limit applies at midday.
    const thanksgiving = Date.UTC(2026, 10, 26) / 1000;
    expect(usMarketOpen(thanksgiving + 16 * 3600)).toBe(false);
    expect(secondSourceTolerance(thanksgiving + 16 * 3600)).toBe(200);
    // The day after: open at 14:30 UTC (09:30), closed from 18:00 UTC (13:00), not 21:00.
    const friday = thanksgiving + 86_400;
    expect(usMarketOpen(friday + 14 * 3600 + 30 * 60)).toBe(true);
    expect(usMarketOpen(friday + 17 * 3600 + 59 * 60)).toBe(true);
    expect(usMarketOpen(friday + 18 * 3600)).toBe(false);
    // Good Friday, 3 April 2026 (EDT): closed; the Friday before and after are ordinary.
    const goodFriday = Date.UTC(2026, 3, 3) / 1000;
    expect(usMarketOpen(goodFriday + 16 * 3600)).toBe(false);
    expect(usMarketOpen(goodFriday + 7 * 86_400 + 16 * 3600)).toBe(true);
    expect(secondSourceTolerance(day + 16 * 3600)).toBe(300);
    expect(secondSourceTolerance(day + 3 * 3600)).toBe(200);
    // The same 2.5% gap passes at midday and holds the check at night.
    const night = day + 3 * 3600;
    const at = (t: number) => [{ at: t - 120, answer: usdToAnswer(100, 18) }];
    expect(secondSourceHold(usdToAnswer(102.5, 18), at(day + 16 * 3600), day + 16 * 3600)).toBeNull();
    expect(secondSourceHold(usdToAnswer(102.5, 18), at(night), night)).toMatch(
      /disagree by 2\.50% \(limit 2\.00%, US market closed\)/,
    );
  });

  it("gives an Atlas-priced note its fixing window and disruption rule from CoinMarketCap's history", () => {
    const hist = (prices: number[]) =>
      roundPoints(
        (
          decodeCmcHistory(
            reply({
              1: {
                quotes: prices.map((p, i) => q(new Date((T - 300 * (prices.length - 1 - i)) * 1000).toISOString(), p)),
              },
            }),
            [1],
            18,
          )[0] as { rounds: string[] }
        ).rounds,
      );
    // A wick at 15:55 that reverses does not set a 15-minute fixing ending at 16:00.
    const wick = stepFixing([hist([364, 364, 364, 420, 364])], { window: 900, nowSec: T + 120, dueAt: T });
    expect(wick).toMatchObject({ answers: [usdToAnswer(364, 18)], at: T, anchored: true, postponed: 0 });
    // With a 5% limit the same window is disrupted: the check is postponed by one window.
    const held = stepFixing([hist([364, 364, 364, 420, 364])], {
      window: 900,
      nowSec: T + 120,
      dueAt: T,
      disruptionBps: 500,
    });
    expect(held).toMatchObject({ wait: expect.stringMatching(/postponed 1 time/), retryAt: T + 900 });
  });
});

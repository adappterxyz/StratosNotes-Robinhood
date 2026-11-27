import { useEffect, useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { backtestNote, isAtlasFeed, type DailySeries, type ProductParams } from '@sn/core';
import { api } from '../lib/api';

const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;
const day = (s: number) =>
  new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The note's terms replayed on CoinMarketCap's daily prices of its stock tokens, from every day since they listed
 * (core backtestNote: the same reference payoff the on-chain note is tested against). Shown only for notes written
 * on Atlas-priced stock tokens, whose history the API serves. A summary of the past, never a forecast.
 */
export function Backtest({
  p,
  schedule,
  cash,
}: {
  p: ProductParams;
  schedule: { strikeDate?: number; obsDates?: number[] };
  cash: string;
}) {
  const symbols = useMemo(() => p.underlyings.map((u) => u.symbol), [p.underlyings]);
  const tokens = p.underlyings.length > 0 && p.underlyings.every((u) => isAtlasFeed(u.feed));
  const key = symbols.join(',');
  const [series, setSeries] = useState<Record<string, DailySeries> | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    if (!tokens) return;
    let live = true;
    setFailed('');
    api
      .marketHistory(key.split(','))
      .then((r) => live && setSeries(r.series))
      .catch((e: Error) => live && setFailed(e.message));
    return () => {
      live = false;
    };
  }, [key, tokens]);

  // Whole days from the start to each check. A demo schedule (minutes) is replayed one check a day.
  const real = (schedule.obsDates ?? []).map((t) => Math.round((t - (schedule.strikeDate ?? 0)) / 86_400));
  const usable =
    schedule.strikeDate !== undefined &&
    real.length === p.observations &&
    real.every((d, i) => d >= 1 && (i === 0 || d > real[i - 1]));
  const offsets = usable ? real : Array.from({ length: p.observations }, (_, i) => i + 1);
  const offsetsKey = offsets.join(',');
  const r = useMemo(
    () => (series ? backtestNote(p, series, offsetsKey.split(',').map(Number)) : null),
    [p, series, offsetsKey],
  );

  if (!tokens) return null;
  return (
    <section className="card" data-backtest={r ? r.starts : failed ? 'failed' : series ? 'short' : 'loading'}>
      <h3 className="row gap-6 m-0">
        <History className="i" /> How these terms would have done
      </h3>
      {failed ? (
        <p className="small muted">Price history is not available right now: {failed}</p>
      ) : !series ? (
        <p className="small muted">Reading {symbols.join(' and ')} prices from CoinMarketCap…</p>
      ) : !r ? (
        <p className="small muted">
          {symbols.join(' and ')} have traded since June 2026: not long enough to replay a note of this length.
        </p>
      ) : (
        <>
          <p className="small muted">
            Replayed from each of {r.starts} start days ({day(r.from)} to {day(r.to)}) on CoinMarketCap's daily prices
            of {symbols.join(' and ')}
            {usable ? '' : ', one check a day (the history is daily; this schedule is shorter)'}.
          </p>
          <div className="kv">
            {p.autocallLevelPct !== undefined && (
              <div>
                <span className="k">Redeemed early</span>
                <span className="v">{pct(r.calledEarly, r.starts)}</span>
              </div>
            )}
            {p.productType === 'phoenix' && (
              <div>
                <span className="k">Paid every coupon</span>
                <span className="v">{pct(r.allCoupons, r.starts)}</span>
              </div>
            )}
            <div>
              <span className="k">Ended with a loss</span>
              <span className="v">{pct(r.loss, r.starts)}</span>
            </div>
            <div>
              <span className="k">Average paid per 1 {cash}</span>
              <span className="v">{r.avgTotal.toFixed(3)}</span>
            </div>
            <div>
              <span className="k">Worst start</span>
              <span className="v">{r.worstTotal.toFixed(3)}</span>
            </div>
            <div>
              <span className="k">Lowest level seen at a check</span>
              <span className="v">{Math.round(r.lowestLevel * 100)}% of the start price</span>
            </div>
          </div>
          <p className="xs muted m-0">What happened, not what will: {r.starts} overlapping periods of one market.</p>
        </>
      )}
    </section>
  );
}

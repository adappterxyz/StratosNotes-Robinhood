import { Timer } from 'lucide-react';
import {
  canCloseFeed,
  canWindowFeed,
  DISRUPTION_LIMITS,
  DISRUPTION_MAX_POSTPONEMENTS,
  FIXING_WINDOWS,
  isAtlasFeed,
  type ProductParams,
} from '@sn/core';
import type { ChainConfig } from '../../lib/api';
import { Presets } from './controls';
import type { Every, Timing } from './schedule';

const SIZES = [1_000, 10_000, 100_000];
const BOOK = [
  { min: 5, label: 'In 5 minutes' },
  { min: 60, label: 'In 1 hour' },
  { min: 24 * 60, label: 'Tomorrow' },
  { min: 7 * 24 * 60, label: 'In a week' },
];
const EVERY: Array<{ v: Every; label: string; sub: string; star?: boolean }> = [
  { v: { n: 3, unit: 'minutes' }, label: 'Demo: every 3 minutes', sub: 'Watch a whole note run', star: true },
  { v: { n: 1, unit: 'days' }, label: 'Every day', sub: 'A short test' },
  { v: { n: 1, unit: 'months' }, label: 'Every month', sub: '' },
  { v: { n: 3, unit: 'months' }, label: 'Every 3 months', sub: 'Usual for notes' },
];

/** Step 3, Schedule: how much is on offer, when the book closes, and how often the price is checked. */
export function ScheduleStep({
  p,
  set,
  sym,
  size,
  setSize,
  strikeIn,
  setStrikeIn,
  every,
  setEvery,
  setTiming,
  chainCfg,
  chainKey,
  observations,
  strikeAt,
  dateOf,
  fmtT,
  demo,
  scheduleBad,
}: {
  p: ProductParams;
  set: (patch: Partial<ProductParams>) => void;
  sym: string;
  size: number;
  setSize: (n: number) => void;
  strikeIn: number;
  setStrikeIn: (n: number) => void;
  every: Every;
  setEvery: (e: Every) => void;
  setTiming: (t: Timing | null) => void;
  chainCfg: ChainConfig | undefined;
  chainKey: string;
  observations: number;
  strikeAt: number;
  dateOf: (k: number) => number;
  fmtT: (s: number) => string;
  demo: boolean;
  scheduleBad: string;
}) {
  const runs = demo ? Math.round(((dateOf(observations) - strikeAt) / 60) * 10) / 10 : null;
  // A fixing window needs the feed's price history; a closing price needs a market that closes (US stocks).
  const canWindow = p.underlyings.every(canWindowFeed);
  const canClose = canWindow && p.underlyings.every(canCloseFeed);
  const fixing: number | 'close' = !canWindow ? 0 : p.fixingAt === 'close' ? 'close' : (p.fixingWindowMin ?? 0);
  const windowMin = canWindow ? (p.fixingWindowMin ?? 0) : 0;
  // Stock tokens: the history is CoinMarketCap's (Atlas keeps the latest price only).
  const atlas = p.underlyings.length > 0 && p.underlyings.every((u) => isAtlasFeed(u.feed));
  const history = atlas ? "CoinMarketCap's five-minute prices" : 'the Chainlink feed';
  return (
    <>
      <h2>Schedule</h2>
      <div className="iw-field">
        <div className="iw-field-h">
          <label htmlFor="is-size">How much to raise</label>
          <span className="with-suffix maxw-200">
            <input id="is-size" type="number" min={1} value={size} onChange={(e) => setSize(Number(e.target.value))} />
            <span className="suffix">{sym}</span>
          </span>
        </div>
        <Presets
          label="Size"
          options={SIZES.map((s) => ({ label: `${s.toLocaleString()} ${sym}`, value: s }))}
          value={size}
          onPick={setSize}
        />
        <span className="hint">Units on offer: one unit per 1 {sym} of face value.</span>
      </div>

      <div className="iw-field">
        <div className="iw-field-h">
          <label htmlFor="is-strike">Book closes</label>
          <span className="with-suffix maxw-200">
            <input
              id="is-strike"
              type="number"
              min={2}
              value={strikeIn}
              onChange={(e) => setStrikeIn(Math.max(2, Number(e.target.value) || 2))}
            />
            <span className="suffix">minutes</span>
          </span>
        </div>
        <Presets
          label="Book closes"
          options={BOOK.map((b) => ({ label: b.label, value: b.min }))}
          value={strikeIn}
          onPick={setStrikeIn}
        />
        <span className="hint">Investors can buy until then; the starting prices are fixed at that moment.</span>
      </div>

      <div className="iw-field">
        <div className="iw-field-h">
          <label htmlFor="is-every">How often the price is checked</label>
          <span className="row flex-nowrap gap-6 maxw-240">
            <input
              className="w-64"
              id="is-every"
              type="number"
              min={1}
              value={every.n}
              onChange={(e) => {
                setEvery({ ...every, n: Number(e.target.value) || 1 });
                setTiming(null);
              }}
            />
            <select
              aria-label="Interval unit"
              value={every.unit}
              onChange={(e) => {
                setEvery({ ...every, unit: e.target.value as typeof every.unit });
                setTiming(null);
              }}
            >
              <option value="minutes">minutes (demo)</option>
              <option value="days">days</option>
              <option value="months">months</option>
            </select>
          </span>
        </div>
        <Presets
          label="Check every"
          options={EVERY.map((e) => ({ label: e.label, sub: e.sub || undefined, value: e.v, star: e.star }))}
          value={every}
          onPick={(v) => {
            setEvery(v);
            setTiming(null);
          }}
        />
      </div>

      <div className="iw-field" data-fixing-window={windowMin} data-fixing-at={p.fixingAt ?? ''}>
        <div className="iw-field-h">
          <span className="lbl">Which price each check uses</span>
        </div>
        <Presets<number | 'close'>
          label="Price fixing"
          options={[
            ...FIXING_WINDOWS.filter((m) => m === 0 || canWindow).map((m) => ({
              label: m ? `${m}-minute median` : 'Latest price',
              sub: m ? 'Ignores a brief spike' : 'One reading',
              value: m as number | 'close',
            })),
            ...(canClose
              ? [{ label: 'Closing price', sub: 'US close, 16:00 New York', value: 'close' as number | 'close' }]
              : []),
          ]}
          value={fixing}
          onPick={(m) =>
            m === 'close'
              ? set({ fixingAt: 'close', fixingWindowMin: p.fixingWindowMin || 15 })
              : set({
                  fixingAt: undefined,
                  fixingWindowMin: m || undefined,
                  ...(m ? {} : { disruptionPct: undefined }),
                })
          }
        />
        <span className="hint">
          {!canWindow
            ? 'A median over the minutes before each check is not available for these underlyings.'
            : p.fixingAt === 'close'
              ? `The book closes and every check falls at the US market close of a weekday. Each price is the median of ${history} over the ${windowMin} minutes before the close. ${atlas ? 'It is the price of the stock token while the stock itself is trading, not a thin overnight or weekend price.' : "The feed is the price of the stock token, which can differ slightly from the exchange's official closing price."}`
              : `A median takes the price that held for most of the minutes before the check, from ${history}. A sudden spike or dip that reverses does not set the start price, a coupon or the barrier.${atlas ? " Without a median, each price is Atlas's latest on BNB Chain. Either way it is written only when Atlas and CoinMarketCap agree within 3% (2% while the US stock market is closed)." : ''}`}
        </span>
        {scheduleBad && <div className="notice warn">{scheduleBad}</div>}
      </div>

      {windowMin > 0 && (
        <div className="iw-field" data-disruption={p.disruptionPct ?? 0}>
          <div className="iw-field-h">
            <span className="lbl">If the price is moving violently at a check</span>
          </div>
          <Presets
            label="Disruption rule"
            options={DISRUPTION_LIMITS.map((d) => ({
              label: d ? `Postpone above ${d}%` : 'Fix anyway',
              sub: d ? `Low to high in ${windowMin} min` : 'No postponement',
              value: d as number,
            }))}
            value={p.disruptionPct ?? 0}
            onPick={(d) => set({ disruptionPct: d || undefined })}
          />
          <span className="hint">
            {p.disruptionPct
              ? `If a price moved more than ${p.disruptionPct}% between its low and its high in the ${windowMin} minutes, the check is postponed by ${windowMin} minutes, up to ${DISRUPTION_MAX_POSTPONEMENTS} times (${DISRUPTION_MAX_POSTPONEMENTS * windowMin} minutes at most), then taken regardless. The payment date does not move, so the issuer has that much less time to fund it.`
              : 'With a limit, a check that falls in the middle of a violent move waits for the market to settle, as the market disruption clause of a traditional note does.'}
          </span>
        </div>
      )}

      <div className="iw-timeline" aria-label="Dates">
        <span className="iw-tl-dot start">
          <b>Start</b>
          {fmtT(strikeAt)}
        </span>
        {Array.from({ length: observations }, (_, i) => (
          <span key={i} className={`iw-tl-dot${i === observations - 1 ? ' end' : ''}`}>
            <b>{i === observations - 1 ? 'End' : `Check ${i + 1}`}</b>
            {fmtT(dateOf(i + 1))}
          </span>
        ))}
      </div>
      <p className="small muted m-0">
        On {chainCfg?.name ?? chainKey}.{' '}
        {demo && runs !== null && (
          <span className="iw-demo">
            <Timer className="i" /> The whole note runs in about {runs} minutes after the book closes: watch it live.
          </span>
        )}
      </p>
    </>
  );
}

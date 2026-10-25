import type { ChainConfig } from '../../lib/api';
import { Num } from './Num';
import type { Every, Timing } from './schedule';

/** Step 3, Schedule: the size, when the book closes, and how often the note observes. */
export function ScheduleStep({
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
}: {
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
}) {
  return (
    <>
      <h2>Schedule</h2>
      <div className="form-grid">
        <Num
          id="is-size"
          label="Size"
          suffix={sym}
          value={size}
          min={1}
          onChange={(v) => setSize(v)}
          hint="Units on offer, one unit per 1 USDG of face value."
        />
        <Num
          id="is-strike"
          label="Book closes in"
          suffix="minutes"
          value={strikeIn}
          min={2}
          onChange={(v) => setStrikeIn(Math.max(2, v || 2))}
          hint="The strike is fixed then."
        />
        <div className="field">
          <label htmlFor="is-every">Observe every</label>
          <div className="row flex-nowrap">
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
          </div>
        </div>
      </div>
      <p className="small muted">
        On {chainCfg?.name ?? chainKey}, where every note is issued. Strike {fmtT(strikeAt)}, then{' '}
        {Array.from({ length: observations }, (_, i) => fmtT(dateOf(i + 1))).join(' · ')}.
        {demo ? ' Minutes apart runs a whole lifecycle while you watch.' : ''}
      </p>
    </>
  );
}

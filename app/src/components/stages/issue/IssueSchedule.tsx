import type { IssuePlan } from '@sn/sdk';

type Every = { n: number; unit: 'minutes' | 'days' | 'months' };

/** Step 2 of the issue panel: when the book closes and how often the note observes. */
export function IssueSchedule({
  strikeIn,
  setStrikeIn,
  every,
  setEvery,
  strikeAt,
  plan,
  dateOf,
}: {
  strikeIn: number;
  setStrikeIn: (n: number) => void;
  every: Every;
  setEvery: (e: Every) => void;
  strikeAt: number;
  plan: IssuePlan;
  dateOf: (name: string) => number;
}) {
  return (
    <div className="section">
      <div className="step-h">
        <span className="n">2</span>
        <h3>Dates</h3>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="is-strike">Strike in (minutes)</label>
          <input
            id="is-strike"
            type="number"
            min={2}
            value={strikeIn}
            onChange={(e) => setStrikeIn(Math.max(2, Number(e.target.value) || 2))}
          />
        </div>
        <div className="field">
          <label htmlFor="is-every">Observe every</label>
          <div className="row flex-nowrap">
            <input
              className="w-70"
              id="is-every"
              type="number"
              min={1}
              value={every.n}
              onChange={(e) => setEvery({ ...every, n: Number(e.target.value) || 1 })}
            />
            <select
              aria-label="Interval unit"
              value={every.unit}
              onChange={(e) => setEvery({ ...every, unit: e.target.value as typeof every.unit })}
            >
              <option value="minutes">minutes</option>
              <option value="days">days</option>
              <option value="months">months</option>
            </select>
          </div>
        </div>
      </div>
      <p className="xs muted">
        Strike {new Date(strikeAt * 1000).toLocaleString()}; then{' '}
        {plan.dateFields
          .filter((f) => f !== 'strikeDate')
          .map((f) =>
            every.unit === 'minutes'
              ? new Date(dateOf(f) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : new Date(dateOf(f) * 1000).toLocaleDateString([], { dateStyle: 'medium' }),
          )
          .join(' · ')}
        . Minutes apart runs a whole lifecycle on-chain while you watch.
      </p>
    </div>
  );
}

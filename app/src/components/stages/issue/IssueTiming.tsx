import { MAX_GRACE_DAYS } from '@sn/core';

type Timing = { lag: number; grace: number };

/** Step 4 of the issue panel: the settlement lag and grace period of every payment. */
export function IssueTiming({
  demo,
  t,
  setTiming,
  timingBad,
}: {
  demo: boolean;
  t: Timing;
  setTiming: (t: Timing) => void;
  timingBad: string;
}) {
  return (
    <div className="section" data-timing>
      <div className="step-h">
        <span className="n">4</span>
        <h3>Paying holders</h3>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="is-lag">Settlement lag ({demo ? 'seconds' : 'days'} after each observation)</label>
          <input
            id="is-lag"
            type="number"
            min={0}
            value={demo ? t.lag : t.lag / 86400}
            onChange={(e) => setTiming({ ...t, lag: Math.max(0, Number(e.target.value) || 0) * (demo ? 1 : 86400) })}
          />
        </div>
        <div className="field">
          <label htmlFor="is-grace">
            Grace period ({demo ? 'seconds' : 'days'}, up to {MAX_GRACE_DAYS} days)
          </label>
          <input
            id="is-grace"
            type="number"
            min={0}
            value={demo ? t.grace : t.grace / 86400}
            onChange={(e) => setTiming({ ...t, grace: Math.max(0, Number(e.target.value) || 0) * (demo ? 1 : 86400) })}
          />
        </div>
      </div>
      <p className="xs muted">
        The subscriptions are yours when the book closes. Each observation fixes what is owed; fund it into escrow
        before the payment date ({demo ? `${t.lag}s` : `${t.lag / 86400} days`} after the observation). Unfunded, a{' '}
        {demo ? `${t.grace}s` : `${t.grace / 86400}-day`} grace period runs; unfunded after that, the collateral goes to
        the holders.
      </p>
      {timingBad && <div className="notice warn">{timingBad}</div>}
    </div>
  );
}

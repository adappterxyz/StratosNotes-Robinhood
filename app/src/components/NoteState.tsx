/**
 * A note's current state in one glance: the phase in plain words (with the economic states that matter more than
 * the lifecycle phase: payment due, in grace, margin call, knocked in), what happens next with a countdown, the
 * latest observation against the barriers, collateral coverage, and the reader's own position.
 */
import type { NoteView } from '@sn/sdk';
import { fmtMoney, fmtPct } from '../lib/format';
import { When } from './ui';

export type StateKey =
  'book' | 'fixing' | 'observing' | 'due' | 'grace' | 'margin' | 'knocked' | 'redeemed' | 'defaulted';
export const STATE_LABEL: Record<StateKey, string> = {
  book: 'Book open',
  fixing: 'Strike being fixed',
  observing: 'Observing',
  due: 'Payment due',
  grace: 'In grace',
  margin: 'Margin call',
  knocked: 'Knocked in',
  redeemed: 'Redeemed',
  defaulted: 'Defaulted',
};
const TONE: Record<StateKey, 'accent' | 'warn' | 'bad' | 'muted'> = {
  book: 'accent',
  fixing: 'warn',
  observing: 'accent',
  due: 'warn',
  grace: 'warn',
  margin: 'warn',
  knocked: 'bad',
  redeemed: 'muted',
  defaulted: 'bad',
};

/** The state that matters most right now, and what comes next (label + time). */
export function currentState(o: NoteView): { key: StateKey; next: { label: string; at: number } | null } {
  const e = o.economics;
  const ki = o.params.knockInBarrierPct;
  const last = o.perfs[o.perfs.length - 1];
  const knocked = ki !== undefined && last !== undefined && o.perfs.length === o.obsDates.length && last < ki / 100;
  if (o.phase === 'defaulted') return { key: 'defaulted', next: null };
  if (o.phase === 'redeemed') return { key: knocked ? 'knocked' : 'redeemed', next: null };
  if (e?.marginCall) return { key: 'margin', next: { label: 'Top-up deadline', at: e.marginCall.deadline } };
  if (e?.inGrace)
    return { key: 'grace', next: { label: `Payment ${e.inGrace.period}: grace ends`, at: e.inGrace.deadline } };
  if (e?.nextCall && !e.nextCall.funded && o.phase === 'live' && e.nextCall.total) {
    return {
      key: 'due',
      next: { label: `Payment ${e.nextCall.period} (${fmtMoney(e.nextCall.total)}) due`, at: e.nextCall.payDate },
    };
  }
  if (o.phase === 'book')
    return {
      key: 'book',
      next: o.strikeDate ? { label: 'Book closes and the strike is fixed', at: o.strikeDate } : null,
    };
  if (o.phase === 'fixing')
    return {
      key: 'fixing',
      next: o.strikeDate ? { label: 'Strike fixing (by Chainlink CRE)', at: o.strikeDate } : null,
    };
  const k = o.perfs.length;
  return {
    key: 'observing',
    next: o.obsDates[k]
      ? { label: k === o.obsDates.length - 1 ? 'Final observation' : `Observation ${k + 1}`, at: o.obsDates[k] }
      : null,
  };
}

export function StatePill({ o }: { o: NoteView }) {
  const { key } = currentState(o);
  return (
    <span className={`pill st-${TONE[key]}`} data-state={key}>
      <span className="dot" />
      {STATE_LABEL[key]}
    </span>
  );
}

function countdown(at: number, now: number) {
  let s = Math.round(at - now);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  return d ? `in ${d}d ${h}h` : h ? `in ${h}h ${m}m` : `in ${m}m ${s % 60}s`;
}

/** The banner at the top of a note page. */
export function CurrentState({ o, now, sym, units }: { o: NoteView; now: number; sym: string; units: number | null }) {
  const { key, next } = currentState(o);
  const p = o.params;
  const last = o.perfs[o.perfs.length - 1];
  const levels: Array<{ name: string; v: number | undefined }> = [
    { name: 'Early repayment', v: p.autocallLevelPct },
    { name: 'Coupon barrier', v: p.couponBarrierPct },
    { name: 'Knock-in', v: p.knockInBarrierPct },
  ].filter((l) => l.v !== undefined);
  const cov = o.economics?.coveragePct;
  return (
    <section className={`card state-banner st-${TONE[key]}`} aria-label="Current state">
      <div className="sb-main">
        <span className="label">Now</span>
        <strong className="sb-state" data-state={key}>
          {STATE_LABEL[key]}
        </strong>
        {next && (
          <span className="small">
            {next.label} <When t={next.at} /> · <b className="num">{countdown(next.at, now)}</b>
          </span>
        )}
        {!next && key === 'redeemed' && (
          <span className="small">
            Finished: holders were paid {o.outcome ? `${o.outcome.perUnit.toFixed(4)} ${sym}` : ''} per unit
            {o.outcome?.calledAt ? `, called early at observation ${o.outcome.calledAt}` : ''}.
          </span>
        )}
        {!next && key === 'knocked' && (
          <span className="small">
            Finished below the knock-in: holders received the stock or its cash value, not full principal.
          </span>
        )}
        {!next && key === 'defaulted' && (
          <span className="small">The issuer missed a payment: the collateral went to holders.</span>
        )}
      </div>
      <div className="sb-facts">
        <div>
          <span className="label">Latest observation</span>
          <span className="v num">{last === undefined ? 'Not yet' : fmtPct(last)}</span>
          {last !== undefined && levels.length > 0 && (
            <span className="xs muted">
              {levels.map((l) => `${l.name} ${l.v}% ${last * 100 >= l.v! ? '✓ above' : '✗ below'}`).join(' · ')}
            </span>
          )}
        </div>
        <div>
          <span className="label">Collateral coverage</span>
          <span className="v num">{cov == null ? '—' : fmtPct(cov)}</span>
          {o.economics?.ratio != null && (
            <span className="xs muted">needs {(o.economics.ratio * 100).toFixed(0)}% of what's sold</span>
          )}
        </div>
        {units !== null && (
          <div>
            <span className="label">Your position</span>
            <span className="v num">{fmtMoney(units, 0)} units</span>
            <span className="xs muted">
              {fmtMoney(units * (o.params.issuePricePct / 100))} {sym} at issue
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

import { MAX_GRACE_DAYS } from '@sn/core';

export type Every = { n: number; unit: 'minutes' | 'days' | 'months' };
export type Timing = { lag: number; grace: number };

/** The issuance schedule the wizard proposes: observation dates, and when each payment is due. */
export function issueSchedule(
  every: Every,
  strikeIn: number,
  timing: Timing | null,
  eco: { settlementLagDays: number; gracePeriodDays: number },
) {
  // Payment timing: per issuance. A schedule minutes apart (a demo) gets seconds; a real one, days.
  const stepSec =
    every.unit === 'minutes' ? every.n * 60 : every.unit === 'days' ? every.n * 86400 : every.n * 30 * 86400;
  const demo = every.unit === 'minutes';
  const t =
    timing ??
    (demo
      ? { lag: Math.min(30, Math.floor(stepSec / 4)), grace: Math.min(60, Math.floor(stepSec / 3)) }
      : { lag: eco.settlementLagDays * 86400, grace: eco.gracePeriodDays * 86400 });
  const timingBad =
    t.lag + t.grace > stepSec
      ? 'The payment date plus grace must fall before the next observation.'
      : t.grace > MAX_GRACE_DAYS * 86400
        ? `Grace is at most ${MAX_GRACE_DAYS} days.`
        : '';
  const strikeAt = Math.floor(Date.now() / 60000) * 60 + strikeIn * 60;
  const dateOf = (k: number) => {
    if (every.unit === 'months') {
      const d = new Date(strikeAt * 1000);
      d.setUTCMonth(d.getUTCMonth() + every.n * k);
      return Math.floor(d.getTime() / 1000);
    }
    return strikeAt + k * every.n * (every.unit === 'days' ? 86400 : 60);
  };
  const fmtT = (s: number) =>
    demo
      ? new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date(s * 1000).toLocaleDateString([], { dateStyle: 'medium' });
  const dur = (s: number) => (demo ? `${s}s` : `${+(s / 86400).toFixed(2)} days`);
  return { demo, t, timingBad, strikeAt, dateOf, fmtT, dur };
}

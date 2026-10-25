import { useState } from 'react';
import { economicsOf, simulateNote, simulatePerf, totalPerUnit } from '@sn/core';
import PayoffChart from '../PayoffChart';
import { Head } from './Head';
import type { DocInfo } from './types';

/** The reference payoff with a what-if path, the issuer's funding calls along it, and the default outcome. */
export function PayoffPanel({ doc }: { doc: DocInfo }) {
  const p = doc.basis;
  const [path, setPath] = useState<number[]>(() => new Array(p?.observations ?? 0).fill(100));
  const [ratioPct, setRatioPct] = useState<number | null>(null);
  if (!p || doc.edited || doc.origin !== 'product') {
    return (
      <>
        <Head title="Payoff" />
        <div className="section">
          <p className="small muted">
            {p
              ? 'This workflow was edited, so its payoff is the workflow itself: there is no reference payoff to chart. Issue it and watch it run, or reopen the term sheet for a stock product.'
              : 'Custom workflows have no reference payoff: the workflow is the payoff.'}
          </p>
        </div>
      </>
    );
  }
  const n = p.observations;
  const perfs = Array.from({ length: n }, (_, k) => (path[k] ?? 100) / 100);
  const r = simulatePerf(p, perfs);
  const basket = p.underlyings.length > 1;
  const eco = economicsOf(p);
  const ratio = (ratioPct ?? eco.collateralRatioPct) / 100;
  // The issuer's side along the same path, per 100 of face: what it must fund for each period, and by when.
  const calls = simulateNote(p, { perfs, sold: 100, ratio: 0, collateral: [] }).calls;
  return (
    <>
      <Head
        title="Payoff"
        sub="The reference payoff the on-chain workflow is tested against, and what the issuer must fund to pay it."
      />
      <div className="section">
        <span className="label">Payout per 100 at maturity</span>
        <PayoffChart params={p} />
      </div>
      <div className="section">
        <span className="label">
          What if: {basket ? 'worst performance' : 'level'} at each observation, % of strike
        </span>
        <div className="form-grid whatif-grid">
          {Array.from({ length: n }, (_, k) => (
            <div key={k} className="field">
              <label htmlFor={`wi-${k}`}>Obs {k + 1}</label>
              <input
                id={`wi-${k}`}
                type="number"
                value={path[k] ?? 100}
                onChange={(e) =>
                  setPath((x) => {
                    const y = [...x];
                    y[k] = Number(e.target.value);
                    return y;
                  })
                }
              />
            </div>
          ))}
        </div>
        <table className="t">
          <tbody>
            {r.coupons.map((c, k) => (
              <tr key={k}>
                <td>
                  Observation {k + 1}
                  {r.calledAt === k + 1 ? ' · autocalled' : ''}
                </td>
                <td className="r num">{(c * 100).toFixed(2)}</td>
              </tr>
            ))}
            <tr>
              <td>Redemption</td>
              <td className="r num">{(r.redemptionCash * 100).toFixed(2)}</td>
            </tr>
            <tr>
              <td>
                <strong>Total per 100</strong>
              </td>
              <td className="r num">
                <strong>{(totalPerUnit(r) * 100).toFixed(2)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="section" data-funding-calls>
        <span className="label">The issuer's funding calls along this path (per 100 of face)</span>
        <table className="t">
          <thead>
            <tr>
              <th>Period</th>
              <th>Due by</th>
              <th className="r">Issuer funds</th>
            </tr>
          </thead>
          <tbody>
            {calls.length === 0 && (
              <tr>
                <td colSpan={3} className="muted small">
                  Nothing to pay along this path.
                </td>
              </tr>
            )}
            {calls.map((c) => (
              <tr key={c.period}>
                <td>
                  {c.period}
                  {c.final ? (r.calledAt === c.period ? ' · autocall' : ' · maturity') : ''}
                </td>
                <td className="small">
                  observation {c.period} + {eco.settlementLagDays} day{eco.settlementLagDays === 1 ? '' : 's'}; grace{' '}
                  {eco.gracePeriodDays} day{eco.gracePeriodDays === 1 ? '' : 's'}
                </td>
                <td className="r num">
                  {c.perUnit ? (c.perUnit * 100).toFixed(2) : ''}
                  {c.deliver
                    ? `${c.perUnit ? ' + ' : ''}${(c.deliver.perUnit * 100).toFixed(4)} t${c.deliver.symbol}`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="xs muted">
          The subscriptions go to the issuer when the book closes; each payment is a call on the issuer, funded into the
          note's escrow before its date. Unfunded at the end of the grace period, the note defaults.
        </p>
      </div>
      <div className="section" data-default-outcome>
        <span className="label">If the issuer defaults</span>
        <div className="field">
          <label htmlFor="po-ratio">Collateral ratio, % of the notional</label>
          <input
            id="po-ratio"
            type="number"
            min={0}
            max={1000}
            value={ratioPct ?? eco.collateralRatioPct}
            onChange={(e) => setRatioPct(Number(e.target.value))}
          />
        </div>
        <p className="small">
          The escrow holds collateral worth at least <strong className="num">{(ratio * 100).toFixed(2)}</strong> per 100
          of face, counted after haircuts (
          {eco.collateral.map((c) => `${c.symbol === 'USD' ? 'USDG' : `t${c.symbol}`} ${c.haircutPct}%`).join(', ')}) at
          the last Chainlink prices, plus any payment the issuer had funded but not yet paid.{' '}
          {eco.defaultRule === 'cap-at-owed'
            ? 'Holders take what they are owed from it, pro rata (the missed payment plus par: 100 per 100 of face plus the coupon), stablecoin first, then collateral at market value; anything above that goes back to the issuer.'
            : 'Holders receive all of it, pro rata, whatever it is worth.'}{' '}
          <span className="xs muted" data-default-rule={eco.defaultRule}>
            (Default rule: {eco.defaultRule === 'cap-at-owed' ? 'capped at what is owed' : 'all to holders'}.)
          </span>
        </p>
        <p className="xs muted">
          {ratio >= 1
            ? 'Fully secured: on a default, collateral at least matches the face value outstanding.'
            : `Partly secured: up to ${((1 - ratio) * 100).toFixed(0)} per 100 of face rests on the issuer's credit.`}{' '}
          Coverage is checked at the strike and every observation; below the requirement the issuer must top up within
          the grace period.
        </p>
      </div>
    </>
  );
}

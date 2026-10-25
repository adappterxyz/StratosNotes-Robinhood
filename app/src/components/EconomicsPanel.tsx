/**
 * The note's economics on its page: the collateral behind it and its coverage, the issuer's payment schedule
 * with each period's status, and (for the issuer) the payment due now with a Fund button, collateral top-ups
 * and delivery funding. Holders see the same schedule and any margin call, grace period or default.
 */
import { useState } from 'react';
import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react';
import { dec, type WorkflowDef } from '@sn/core';
import { issuerActions, type NoteEconomics, type NoteState, type PeriodStatus } from '@sn/sdk';
import { useAddress, useNoteChain, useSigner } from '../lib/chains';
import { When } from './ui';
import { errText, fmtDate, fmtMoney, fmtPct, isReceipt, lockedAsset } from '../lib/format';

const STATUS: Record<PeriodStatus, string> = {
  upcoming: 'Upcoming',
  'nothing-due': 'Nothing due',
  due: 'Due',
  paid: 'Paid',
  grace: 'In grace',
  missed: 'Missed: default',
  cancelled: '—',
};
const fallbackName = (symbol: string) => (symbol === 'USD' ? 'USDG' : `t${symbol}`);
/** The token this note actually pledges for a collateral symbol, from its asset names ("Collateral TSLA"). */
function collateralTokenNames(def: WorkflowDef): (symbol: string) => string {
  const tokens = def.assets.map((a) => /^Collateral (.+)$/.exec(a.name)?.[1]).filter((t): t is string => !!t);
  const base = (t: string) =>
    t
      .replace(/\.[a-z]+$/, '')
      .replace(/^t(?=[A-Z])/, '')
      .replace(/^USDG$|^USD$/, 'USD');
  return (symbol) => tokens.find((t) => base(t) === symbol) ?? fallbackName(symbol);
}
/** Receipts (planned) stand for tokens locked on another chain. */
const remoteNote = (token: string) => (isReceipt(token) ? `${lockedAsset(token)}, locked on another chain` : token);
const countdown = (t: number, now: number) => {
  const s = Math.round(t - now);
  if (s <= 0) return 'now';
  if (s < 120) return `in ${s}s`;
  if (s < 7200) return `in ${Math.round(s / 60)} min`;
  if (s < 172_800) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86_400)} days`;
};

export default function EconomicsPanel({
  e,
  state,
  def,
  issuer,
  sym,
  now,
  onDone,
}: {
  e: NoteEconomics;
  state: NoteState;
  def: WorkflowDef;
  issuer: string;
  sym: string;
  now: number;
  onDone: () => void;
}) {
  const me = useAddress();
  const tokenName = collateralTokenNames(def);
  const engine = useNoteChain(state);
  const signer = useSigner();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const isIssuer = !!me && me.toLowerCase() === issuer.toLowerCase();
  const actions = issuerActions(def, state, now);
  const running = state.status === 0;

  const run = async (key: string, step: number, field: string, label: string, proposed = '') => {
    const raw = (amounts[key] ?? proposed).trim(); // the amount shown when the issuer typed nothing
    setBusy(key);
    setMsg(null);
    try {
      if (!(Number(raw) > 0)) throw new Error('Enter an amount.');
      const f = def.fields.findIndex((x) => x.name === field);
      if (!engine) throw new Error('This app does not serve the engine this note runs on.');
      const w = await signer(state.chain);
      await engine.adapter.executeStep(
        w,
        state.id,
        step,
        { [f]: { kind: 'number', value: dec(raw) } },
        undefined,
        (t) => setMsg({ kind: 'ok', text: `${t}…` }),
      );
      setMsg({ kind: 'ok', text: `${label}: ${raw} moved into escrow.` });
      setAmounts((a) => {
        const { [key]: _, ...rest } = a;
        return rest;
      }); // back to the proposed amount
      onDone();
    } catch (err) {
      setMsg({ kind: 'err', text: errText(err) });
    } finally {
      setBusy('');
    }
  };

  const call = e.nextCall;
  const shortfall = call ? Math.max(0, call.total - e.escrowCash) : 0;
  const proposed = (Math.ceil(shortfall * 1e6 - 1e-6) / 1e6).toString(); // rounded up: never short by a fraction
  const fundStep = call ? actions.fund.find((f) => f.period === call.period) : undefined;
  const covered = e.coveragePct === null ? null : e.coveragePct >= 1;

  return (
    <section className="card" data-economics data-state={e.state}>
      <div className="spread">
        <h3>Collateral and payments</h3>
        <span
          className={`pill ${e.state === 'defaulted' ? 'defaulted' : e.state === 'margin-call' || e.state === 'grace' ? 'fixing' : 'plain'}`}
          data-econ-state={e.state}
        >
          {e.state === 'defaulted'
            ? 'Defaulted'
            : e.state === 'margin-call'
              ? 'Margin call'
              : e.state === 'grace'
                ? 'Payment in grace'
                : e.state === 'released'
                  ? 'Collateral released'
                  : e.state === 'cancelled'
                    ? 'Cancelled'
                    : e.state === 'pending'
                      ? 'Before the strike'
                      : 'Secured'}
        </span>
      </div>

      {isIssuer && running && call && fundStep && !call.funded && (
        <div className="due" data-payment-due={call.period}>
          <div className="spread">
            <strong>Payment {call.period} due</strong>
            <span className="pill fixing">
              {countdown(call.payDate, now) === 'now' ? 'due now' : `due ${countdown(call.payDate, now)}`}
            </span>
          </div>
          <div className="small">
            Fund{' '}
            <b className="num">
              {fmtMoney(shortfall)} {sym}
            </b>{' '}
            by <When t={call.payDate} />
            {e.inGrace?.period === call.period ? (
              <>
                {' '}
                (grace until <When t={call.graceEnd} />)
              </>
            ) : (
              ''
            )}
            . Holders are paid from it on the payment date.
          </div>
          <div className="row flex-nowrap">
            <input
              className="maxw-160"
              aria-label="Amount to fund"
              inputMode="decimal"
              value={amounts.fund ?? proposed}
              onChange={(ev) => setAmounts((a) => ({ ...a, fund: ev.target.value }))}
            />
            <button
              className="btn primary"
              disabled={!!busy}
              onClick={() => run('fund', fundStep.step, 'fundAmount', `Payment ${call.period} funded`, proposed)}
              data-fund
            >
              {busy === 'fund'
                ? 'Confirm in your wallet…'
                : `Fund ${fmtMoney(Number(amounts.fund ?? proposed) || 0)} ${sym}`}
            </button>
          </div>
          <span className="xs muted">Your wallet asks you to approve {sym} first, then to fund.</span>
        </div>
      )}

      {e.state === 'defaulted' && (
        <div className="notice err row" role="status">
          <ShieldAlert className="i" />
          The issuer did not{' '}
          {e.milestones.some((m) => m.name === 'margin-call') && !e.milestones.some((m) => m.name === 'payment-missed')
            ? 'top up its collateral'
            : 'fund a payment'}{' '}
          in time.{' '}
          {e.defaultRule === 'cap-at-owed'
            ? 'The holders received what they were owed (the missed payment and par) from escrow, stablecoin first, then collateral at its last Chainlink price, pro rata to their units; the rest went back to the issuer.'
            : 'Everything in escrow (the collateral and any partial funding) went to the holders, pro rata to their units.'}{' '}
          Withdraw it under Your position.
        </div>
      )}
      {e.marginCall && (
        <div className="notice warn row" role="status">
          <AlertTriangle className="i" />
          Coverage is below the requirement
          {e.marginCall.period ? ` at observation ${e.marginCall.period}` : ' at the strike'}. The issuer must top up
          collateral by {fmtDate(e.marginCall.deadline)} ({countdown(e.marginCall.deadline, now)}) or the note defaults.
        </div>
      )}
      {e.inGrace && (
        <div className="notice warn row" role="status">
          <AlertTriangle className="i" />
          Payment {e.inGrace.period} was not funded by its payment date. Grace ends {fmtDate(e.inGrace.deadline)} (
          {countdown(e.inGrace.deadline, now)}); unfunded by then, the note defaults.
        </div>
      )}

      <div className="kv">
        <div>
          <span className="label">Collateral ratio</span>
          <span className="v" data-ratio>
            {e.ratio === null ? '—' : fmtPct(e.ratio)}
          </span>
        </div>
        <div>
          <span className="label">Required</span>
          <span className="v">{e.required === null ? '—' : `${fmtMoney(e.required, 0)} ${sym}`}</span>
        </div>
        <div>
          <span className="label">Coverage now</span>
          <span className="v" data-coverage>
            {e.coverage === null ? '—' : `${fmtMoney(e.coverage, 0)} ${sym}`}
            {e.coveragePct !== null && (
              <span className={`xs ${covered ? 'muted' : 'err'}`}> ({fmtPct(e.coveragePct)})</span>
            )}
          </span>
        </div>
        <div>
          <span className="label">Funded, not yet paid</span>
          <span className="v" data-escrow-cash>
            {fmtMoney(e.escrowCash)} {sym}
          </span>
        </div>
      </div>
      {e.collateral.length > 0 && (
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>In escrow</th>
                <th className="r">Amount</th>
                <th className="r">Price</th>
                <th className="r">Haircut</th>
                <th className="r">Counted</th>
              </tr>
            </thead>
            <tbody>
              {e.collateral.map((c) => (
                <tr key={c.symbol}>
                  <td>{remoteNote(tokenName(c.symbol))}</td>
                  <td className="r num">{fmtMoney(c.amount, c.symbol === 'USD' ? 2 : 6)}</td>
                  <td className="r num">{c.price === null ? '—' : fmtMoney(c.price)}</td>
                  <td className="r num">{fmtPct(1 - c.haircut)} off</td>
                  <td className="r num">{c.value === null ? '—' : fmtMoney(c.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="xs muted">
        The issuer has the subscription money and has pledged this collateral. It is locked in the note: nobody can
        withdraw it until every payment is made. Chainlink prices it on each report. If coverage falls below the
        requirement, the issuer has {graceText(e.grace)} to top up. If a payment is missed, holders take{' '}
        {e.defaultRule === 'cap-at-owed'
          ? 'what they are owed from the collateral, and the rest goes back to the issuer'
          : 'everything in escrow'}
        .
      </p>

      <span className="label">Payment schedule</span>
      <div className="scroll-x">
        <table className="t" data-schedule>
          <thead>
            <tr>
              <th>Period</th>
              <th>Payment date</th>
              <th className="r">Per unit</th>
              <th className="r">Issuer funds</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {e.periods.map((p) => (
              <tr key={p.k} data-period={p.k} data-status={p.status}>
                <td>{p.k}</td>
                <td className="small">
                  <When t={p.payDate} />
                  <div className="xs dim">
                    grace to <When t={p.graceEnd} />
                  </div>
                </td>
                <td className="r num">
                  {p.perUnit === null ? '—' : p.perUnit.toFixed(4)}
                  {p.deliver && (
                    <div className="xs dim">
                      + {p.deliver.perUnit.toFixed(6)} t{p.deliver.symbol}
                    </div>
                  )}
                </td>
                <td className="r num">{p.total === null ? '—' : fmtMoney(p.total)}</td>
                <td>
                  <span
                    className={`pill ${p.status === 'paid' ? 'live' : p.status === 'missed' ? 'defaulted' : p.status === 'grace' || p.status === 'due' ? 'fixing' : 'plain'}`}
                  >
                    {STATUS[p.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isIssuer && running && (
        <div className="stack gap-10 divider-top" data-issuer-actions>
          {call && fundStep && call.funded && (
            <div className="small row">
              <ShieldCheck className="i text-success" />
              Payment {call.period} is funded: holders are paid on <When t={call.payDate} />.
            </div>
          )}
          {!call && actions.fund.length > 0 && (
            <p className="xs muted">
              No payment is due now. You can fund the next one early from Fund Payment in the workflow; it stays in
              escrow until its payment date.
            </p>
          )}
          {actions.topUp.map((t) => (
            <div key={t.symbol} className="row flex-nowrap">
              <input
                aria-label={`Top up ${tokenName(t.symbol)}`}
                inputMode="decimal"
                placeholder={`${tokenName(t.symbol)} amount`}
                value={amounts[`top_${t.symbol}`] ?? ''}
                onChange={(ev) => setAmounts((a) => ({ ...a, [`top_${t.symbol}`]: ev.target.value }))}
              />
              <button
                className={`btn ${e.marginCall ? 'primary' : ''}`}
                disabled={!!busy}
                onClick={() =>
                  run(`top_${t.symbol}`, t.step, `topUp_${t.symbol}`, `${tokenName(t.symbol)} collateral topped up`)
                }
              >
                Top up {tokenName(t.symbol)}
              </button>
            </div>
          ))}
          {actions.delivery.map((d) => (
            <div key={d.symbol} className="row flex-nowrap">
              <input
                aria-label={`Fund t${d.symbol} delivery`}
                inputMode="decimal"
                placeholder={`t${d.symbol} amount`}
                value={amounts[`del_${d.symbol}`] ?? ''}
                onChange={(ev) => setAmounts((a) => ({ ...a, [`del_${d.symbol}`]: ev.target.value }))}
              />
              <button
                className="btn"
                disabled={!!busy}
                onClick={() =>
                  run(`del_${d.symbol}`, d.step, `fundDelivery_${d.symbol}`, `t${d.symbol} delivery funded`)
                }
              >
                Fund t{d.symbol} delivery
              </button>
            </div>
          ))}
          <p className="xs muted">
            Funding and top-ups move tokens from your wallet into the note's escrow (approve first). The subscriptions
            you received are yours: withdraw them under Your position.
          </p>
        </div>
      )}
      {msg && (
        <div className={`notice ${msg.kind}`} role="status">
          {msg.text}
        </div>
      )}
    </section>
  );
}

/** A grace period in plain words: "7 days", "8 hours", "45 minutes". */
function graceText(sec: number): string {
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (sec >= 86400 && sec % 86400 === 0) return unit(sec / 86400, 'day');
  if (sec >= 3600) return unit(Math.round(sec / 3600), 'hour');
  if (sec >= 60) return unit(Math.round(sec / 60), 'minute');
  return unit(sec, 'second');
}

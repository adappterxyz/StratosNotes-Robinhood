import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isAddress } from 'viem';
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, Radio, ShieldCheck, WalletCards } from 'lucide-react';
import { dec, defToBpmn, FEED_CHAIN_LABELS, instantiateProduct, SCALE } from '@sn/core';
import { CASH_ASSET, NOTE_ASSET, noteView, PHASE_LABEL, positionOf } from '@sn/sdk';
import TasksPanel from '../components/TasksPanel';
import EconomicsPanel from '../components/EconomicsPanel';
import HoldersPanel from '../components/HoldersPanel';
import BpmnView from '../components/BpmnView';
import { useVerifiedEmail } from '../components/VerifiedEmail';
import PayoffChart from '../components/PayoffChart';
import { Addr, Steps, When, type StepState } from '../components/ui';
import { plainTerms } from '../lib/plain';
import { useAddress, useChains, useSigner, cashSymbol, entryFor } from '../lib/chains';
import { agentLabel, errText, fmtMoney, fmtPct, fmtPrice } from '../lib/format';
import { useDefinition, useNote, useNow } from '../lib/live';
import { CurrentState } from '../components/NoteState';
import { AssetIcon, AssetStack } from '../components/AssetIcon';
import { FullTerms, Specs, YieldBlock } from '../components/Listing';
import { listingOf } from '../lib/listing';
import { useClaimable } from '../lib/balances';
import { useAutoReleased } from '../components/CrossChainCollateral';

export default function OfferingPage() {
  const { id: rawId } = useParams();
  const id = rawId ? decodeURIComponent(rawId) : undefined;
  const { note, refresh, updatedAt } = useNote(id);
  const def = useDefinition(note?.state.chain, note?.state.definition);
  const now = useNow(1000);
  const { byKey } = useChains();
  const signer = useSigner();
  const emailGate = useVerifiedEmail(); // a verified email before subscribing
  const me = useAddress();
  // Phases move with the clock (the book closes at the strike date) as well as with the chain.
  const o = useMemo(
    () => (note && def ? noteView(def, note.state, now) : note?.view),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note, def, Math.floor(now / 5)],
  );
  const [unitsIn, setUnits] = useState<string | null>(null);
  const [xfer, setXfer] = useState({ to: '', units: '' });
  const [busy, setBusy] = useState(false);
  // Subscribing is two transactions (a one-time approval, then the swap): shown as steps.
  const [subStep, setSubStep] = useState<{ approve: StepState; swap: StepState } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; tx?: string } | null>(null);
  const [claimTick, setClaimTick] = useState(0);
  // What I can claim, from the chain (payouts accrue in the note until I claim them; an issuer's proceeds).
  const claim = useClaimable(
    me,
    note?.state ? [{ id: note.state.id, chain: note.state.chain }] : [],
    CASH_ASSET,
    claimTick + (note?.state.updatedAt ?? 0),
  );
  // Stock products redraw from their term sheet; custom workflows from the definition.
  const xml = useMemo(
    () => (!o || !def ? '' : o.custom ? defToBpmn(def) : instantiateProduct(o.params).bpmnXml),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [o?.custom, def],
  );

  // Receipts of collateral locked on another chain: leaving the note they are burned and released on that chain.
  const autoReleased = useAutoReleased();
  if (note === undefined)
    return (
      <main className="page">
        <p className="muted">Loading the note…</p>
      </main>
    );
  if (note === null || !o)
    return (
      <main className="page">
        <div className="empty">
          <strong>No note with this id.</strong>
          <Link to="/">Back to the marketplace</Link>
        </div>
      </main>
    );

  const s = note.state;
  // The engine that runs this note: the chain's current one, or an earlier one its notes stay on (none today).
  const chain = entryFor(byKey, s);
  const legacy = !!chain?.legacy;
  const adapter = () => {
    if (!chain) throw new Error('This app does not serve the engine this note runs on.');
    return chain.adapter;
  };
  const sym = cashSymbol(chain?.cfg, s.assetTokens?.[1]);
  const explorer = chain?.cfg.explorer;
  const pos = me ? positionOf(s, me, def ?? undefined) : null;
  const chainCash = claim.get(s.id);
  const mine = pos && chainCash !== undefined ? { ...pos, cash: Number(chainCash) / Number(SCALE) } : pos;
  // The note's units as an ERC-20 (FlowEngine v4): zero address for notes on an older engine.
  const noteToken =
    s.assetTokens?.[NOTE_ASSET] && !/^0x0{40}$/i.test(s.assetTokens[NOTE_ASSET]) ? s.assetTokens[NOTE_ASSET] : null;
  const isIssuer = !!me && me.toLowerCase() === o.issuer.toLowerCase();
  const remaining = Math.max(0, o.notional - o.sold);
  // Default to a round amount that fits what is left in the book.
  const units = unitsIn ?? String(Math.max(0, Math.min(100, Math.floor(remaining))));
  const cost = ((Number(units) || 0) * o.params.issuePricePct) / 100;
  // Notes on an earlier engine take no new subscriptions (their holders still withdraw and settle there).
  const subscribable =
    !!def && !!chain && !legacy && o.phase === 'book' && !o.custom && def.steps.some((x) => x.id === 'Task_Subscribe');
  const run = async (what: string, f: () => Promise<{ tx: string[] }>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await f();
      setMsg({ kind: 'ok', text: what, tx: r.tx[r.tx.length - 1] });
      refresh();
      setClaimTick((t) => t + 1);
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const progress = (t: string) => setMsg({ kind: 'ok', text: `${t}…` });
  const subscribe = () => {
    setSubStep({ approve: 'now', swap: 'todo' });
    const onStep = (t: string) => {
      if (/^Approve/i.test(t)) setSubStep({ approve: 'now', swap: 'todo' });
      else if (/^Subscribe/i.test(t)) setSubStep({ approve: 'done', swap: 'now' });
    };
    return run(`Subscribed ${units} units for ${fmtMoney(cost)} ${sym}. They're in your portfolio.`, async () => {
      try {
        const r = await adapter().subscribe(await signer(s.chain), s.id, dec(units), onStep);
        setSubStep({ approve: 'done', swap: 'done' });
        return r;
      } catch (e) {
        setSubStep((x) =>
          x ? { approve: x.approve === 'now' ? 'err' : x.approve, swap: x.swap === 'now' ? 'err' : x.swap } : x,
        );
        throw e;
      }
    });
  };
  const transfer = () =>
    run(`Transferred ${xfer.units} units.`, async () => {
      if (!isAddress(xfer.to.trim())) throw new Error('Enter the recipient wallet address.');
      return adapter().transferUnits(await signer(s.chain), s.id, xfer.to.trim(), dec(xfer.units), progress);
    });
  const addToWallet = () =>
    run('Added the note token to your wallet.', async () => {
      const w = await signer(s.chain);
      const p = await adapter().watchAssetParams(s.id);
      if (!p) throw new Error('This note has no unit token.');
      await w.watchAsset(p);
      return { tx: [] };
    });
  const withdraw = (asset: number, done = 'Withdrawn to your wallet.') =>
    run(done, async () => adapter().withdraw(await signer(s.chain), s.id, asset, undefined, progress));
  // A holder claims coupons and the redemption: one transaction for everything accrued so far, with a receipt.
  const claimPayouts = () =>
    run(
      legacy
        ? 'Withdrawn to your wallet.'
        : 'Claimed to your wallet. The receipt is in your portfolio under Paid to your wallet.',
      async () => {
        const r = await adapter().claimPayouts(await signer(s.chain), s.id, CASH_ASSET, progress);
        if (r.deferred)
          throw new Error(`${sym} refused the transfer to your wallet: it stays claimable here. Try again later.`);
        return r;
      },
    );
  const pay = listingOf(o.params, {}, sym).payout;
  // Delivered tokens (physical settlement) and collateral received on a default, withdrawable like cash.
  const delivered = mine?.other ?? [];
  // The economics panel runs the issuer's funding, top-up and delivery windows; the generic task list skips them.
  const economicSteps = def
    ? def.steps.map((x) => x.id).filter((x) => /^Task_(Fund\d+|TopUp_|FundDelivery_)/.test(x))
    : [];

  const basket = o.unds.length > 1;
  const levels = (k: number) => o.unds.map((u) => `${u.symbol} ${fmtPrice(u.observed[k])}`).join(' · ');
  const events: Array<{ label: string; when: number; value?: string; state: 'done' | 'now' | 'later' }> = o.hasTerms
    ? [
        {
          label: 'Book closes, strike fixed',
          when: o.strikeDate,
          value: o.strikeFixed
            ? o.unds.map((u) => `${basket ? `${u.symbol} ` : ''}${fmtPrice(u.strike!)}`).join(' · ')
            : undefined,
          state: o.strikeFixed ? 'done' : o.phase === 'fixing' ? 'now' : 'later',
        },
        ...o.obsDates.map((t, k) => ({
          label: k === o.obsDates.length - 1 ? 'Final observation (maturity)' : `Observation ${k + 1}`,
          when: t,
          value:
            o.perfs[k] !== undefined
              ? basket
                ? `worst ${fmtPct(o.perfs[k])} (${levels(k)})`
                : `${fmtPrice(o.unds[0].observed[k])} (${fmtPct(o.perfs[k])})`
              : undefined,
          state: (o.perfs[k] !== undefined ? 'done' : o.phase === 'live' && k === o.perfs.length ? 'now' : 'later') as
            'done' | 'now' | 'later',
          ...((o.phase === 'redeemed' || o.phase === 'defaulted') && o.perfs[k] === undefined
            ? {
                value:
                  o.phase === 'defaulted'
                    ? 'not reached: defaulted'
                    : o.outcome?.calledAt
                      ? `not needed: called at ${o.outcome.calledAt}`
                      : 'not observed',
              }
            : {}),
        })),
      ]
    : [];
  const secsAgo = Math.max(0, Math.round(now - updatedAt / 1000));
  const agent = agentLabel(o);

  return (
    <main className="page">
      <Link to="/" className="small row gap-4">
        <ArrowLeft className="i" />
        Marketplace
      </Link>
      <div className="page-head">
        <div className="stack gap-6">
          <span className="label row gap-8">
            <AssetStack
              syms={o.unds.length ? o.unds.map((u) => u.symbol) : o.params.underlyings.map((u) => u.symbol)}
              size={18}
              label={false}
            />
            {listingOf(o.params, {}, sym).assets} · {chain?.cfg.name ?? s.chain}
          </span>
          <div className="row">
            <h1>{o.name}</h1>
            <span className={`pill ${o.phase}`} data-phase={o.phase}>
              <span className="dot" />
              {PHASE_LABEL[o.phase]}
            </span>
            {legacy && (
              <span
                className="pill plain"
                data-earlier-engine
                title={`Issued on an earlier engine (v${chain?.version}). Your units are in that engine's ledger, not an ERC-20.`}
              >
                Earlier engine
              </span>
            )}
          </div>
        </div>
        <div className="stack gap-6 items-end">
          <span
            className="pill plain"
            title="This page updates when the indexer sees anything happen to the note: a report, a subscription, a transfer."
          >
            <Radio className="i ic-12 text-success" />
            Live · updated {secsAgo < 5 ? 'just now' : `${secsAgo}s ago`}
          </span>
          {agent && (
            <span
              className="pill plain"
              data-agent={o.reports.last ?? ''}
              title="Who submitted this note's price reports: Chainlink CRE through its forwarder, or the fallback keeper where CRE cannot write"
            >
              <ShieldCheck className="i ic-12" />
              {agent}
            </span>
          )}
        </div>
      </div>

      {o.hasTerms && (
        <section className="card plain-sum" aria-label="In short">
          <YieldBlock o={o} cash={sym} big />
          <Specs o={o} cash={sym} now={now} />
        </section>
      )}
      {o.hasTerms && <FullTerms o={o} cash={sym} />}

      <CurrentState o={o} now={now} sym={sym} units={mine && mine.units > 0 ? mine.units : null} />

      {legacy && (
        <div className="notice info" role="note" data-earlier-engine-note>
          This note runs on an earlier version of the engine (v{chain?.version}). It keeps running to maturity there:
          holders withdraw coupons, the redemption and anything delivered from this page or the portfolio. It takes no
          new subscriptions; new notes are issued on the current engine.
        </div>
      )}

      <div className="two note-layout">
        <div className="stack">
          <section className="card">
            <div className="kv">
              <div>
                <span className="label">Size</span>
                <span className="v">
                  {fmtMoney(o.notional, 0)} {sym}
                </span>
              </div>
              <div>
                <span className="label">Subscribed</span>
                <span className="v" data-sold>
                  {fmtMoney(o.sold, 0)}
                </span>
              </div>
              <div>
                <span className="label">Issue price</span>
                <span className="v">{o.params.issuePricePct}%</span>
              </div>
              <div>
                <span className="label">Observations</span>
                <span className="v">{o.params.observations}</span>
              </div>
              <div>
                <span className="label">{basket ? 'Worst performance' : 'Performance'}</span>
                <span className="v">{o.perfs.length ? fmtPct(o.perfs[o.perfs.length - 1]) : '—'}</span>
              </div>
              <div>
                <span className="label">Paid so far per unit</span>
                <span className="v" data-per-unit>
                  {o.outcome ? `${o.outcome.perUnit.toFixed(4)} ${sym}` : '—'}
                </span>
              </div>
            </div>
            {o.unds.length > 0 && (
              <div className="scroll-x">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Underlying</th>
                      <th className="r">Strike</th>
                      <th className="r">Last observed</th>
                      <th className="r">Performance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.unds.map((u) => {
                      const last = u.observed[u.observed.length - 1];
                      return (
                        <tr key={u.symbol}>
                          <td>
                            <span className="row gap-6 inline-flex">
                              <AssetIcon sym={u.symbol} size={18} />
                              {u.symbol}/USD
                            </span>{' '}
                            <span className="xs dim" title={`Chainlink feed on ${u.feedChain}: ${u.feed}`}>
                              Chainlink · {FEED_CHAIN_LABELS[u.feedChain] ?? u.feedChain}
                            </span>
                          </td>
                          <td className="r num">{u.strike === null ? '—' : fmtPrice(u.strike)}</td>
                          <td className="r num">{last === undefined ? '—' : fmtPrice(last)}</td>
                          <td className="r num">
                            {last === undefined || u.strike === null ? '—' : fmtPct(last / u.strike)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {events.length > 0 && (
            <section className="card">
              <div className="spread">
                <h3>Schedule</h3>
                <span className="xs muted">Prices observed by Chainlink CRE · times in your time zone</span>
              </div>
              <div className="timeline">
                {events.map((e) => (
                  <div key={e.label} className={`tl ${e.state}`}>
                    <span className="mark" />
                    <span>
                      {e.label}
                      <br />
                      <span className="xs muted">
                        <When t={e.when} />
                      </span>
                    </span>
                    <span className="num small text-right">
                      {e.value ?? (e.state === 'now' ? (now >= e.when ? 'due: waiting for the report' : 'next') : '')}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {xml && (
            <details className="adv">
              <summary>Advanced: the note's workflow diagram</summary>
              <div className="adv-body">
                <p className="xs muted">Every step of this note as it runs on-chain. Highlighted: where it is now.</p>
                <BpmnView xml={xml} active={o.activeSteps} />
              </div>
            </details>
          )}
        </div>

        <aside className="stack">
          {subscribable && (
            <section className="card" data-subscribe>
              <div className="spread">
                <h2>Subscribe</h2>
                <span className="pill book">
                  <span className="dot" />
                  Open until <When t={o.strikeDate} />
                </span>
              </div>
              <ul className="terms" aria-label="What you get">
                {plainTerms(o.params, sym, o.economics?.ratio ? Math.round(o.economics.ratio * 100) : undefined).map(
                  (t) => (
                    <li key={t.text} className={t.kind}>
                      {t.kind === 'good' ? (
                        <CheckCircle2 className="i" />
                      ) : t.kind === 'risk' ? (
                        <AlertTriangle className="i" />
                      ) : (
                        <Info className="i" />
                      )}
                      <span>{t.text}</span>
                    </li>
                  ),
                )}
              </ul>
              <div className="field">
                <label htmlFor="units">
                  How many units?{' '}
                  <span className="muted">
                    (1 unit = 1 {sym} of face · {fmtMoney(remaining, 0)} left)
                  </span>
                </label>
                <input id="units" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} />
              </div>
              <div className="youpay">
                <div>
                  <span className="label">You pay</span>
                  <span className="v">
                    {fmtMoney(cost)} {sym}
                  </span>
                </div>
                <div>
                  <span className="label">You receive</span>
                  <span className="v">{fmtMoney(Number(units) || 0, 0)} units</span>
                </div>
              </div>
              {Number(units) > remaining && <p className="xs err">Only {fmtMoney(remaining, 0)} units are left.</p>}
              <p className="xs muted m-0" data-how-paid>
                <strong>How you get paid:</strong> {pay.detail}
              </p>
              <button
                className="btn primary lg"
                disabled={!me || busy || !(Number(units) > 0) || Number(units) > remaining}
                onClick={() => void emailGate.require(s.chain, subscribe)}
              >
                {me
                  ? busy
                    ? 'Confirm in your wallet…'
                    : `Subscribe for ${fmtMoney(cost)} ${sym}`
                  : 'Connect a wallet to subscribe'}
              </button>
              {subStep && (
                <Steps
                  items={[
                    { label: `Approve ${sym} (one time)`, state: subStep.approve },
                    { label: 'Subscribe: pay and receive units in one transaction', state: subStep.swap },
                  ]}
                />
              )}
              <p className="xs muted">
                Need {sym}? Use <b>Get testnet tokens</b> in the top bar.
              </p>
              {emailGate.dialog}
            </section>
          )}

          {def && o.economics && (
            <EconomicsPanel
              e={o.economics}
              state={s}
              def={def}
              issuer={o.issuer}
              sym={sym}
              now={now}
              onDone={refresh}
            />
          )}

          {def && (
            <TasksPanel
              state={s}
              def={def}
              onDone={refresh}
              hide={[...(o.custom ? [] : ['Task_Subscribe']), ...economicSteps]}
            />
          )}

          {mine && (mine.units > 0 || mine.cash > 0 || delivered.length > 0) && (
            <section className="card" data-position>
              <h3>Your position</h3>
              <div className="kv">
                <div>
                  <span className="label">Note units</span>
                  <span className="v" data-units>
                    {fmtMoney(mine.units)}
                  </span>
                </div>
                <div>
                  <span className="label">{isIssuer ? 'Proceeds to withdraw' : 'Claimable'}</span>
                  <span className="v" data-cash>
                    {fmtMoney(mine.cash)}
                  </span>
                </div>
              </div>
              {noteToken && mine.units > 0 && (
                <div className="spread small" data-note-token>
                  <span>
                    Your units are an ERC-20 token:{' '}
                    <Addr value={noteToken} href={explorer ? `${explorer}/token/${noteToken}` : undefined} />
                  </span>
                  <button className="btn sm" disabled={busy} onClick={addToWallet}>
                    <WalletCards className="i" />
                    Add to wallet
                  </button>
                </div>
              )}
              {!isIssuer && (
                <span className="xs muted" data-how-paid>
                  {legacy ? 'On this engine, coupons and the redemption wait here until you claim them.' : pay.detail}
                </span>
              )}
              {isIssuer ? (
                <button
                  className="btn"
                  disabled={busy || !(mine.cash > 0)}
                  onClick={() => withdraw(CASH_ASSET)}
                >{`Withdraw proceeds (${sym})`}</button>
              ) : (
                <button
                  className="btn primary"
                  disabled={busy || !(mine.cash > 1e-6)}
                  onClick={claimPayouts}
                  data-claim
                >{`Claim ${mine.cash > 1e-6 ? `${fmtMoney(mine.cash)} ` : ''}${sym}`}</button>
              )}
              {delivered.map((h) => {
                const name = h.name.replace(/^Collateral /, '');
                const kind = h.name.startsWith('Collateral ')
                  ? isIssuer
                    ? 'Collateral released'
                    : 'Collateral received'
                  : 'Delivered';
                const auto = autoReleased(s.assetTokens?.[h.asset]);
                const real = name.replace(/\.[a-z]+$/, '');
                return (
                  <div key={h.asset} className="spread small" data-other-asset={h.name}>
                    <span>
                      {kind} <span className="num">{h.amount.toFixed(6)}</span>{' '}
                      {auto ? `${real} on ${auto.chain}` : name}
                    </span>
                    {auto ? (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          withdraw(
                            h.asset,
                            `Released: the vault on ${auto.chain} pays your ${real} to this address over Chainlink CCIP (about 15–25 minutes once sent). Follow it in your portfolio under Collateral & receipts.`,
                          )
                        }
                        data-release
                      >
                        Release to {auto.chain}
                      </button>
                    ) : (
                      <button className="btn" disabled={busy} onClick={() => withdraw(h.asset)}>
                        Withdraw {name}
                      </button>
                    )}
                  </div>
                );
              })}
              {mine.units > 0 && o.phase !== 'redeemed' && o.phase !== 'defaulted' && (
                <div className="stack gap-8 divider-top">
                  <span className="label">Transfer notes</span>
                  <div className="field">
                    <label htmlFor="x-to">To wallet</label>
                    <input
                      id="x-to"
                      className="num"
                      value={xfer.to}
                      onChange={(e) => setXfer({ ...xfer, to: e.target.value })}
                      placeholder="0x…"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="x-units">Units (up to {fmtMoney(mine.units)})</label>
                    <input
                      id="x-units"
                      inputMode="decimal"
                      value={xfer.units}
                      onChange={(e) => setXfer({ ...xfer, units: e.target.value })}
                    />
                  </div>
                  <button
                    className="btn"
                    disabled={busy || !(Number(xfer.units) > 0) || Number(xfer.units) > mine.units}
                    onClick={transfer}
                  >
                    Transfer
                  </button>
                  <span className="xs muted">
                    In whole or in part, to a wallet with a verified email only.{' '}
                    {legacy
                      ? 'Cash already credited stays yours to withdraw'
                      : 'Payouts already made stay yours to claim'}
                    ; from now on they go to whoever holds the units.
                  </span>
                </div>
              )}
            </section>
          )}

          {msg && (
            <div className={`notice ${msg.kind}`} role="status">
              {msg.text}{' '}
              {msg.tx && explorer && (
                <a href={`${explorer}/tx/${msg.tx}`} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              )}
            </div>
          )}

          {def && <HoldersPanel state={s} def={def} explorer={explorer} issuer={o.issuer} />}

          {o.custom && def && (
            <section className="card">
              <h3>Workflow fields</h3>
              <table className="t">
                <tbody>
                  {def.fields.map((f, i) => {
                    const v = s.values[i];
                    const shown = !v
                      ? '—'
                      : v.tag === 1
                        ? f.kind === 0
                          ? (Number(BigInt(v.value)) / Number(SCALE)).toLocaleString()
                          : f.kind === 2
                            ? new Date(Number(v.value) * 1000).toLocaleString()
                            : v.value
                        : v.value;
                    return (
                      <tr key={f.name}>
                        <td>{f.name}</td>
                        <td className="r num">{shown}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {!o.custom && (
            <section className="card">
              <h3>Payout per 100 at maturity</h3>
              <PayoffChart params={o.params} />
              <p className="xs muted">
                Against the final {basket ? 'worst performance' : 'level'}, % of strike, if not called earlier. Dashed
                lines: barriers.
              </p>
            </section>
          )}

          <details className="adv">
            <summary>Advanced: contract details</summary>
            <div className="adv-body small">
              <div className="spread">
                <span className="muted">Network</span>
                <span>{chain?.cfg.name ?? s.chain}</span>
              </div>
              {noteToken && (
                <div className="spread">
                  <span className="muted">Note token (ERC-20)</span>
                  <Addr value={noteToken} href={explorer ? `${explorer}/token/${noteToken}` : undefined} />
                </div>
              )}
              <div className="spread">
                <span className="muted">Engine{legacy ? ` (v${chain?.version}, earlier)` : ''} · note #</span>
                <span>
                  <Addr value={s.engine} href={explorer ? `${explorer}/address/${s.engine}` : undefined} /> · #{s.pid}
                </span>
              </div>
              <div className="spread">
                <span className="muted">Workflow definition</span>
                <Addr value={s.definition} />
              </div>
              <div className="spread">
                <span className="muted">Issuer</span>
                <Addr value={o.issuer} href={explorer ? `${explorer}/address/${o.issuer}` : undefined} />
              </div>
              <div className="spread">
                <span className="muted">Note units held</span>
                <span className="num">
                  {fmtMoney(
                    s.holdings
                      .filter((h) => h.asset === NOTE_ASSET)
                      .reduce((a, h) => a + Number(BigInt(h.balance)) / Number(SCALE), 0),
                    0,
                  )}
                </span>
              </div>
            </div>
          </details>
        </aside>
      </div>
    </main>
  );
}

/**
 * A note's page, in three layers. (a) The summary: its plain name, what you get, the main risk, the barrier bar with
 * where the underlyings stand, its status, and buying (or your position). (b) The timeline of checks and payments,
 * and "play the note". (c) Details in tabs: full terms, collateral and payments, holders, how the workflow runs and
 * the contract. Phone first: no wide tables in the first two layers.
 */
import { LivePrices } from '../components/LivePrices';
import { Backtest } from '../components/Backtest';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isAddress } from 'viem';
import { AlertTriangle, ArrowLeft, CheckCircle2, Radio, ShieldCheck, WalletCards } from 'lucide-react';
import {
  dec,
  defToBpmn,
  feedSourceLabel,
  isAtlasFeed,
  instantiateProduct,
  isNoteChain,
  NOTE_CHAIN_SHORT,
  fixingRuleText,
  SCALE,
  stockTokenNotes,
} from '@sn/core';
import { CASH_ASSET, NOTE_ASSET, noteView, PHASE_LABEL, positionOf, type NoteView } from '@sn/sdk';
import { useNarrow } from '../lib/useNarrow';
import TasksPanel from '../components/TasksPanel';
import EconomicsPanel from '../components/EconomicsPanel';
import HoldersPanel from '../components/HoldersPanel';
import NoteFlow from '../components/NoteFlow';
import { useVerifiedEmail } from '../components/VerifiedEmail';
import PayoffChart from '../components/PayoffChart';
import { Addr, Steps, When, type StepState } from '../components/ui';
import { useAddress, useChains, useSigner, cashSymbol, entryFor } from '../lib/chains';
import { agentLabel, errText, fmtMoney, fmtPct, fmtPrice } from '../lib/format';
import { useDefinition, useNote, useNow } from '../lib/live';
import { AssetIcon, AssetStack } from '../components/AssetIcon';
import { FullTerms } from '../components/Listing';
import { listingOf } from '../lib/listing';
import { useClaimable } from '../lib/balances';
import { useAutoReleased } from '../components/CrossChainCollateral';
import { BarrierBar } from '../components/BarrierBar';
import { factsOf, rateOf } from '../components/NoteCard';
import { PlayNote } from '../components/PlayNote';
import { useToast } from '../components/Toast';
import {
  CALM_LABEL,
  countdown,
  getLine,
  linesOf,
  marksOf,
  nextCheck,
  plainName,
  productTag,
  riskLine,
  statusOf,
} from '../lib/story';

type Tab = 'terms' | 'money' | 'holders' | 'flow' | 'contract';

export default function OfferingPage() {
  const { id: rawId } = useParams();
  const id = rawId ? decodeURIComponent(rawId) : undefined;
  const { note, refresh, updatedAt } = useNote(id);
  const def = useDefinition(note?.state.chain, note?.state.definition);
  const now = useNow(1000);
  const { byKey } = useChains();
  const signer = useSigner();
  const emailGate = useVerifiedEmail(); // a verified email before subscribing
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('terms');
  // On a phone the full terms start folded, so the page is not one long table.
  const narrow = useNarrow(720);
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

  // Moments worth a beat while the page is open: a coupon paid, an early repayment.
  const seen = useRef<{ id: string; paid: number; called: boolean } | null>(null);
  useEffect(() => {
    if (!o || !id) return;
    const paid = o.outcome?.perUnit ?? 0;
    const called = !!o.outcome?.calledAt && o.phase === 'redeemed';
    const was = seen.current;
    seen.current = { id, paid, called };
    if (!was || was.id !== id) return;
    const sym0 = cashSymbol(entryFor(byKey, note!.state)?.cfg, note!.state.assetTokens?.[1]);
    if (called && !was.called)
      toast({
        tone: 'party',
        title: 'Repaid early',
        body: `The check came in above the early-repayment line: holders get their money back with ${fmtMoney(paid, 4)} ${sym0} per unit in all.`,
      });
    else if (paid > was.paid + 1e-9)
      toast({
        tone: 'coin',
        title: `Coupon paid: ${fmtMoney(paid - was.paid, 4)} ${sym0} per unit`,
        body: 'Claim it from your portfolio any time.',
      });
  }, [o?.outcome?.perUnit, o?.phase, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Receipts of collateral locked on another chain: leaving the note they are burned and released on that chain.
  const autoReleased = useAutoReleased(note?.state.chain);
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
        toast({ tone: 'plain', mark: '+', title: `You're in: ${units} units`, body: 'They are in your portfolio.' });
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
        toast({
          tone: 'coin',
          title: `Claimed ${fmtMoney(mine?.cash ?? 0)} ${sym}`,
          body: 'Sent to your wallet, with a receipt.',
        });
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

  const secsAgo = Math.max(0, Math.round(now - updatedAt / 1000));
  const agent = agentLabel(o);
  const sched = { strikeDate: o.strikeDate, obsDates: o.obsDates };
  const rate = rateOf(o.params, sym, sched);
  const st = statusOf(o, sym);
  const marks = marksOf(o);
  const next = nextCheck(o, now);
  const finished = st.key !== 'open' && st.key !== 'running';
  const name = o.hasTerms ? plainName(o.params) : o.name;
  const chainKey = s.chain;
  const chainShort = isNoteChain(chainKey) ? NOTE_CHAIN_SHORT[chainKey] : (chain?.cfg.name ?? chainKey);
  // What the issuer must see at once (a payment to fund, a top-up), and holders when something is wrong.
  const econUrgent = !!o.economics && (isIssuer || !!o.economics.marginCall || !!o.economics.inGrace);
  const position = mine && (mine.units > 0 || mine.cash > 0 || delivered.length > 0);
  const startPath = o.perfs.length ? o.perfs.map((x) => Math.round(x * 100)) : undefined;

  return (
    <main className="page note-page">
      <Link to="/" className="small row gap-4">
        <ArrowLeft className="i" />
        Marketplace
      </Link>

      {/* (a) the summary: what you get, the main risk, status, buy */}
      <section className="note-sum" aria-label="In short">
        <div className="card ns-main">
          <div className="ns-tags">
            <AssetStack
              syms={o.unds.length ? o.unds.map((u) => u.symbol) : o.params.underlyings.map((u) => u.symbol)}
              size={28}
              label={false}
            />
            {o.hasTerms && <span className="tag">{productTag(o.params)}</span>}
            <span className="tag chain">
              <span data-note-chain>{chainShort}</span> · {sym}
            </span>
            {legacy && (
              <span
                className="tag"
                data-earlier-engine
                title={`Issued on an earlier engine (v${chain?.version}). Your units are in that engine's ledger, not an ERC-20.`}
              >
                Earlier engine
              </span>
            )}
          </div>
          <div className="ns-title">
            <h1>{name}</h1>
            {o.hasTerms && name !== o.name && <span className="small muted">Issued as “{o.name}”</span>}
          </div>
          <div className="ns-status" data-phase={o.phase}>
            {st.key === 'open' || st.key === 'running' ? (
              <span className={`nc-live${st.key === 'open' ? ' open' : ''}`} data-countdown>
                {next ? (
                  <>
                    {next.label} in <b className="num">{countdown(next.at, now)}</b>
                  </>
                ) : (
                  CALM_LABEL[st.key]
                )}
              </span>
            ) : (
              <span className={`nc-done c-${st.key}`}>{CALM_LABEL[st.key]}</span>
            )}
            <span
              className="xs muted row gap-4"
              title="This page updates when the indexer sees anything happen to the note: a report, a subscription, a transfer."
            >
              <Radio className="i ic-12 text-success" />
              Live · updated {secsAgo < 5 ? 'just now' : `${secsAgo}s ago`}
            </span>
          </div>

          {o.hasTerms ? (
            <>
              <div className="ns-rate">
                <strong className="num">{rate.big}</strong>
                <span>
                  {rate.sub}
                  {rate.cond && rate.cond !== 'fixed' ? `, ${rate.cond}` : ''}
                </span>
              </div>
              <div className="ns-say">
                <p className="good">
                  <CheckCircle2 className="i" />
                  <span>
                    <b>What you get.</b> {getLine(o.params, sym)}
                  </span>
                </p>
                <p className="risk">
                  <AlertTriangle className="i" />
                  <span>
                    <b>The main risk.</b> {riskLine(o.params, sym)}
                  </span>
                </p>
              </div>
              {o.hasTerms && fixingRuleText(o.params) && (
                <p className="xs muted" data-fixing-rule>
                  {fixingRuleText(o.params)}
                </p>
              )}
              {o.hasTerms &&
                !o.outcome &&
                o.params.underlyings.length > 0 &&
                o.params.underlyings.every((u) => isAtlasFeed(u.feed)) && (
                  <LivePrices
                    unds={o.params.underlyings.map((u) => ({
                      symbol: u.symbol,
                      strike: o.unds.find((x) => x.symbol === u.symbol)?.strike ?? null,
                    }))}
                  />
                )}
              {o.hasTerms && <Backtest p={o.params} schedule={sched} cash={sym} />}
              {o.hasTerms &&
                stockTokenNotes(o.params).map((n) => (
                  <p key={n.key} className="xs muted" data-stock-note={n.key}>
                    {n.text}
                  </p>
                ))}
              <BarrierBar
                p={o.params}
                marks={marks}
                past={finished}
                note={
                  o.phase === 'book'
                    ? `The lines are set against the starting price, which ${o.params.underlyings?.some((u) => isAtlasFeed(u.feed)) ? 'Atlas' : 'Chainlink'} fixes when the book closes.`
                    : undefined
                }
              />
              {st.story && <p className="nc-story">{st.story}</p>}
              <ul className="nc-facts">
                {factsOf(o.params, sched, [
                  <span key="p">{pay.method === 'push' ? 'Paid to your wallet' : 'Claim payouts any time'}</span>,
                ]).map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="small muted">
              A custom workflow: its payoff is defined by the workflow itself. See how it runs under Details.
            </p>
          )}
          <dl className="ns-kv">
            <div>
              <dt>Size</dt>
              <dd className="num">
                {fmtMoney(o.notional, 0)} {sym}
              </dd>
            </div>
            <div>
              <dt>Sold</dt>
              <dd className="num" data-sold>
                {fmtMoney(o.sold, 0)}
              </dd>
            </div>
            <div>
              <dt>Paid so far per unit</dt>
              <dd className="num" data-per-unit>
                {o.outcome ? `${o.outcome.perUnit.toFixed(4)} ${sym}` : '—'}
              </dd>
            </div>
            {agent && (
              <div>
                <dt>Prices delivered by</dt>
                <dd
                  data-agent={o.reports.last ?? ''}
                  title="Who submitted this note's price reports: Chainlink CRE through its forwarder, or the fallback keeper where CRE cannot write"
                >
                  <ShieldCheck className="i ic-12" /> {agent.replace(/^Reported by /, '')}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <aside className="stack ns-side">
          {subscribable && (
            <section className="card buy" data-subscribe>
              <div className="spread">
                <h2>Buy units</h2>
                <span className="xs muted">
                  Open until <When t={o.strikeDate} />
                </span>
              </div>
              <div className="field">
                <label htmlFor="units">
                  How many units?{' '}
                  <span className="muted">
                    (1 unit = 1 {sym} · {fmtMoney(remaining, 0)} left)
                  </span>
                </label>
                <input id="units" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} />
                <div className="presets">
                  {[10, 100, 1000]
                    .filter((x) => x <= remaining)
                    .map((x) => (
                      <button key={x} type="button" className="chip" onClick={() => setUnits(String(x))}>
                        {x.toLocaleString()}
                      </button>
                    ))}
                </div>
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
              <p className="xs muted m-0" data-how-paid>
                {pay.detail} Need {sym}? The tools menu in the top bar lists the faucets.
              </p>
              {emailGate.dialog}
            </section>
          )}

          {!subscribable && !position && (
            <section className={`card ns-next${finished ? ' finished' : ''}`}>
              {next ? (
                <>
                  <span className="small muted">{next.label}</span>
                  <strong className="num">{countdown(next.at, now)}</strong>
                  <span className="xs muted">
                    <When t={next.at} />
                  </span>
                </>
              ) : (
                <>
                  <span className="small muted">{finished ? 'This note has finished' : 'Status'}</span>
                  <strong>{CALM_LABEL[st.key]}</strong>
                  {o.outcome && (
                    <span className="small">
                      Holders got <b className="num">{fmtMoney(o.outcome.perUnit, 4)}</b> {sym} per unit
                      {o.phase === 'defaulted' ? ' before the default, then the collateral' : ''}.
                    </span>
                  )}
                </>
              )}
              <Link to="/" className="btn sm">
                Browse other notes
              </Link>
            </section>
          )}

          {position && mine && (
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
                const nm = h.name.replace(/^Collateral /, '');
                const kind = h.name.startsWith('Collateral ')
                  ? isIssuer
                    ? 'Collateral released'
                    : 'Collateral received'
                  : 'Delivered';
                const auto = autoReleased(s.assetTokens?.[h.asset]);
                const real = nm.replace(/\.[a-z]+$/, '');
                return (
                  <div key={h.asset} className="spread small" data-other-asset={h.name}>
                    <span>
                      {kind} <span className="num">{h.amount.toFixed(6)}</span> {auto ? `${real} on ${auto.chain}` : nm}
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
                        Withdraw {nm}
                      </button>
                    )}
                  </div>
                );
              })}
              {mine.units > 0 && o.phase !== 'redeemed' && o.phase !== 'defaulted' && (
                <details className="adv">
                  <summary>Transfer units</summary>
                  <div className="stack gap-8 adv-body">
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
                </details>
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

          {def && o.economics && econUrgent && (
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
        </aside>
      </section>

      {legacy && (
        <div className="notice info" role="note" data-earlier-engine-note>
          This note runs on an earlier version of the engine (v{chain?.version}). It keeps running to maturity there:
          holders withdraw coupons, the redemption and anything delivered from this page or the portfolio. It takes no
          new subscriptions; new notes are issued on the current engine.
        </div>
      )}

      {/* (b) the timeline, and play the note */}
      {o.hasTerms && <Timeline o={o} sym={sym} now={now} />}
      {o.hasTerms && !o.custom && (
        <PlayNote
          p={o.params}
          cash={sym}
          schedule={sched}
          start={startPath}
          title={finished ? 'Play it again: what if prices had moved differently?' : 'Play the note'}
        />
      )}

      {/* (c) details */}
      <section className="card details" aria-labelledby="details-h">
        <h2 id="details-h">Details</h2>
        <div className="seg tabs" role="tablist" aria-label="Details">
          {(
            [
              ['terms', 'Full terms'],
              ...(o.economics && !econUrgent ? [['money', 'Collateral & payments']] : []),
              ['holders', 'Holders'],
              ['flow', 'How it runs'],
              ['contract', 'Contract'],
            ] as Array<[Tab, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={tab === k}
              className={tab === k ? 'active' : ''}
              onClick={() => setTab(k)}
              data-tab={k}
            >
              {label}
            </button>
          ))}
        </div>
        <TabPanel on={tab === 'terms'}>
          {o.hasTerms && <FullTerms o={o} cash={sym} open={!narrow} />}
          {!o.custom && (
            <div className="stack gap-6">
              <h3>Payout per 100 at the end</h3>
              <div className="payoff-box">
                <PayoffChart params={o.params} />
              </div>
              <p className="xs muted">
                Against the final {o.unds.length > 1 ? 'weakest level' : 'level'}, % of the starting price, if the note
                did not end early. Dashed lines:{' '}
                {linesOf(o.params)
                  .map((l) => l.label)
                  .join(', ')}
                .
              </p>
            </div>
          )}
        </TabPanel>
        {o.economics && !econUrgent && def && (
          <TabPanel on={tab === 'money'}>
            <EconomicsPanel
              e={o.economics}
              state={s}
              def={def}
              issuer={o.issuer}
              sym={sym}
              now={now}
              onDone={refresh}
            />
          </TabPanel>
        )}
        <TabPanel on={tab === 'holders'}>
          {def && <HoldersPanel state={s} def={def} explorer={explorer} issuer={o.issuer} />}
        </TabPanel>
        <TabPanel on={tab === 'flow'}>
          {xml && def && <NoteFlow xml={xml} def={def} state={s} view={o} sym={sym} explorer={explorer} />}
        </TabPanel>
        <TabPanel on={tab === 'contract'}>
          <div className="stack">
            {o.unds.length > 0 && (
              <ul className="und-list">
                {o.unds.map((u) => {
                  const last = u.observed[u.observed.length - 1];
                  return (
                    <li key={u.symbol}>
                      <span className="row gap-6">
                        <AssetIcon sym={u.symbol} size={18} />
                        <b>{u.symbol}/USD</b>
                        <span className="xs dim" title={`Price feed on ${u.feedChain}: ${u.feed}`}>
                          {feedSourceLabel(u)}
                        </span>
                      </span>
                      <span className="num small">
                        start {u.strike === null ? '—' : fmtPrice(u.strike)} · last{' '}
                        {last === undefined ? '—' : fmtPrice(last)}
                        {last !== undefined && u.strike !== null ? ` (${fmtPct(last / u.strike)})` : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="adv-body small contract">
              <Row k="Network">{chain?.cfg.name ?? s.chain}</Row>
              <Row k="Phase on-chain">{PHASE_LABEL[o.phase]}</Row>
              {noteToken && (
                <Row k="Note token (ERC-20)">
                  <Addr value={noteToken} href={explorer ? `${explorer}/token/${noteToken}` : undefined} />
                </Row>
              )}
              <Row k={`Engine${legacy ? ` (v${chain?.version}, earlier)` : ''} · note #`}>
                <Addr value={s.engine} href={explorer ? `${explorer}/address/${s.engine}` : undefined} /> · #{s.pid}
              </Row>
              <Row k="Workflow definition">
                <Addr value={s.definition} />
              </Row>
              <Row k="Issuer">
                <Addr value={o.issuer} href={explorer ? `${explorer}/address/${o.issuer}` : undefined} />
              </Row>
              <Row k="Note units held">
                <span className="num">
                  {fmtMoney(
                    s.holdings
                      .filter((h) => h.asset === NOTE_ASSET)
                      .reduce((a, h) => a + Number(BigInt(h.balance)) / Number(SCALE), 0),
                    0,
                  )}
                </span>
              </Row>
            </div>
            {o.custom && def && (
              <table className="t">
                <thead>
                  <tr>
                    <th>Workflow field</th>
                    <th className="r">Value</th>
                  </tr>
                </thead>
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
            )}
          </div>
        </TabPanel>
      </section>
    </main>
  );
}

/** A tab's panel: mounted the first time it opens, then kept (hidden) so its state survives switching. */
function TabPanel({ on, children }: { on: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(on);
  useEffect(() => {
    if (on) setSeen(true);
  }, [on]);
  if (!seen && !on) return null;
  return (
    <div role="tabpanel" hidden={!on}>
      {children}
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="spread">
      <span className="muted">{k}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * The checks and payments, one row each (stacked as cards on a phone): when, the weakest level Chainlink saw, and
 * what it meant for holders (the payment's status from the note's economics).
 */
function Timeline({ o, sym, now }: { o: NoteView; sym: string; now: number }) {
  const periods = o.economics?.periods ?? [];
  const lines = linesOf(o.params);
  const rows: Array<{
    key: string;
    title: string;
    when: number;
    state: 'done' | 'now' | 'later' | 'skip';
    level?: string;
    note?: string;
    pay?: { text: string; tone: 'good' | 'risk' | 'muted' };
  }> = [
    {
      key: 'strike',
      title: 'Book closes, starting price fixed',
      when: o.strikeDate,
      state: o.strikeFixed ? 'done' : o.phase === 'fixing' || o.phase === 'book' ? 'now' : 'later',
      level: o.strikeFixed ? o.unds.map((u) => `${u.symbol} ${fmtPrice(u.strike!)}`).join(' · ') : undefined,
    },
    ...o.obsDates.map((t, k) => {
      const perf = o.perfs[k];
      const per = periods.find((x) => x.k === k + 1);
      const stopped = (o.phase === 'redeemed' || o.phase === 'defaulted') && perf === undefined;
      const above = perf === undefined ? undefined : [...lines].reverse().find((l) => perf * 100 >= l.pct);
      const pay: { text: string; tone: 'good' | 'risk' | 'muted' } | undefined = per
        ? per.status === 'paid'
          ? { text: `Paid ${fmtMoney(per.perUnit ?? 0, 4)} ${sym} per unit`, tone: 'good' }
          : per.status === 'missed'
            ? { text: 'Not paid by the issuer: holders paid from the collateral', tone: 'risk' }
            : per.status === 'grace' || per.status === 'due'
              ? { text: `${fmtMoney(per.perUnit ?? 0, 4)} ${sym} per unit due`, tone: 'muted' }
              : per.status === 'nothing-due'
                ? { text: 'No payment this time', tone: 'muted' }
                : per.status === 'cancelled'
                  ? undefined
                  : per.perUnit
                    ? { text: `${fmtMoney(per.perUnit, 4)} ${sym} per unit expected`, tone: 'muted' }
                    : undefined
        : undefined;
      return {
        key: `o${k}`,
        title: k === o.obsDates.length - 1 ? `Check ${k + 1} · the end` : `Check ${k + 1}`,
        when: t,
        state: (perf !== undefined
          ? 'done'
          : stopped
            ? 'skip'
            : o.phase === 'live' && k === o.perfs.length
              ? 'now'
              : 'later') as 'done' | 'now' | 'later' | 'skip',
        level:
          perf !== undefined
            ? `${o.unds.length > 1 ? 'Weakest ' : ''}${fmtPct(perf)}${above ? `, above the ${above.label}` : lines.length ? `, below the ${lines[0].label}` : ''}`
            : undefined,
        note: stopped
          ? o.phase === 'defaulted'
            ? 'Not reached: the note ended at the default'
            : o.outcome?.calledAt
              ? `Not needed: repaid early at check ${o.outcome.calledAt}`
              : 'Not observed'
          : perf === undefined && o.phase === 'live' && k === o.perfs.length
            ? now >= t
              ? `Due: waiting for ${o.params.underlyings?.some((u) => isAtlasFeed(u.feed)) ? 'Atlas and CoinMarketCap to agree' : 'Chainlink'}`
              : `In ${countdown(t, now)}`
            : undefined,
        pay,
      };
    }),
  ];
  return (
    <section className="card tl2" aria-labelledby="tl-h">
      <div className="spread">
        <h2 id="tl-h">Checks and payments</h2>
        <span className="xs muted">
          {o.params.underlyings?.some((u) => isAtlasFeed(u.feed))
            ? 'Prices from Atlas, confirmed by CoinMarketCap'
            : 'Prices checked by Chainlink'}{' '}
          · times in your time zone
        </span>
      </div>
      <ol className="tl2-list">
        {rows.map((r) => (
          <li key={r.key} className={`tl2-row ${r.state}`}>
            <span className="tl2-dot" aria-hidden="true" />
            <div className="tl2-when">
              <b>{r.title}</b>
              <span className="xs muted">
                <When t={r.when} />
              </span>
            </div>
            <div className="tl2-what small">
              {r.level && <span>{r.level}</span>}
              {r.note && <span className="muted">{r.note}</span>}
              {r.pay && <span className={`tl2-pay ${r.pay.tone}`}>{r.pay.text}</span>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

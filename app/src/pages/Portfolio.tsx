/**
 * The portfolio, by category: wallet assets on each chain, notes you subscribed to, notes you issued, collateral
 * and receipts, what you can claim now (read from the chain: coupons and redemptions accrue in the note until you
 * claim them, one transaction per note, or Claim all), and the payouts already paid to your wallet with their
 * receipt ids (each claim logs one). Issuers withdraw their proceeds here too. Every note row opens that note.
 * `?address=0x…` shows any wallet read-only (no actions), e.g. to look at a demo investor.
 */
import { cashSymbol } from '../lib/chains';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isAddress } from 'viem';
import { BadgeCheck, Coins, FileText, Landmark, Lock, RefreshCw, Wallet } from 'lucide-react';
import { CASH_ASSET, type NoteView } from '@sn/sdk';
import { entryFor, useAddress, useChains, useSigner } from '../lib/chains';
import { errText, fmtMoney, fmtPct, nextEvent } from '../lib/format';
import { useNotes, usePortfolio } from '../lib/live';
import { useClaimable, useWalletBalances } from '../lib/balances';
import { RedeemOnAssetChain } from '../components/CrossChainCollateral';
import { Asset, AssetStack } from '../components/AssetIcon';
import { StatePill, currentState } from '../components/NoteState';
import { Addr } from '../components/ui';

type Tab = 'wallet' | 'subscribed' | 'issued' | 'collateral' | 'paid' | 'claim';

const symsOf = (o: NoteView) =>
  o.unds.length ? o.unds.map((u) => u.symbol) : o.params.underlyings.map((u) => u.symbol);

export default function Portfolio() {
  const connected = useAddress();
  const [params] = useSearchParams();
  const override = params.get('address');
  const address = override && isAddress(override) ? override.toLowerCase() : connected;
  const readOnly = !!address && address !== connected;
  const nav = useNavigate();
  const { byKey } = useChains();
  const signer = useSigner();
  const { positions, payouts, refresh } = usePortfolio(address ?? undefined);
  const { notes } = useNotes({ status: 'all' });
  const { data: wallet, refresh: refreshWallet } = useWalletBalances(address);
  const [tab, setTab] = useState<Tab>('subscribed');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; tx?: string; explorer?: string } | null>(null);

  const subscribed = useMemo(
    () => (positions ?? []).filter((p) => p.position.units > 0 && p.view.issuer.toLowerCase() !== address),
    [positions, address],
  );
  const issued = useMemo(() => (notes ?? []).filter((n) => n.view.issuer.toLowerCase() === address), [notes, address]);
  // What can be claimed now, from the chain: payouts accrue in the note until the holder claims them (and an
  // issuer's raised cash waits to be withdrawn). The read model's figure is the fallback while it loads.
  const [claimTick, setClaimTick] = useState(0);
  const claim = useClaimable(address, positions ?? [], CASH_ASSET, claimTick);
  const cashOf = (p: { id: string; position: { cash: number } }) => {
    const c = claim.get(p.id);
    return c === undefined ? p.position.cash : Number(c) / 1e10;
  };
  const withdrawable = useMemo(
    () =>
      (positions ?? []).filter(
        (p) => cashOf(p) > 1e-9 || p.position.holdings.some((h) => h.asset > CASH_ASSET && BigInt(h.balance) > 0n),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positions, claim],
  );
  const noteName = (id: string) =>
    (positions ?? []).find((p) => p.id === id)?.view.name ?? (notes ?? []).find((n) => n.id === id)?.view.name ?? id;
  const due = issued.filter(
    (n) =>
      currentState(n.view).key === 'due' ||
      currentState(n.view).key === 'grace' ||
      currentState(n.view).key === 'margin',
  );

  if (!address) {
    return (
      <main className="page">
        <div className="empty">
          <strong>Connect a wallet to see your portfolio.</strong>
          <span className="small">
            Your assets on Robinhood Chain, the notes you hold or issued, and what you can claim.
          </span>
          <Link to="/" className="btn">
            Browse notes
          </Link>
        </div>
      </main>
    );
  }

  const open = (id: string) => nav(`/note/${encodeURIComponent(id)}`);
  // Notes on an earlier engine (none today): shown and settled as before, labelled so the different mechanics are clear.
  const earlier = (id: string) => (
    <>
      {entryFor(byKey, { id })?.legacy && (
        <span title="On an earlier engine: payouts wait in the note until you claim them (no receipt); units are not an ERC-20.">
          {' '}
          · earlier engine
        </span>
      )}
    </>
  );
  const rowProps = (id: string, name: string) => ({
    className: 'link',
    tabIndex: 0,
    role: 'link',
    'aria-label': `Open ${name}`,
    onClick: () => open(id),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(id);
      }
    },
  });

  const isIssuerOf = (p: { view: NoteView }) => p.view.issuer.toLowerCase() === address;
  /**
   * A holder claims its payouts (pushTo for itself: one transaction, a receipt, its own gas); an issuer withdraws
   * the proceeds it raised (not a payout). Returns false when it failed.
   */
  const claimOne = async (p: { id: string; chain: string; view: NoteView }, cash: number, quiet = false) => {
    const e = entryFor(byKey, { chain: p.chain, id: p.id }); // the note's own engine: v3 notes settle on the v3 engine
    if (!e) throw new Error('This app does not serve the engine this note runs on.');
    const w = await signer(p.chain);
    const sym = cashSymbol(e.cfg, p.view.cashToken);
    if (isIssuerOf(p)) {
      const r = await e.adapter.withdraw(w, p.id, CASH_ASSET);
      if (!quiet)
        setMsg({
          kind: 'ok',
          text: `Withdrew ${fmtMoney(cash)} ${sym} of proceeds from ${p.view.name}.`,
          tx: r.tx[r.tx.length - 1],
          explorer: e.cfg.explorer,
        });
      return r.tx[r.tx.length - 1];
    }
    const r = await e.adapter.claimPayouts(w, p.id, CASH_ASSET);
    if (r.deferred)
      throw new Error(
        `${sym} refused the transfer to your wallet: what ${p.view.name} owes you stays claimable. Try again later.`,
      );
    if (!quiet)
      setMsg({
        kind: 'ok',
        text: `Claimed ${fmtMoney(cash)} ${sym} from ${p.view.name}${r.payoutIds.length ? ': receipt in Paid to your wallet' : ''}.`,
        tx: r.tx[r.tx.length - 1],
        explorer: e.cfg.explorer,
      });
    return r.tx[r.tx.length - 1];
  };
  const claim1 = async (p: { id: string; chain: string; view: NoteView }, cash: number) => {
    setBusy(p.id);
    setMsg(null);
    try {
      await claimOne(p, cash);
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) });
    } finally {
      setBusy('');
      refresh();
      refreshWallet();
      setClaimTick((t) => t + 1);
    }
  };
  /** Claim all: one claim per note in turn (each its own transaction to confirm), stopping at the first failure. */
  const claimAll = async (rows: Array<{ id: string; chain: string; view: NoteView; position: { cash: number } }>) => {
    setBusy('all');
    setMsg(null);
    let done = 0;
    try {
      for (const p of rows) {
        setMsg({ kind: 'ok', text: `Claiming ${done + 1} of ${rows.length}: ${p.view.name}. Confirm in your wallet…` });
        await claimOne(p, cashOf(p), true);
        done++;
      }
      setMsg({
        kind: 'ok',
        text: `Claimed from ${done} note${done === 1 ? '' : 's'}. Receipts are in Paid to your wallet.`,
      });
    } catch (e) {
      setMsg({ kind: 'err', text: `${done ? `Claimed ${done} of ${rows.length}. ` : ''}${errText(e)}` });
    } finally {
      setBusy('');
      refresh();
      refreshWallet();
      setClaimTick((t) => t + 1);
    }
  };

  const tabs: Array<{ id: Tab; label: string; icon: ReactNode; n?: number; flag?: boolean }> = [
    { id: 'subscribed', label: 'Subscribed notes', icon: <FileText className="i" />, n: subscribed.length },
    { id: 'issued', label: 'Issued notes', icon: <Landmark className="i" />, n: issued.length, flag: due.length > 0 },
    { id: 'paid', label: 'Paid to your wallet', icon: <BadgeCheck className="i" />, n: payouts?.length },
    {
      id: 'claim',
      label: 'Claimable',
      icon: <Coins className="i" />,
      n: withdrawable.length,
      flag: withdrawable.length > 0,
    },
    { id: 'collateral', label: 'Collateral & receipts', icon: <Lock className="i" /> },
    { id: 'wallet', label: 'Wallet assets', icon: <Wallet className="i" /> },
  ];

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <p>
            {readOnly ? (
              <>
                Viewing <Addr value={address} /> read-only.
              </>
            ) : (
              'Your notes, your assets on each chain, and what you can claim.'
            )}
          </p>
        </div>
        <button
          className="btn"
          onClick={() => {
            refresh();
            refreshWallet();
            setClaimTick((t) => t + 1);
          }}
        >
          <RefreshCw className="i" />
          Refresh
        </button>
      </div>
      {msg && (
        <div className={`notice ${msg.kind}`} role="status">
          {msg.text}{' '}
          {msg.tx && msg.explorer && (
            <a href={`${msg.explorer}/tx/${msg.tx}`} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
        </div>
      )}
      {due.length > 0 && !readOnly && (
        <div className="notice warn" role="status">
          {due.length === 1 ? 'One of your notes needs' : `${due.length} of your notes need`} funding:{' '}
          <button className="linkish" onClick={() => setTab('issued')}>
            see Issued notes
          </button>
          .
        </div>
      )}

      <nav className="seg pf-tabs" aria-label="Portfolio sections" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            {t.label}
            {t.n !== undefined && <span className="num dim">{t.n}</span>}
            {t.flag && <span className="pf-flag" aria-label="needs attention" />}
          </button>
        ))}
      </nav>

      {tab === 'subscribed' &&
        (positions === undefined ? (
          <p className="muted">Loading…</p>
        ) : subscribed.length === 0 ? (
          <Empty
            title="You haven't subscribed to a note yet."
            body="Buy units in an open note: you pay USDG and receive units in one transaction."
            cta={
              <Link to="/" className="btn primary">
                See open notes
              </Link>
            }
          />
        ) : (
          <div className="card scroll-x p-0">
            <table className="t">
              <thead>
                <tr>
                  <th>Note</th>
                  <th>Underlying</th>
                  <th>State</th>
                  <th className="r">Units</th>
                  <th className="r">Paid so far</th>
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {subscribed.map((p) => {
                  const sym = cashSymbol(byKey[p.chain]?.cfg, p.view.cashToken);
                  const paid = p.view.outcome ? p.view.outcome.perUnit * p.position.units : null;
                  return (
                    <tr key={p.id} {...rowProps(p.id, p.view.name)} data-note={p.id}>
                      <td>
                        <strong>{p.view.name}</strong>
                        <div className="xs muted">
                          {byKey[p.chain]?.cfg.name ?? p.chain}
                          {earlier(p.id)}
                        </div>
                      </td>
                      <td>
                        <AssetStack syms={symsOf(p.view)} />
                      </td>
                      <td>
                        <StatePill o={p.view} />
                      </td>
                      <td className="r num">{fmtMoney(p.position.units, 0)}</td>
                      <td className="r num">{paid === null ? '—' : `${fmtMoney(paid)} ${sym}`}</td>
                      <td className="small muted">{nextEvent(p.view)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'issued' &&
        (notes === undefined ? (
          <p className="muted">Loading…</p>
        ) : issued.length === 0 ? (
          <Empty
            title="You haven't issued a note yet."
            body="Pick a product, set the terms and pledge collateral: investors' USDG comes to you as funding."
            cta={
              <Link to="/issue" className="btn primary">
                Issue a note
              </Link>
            }
          />
        ) : (
          <div className="card scroll-x p-0">
            <table className="t">
              <thead>
                <tr>
                  <th>Note</th>
                  <th>State</th>
                  <th className="minw-130">Sold</th>
                  <th>Collateral</th>
                  <th className="r">Coverage</th>
                  <th>Next payment</th>
                </tr>
              </thead>
              <tbody>
                {issued.map(({ id, view: o }) => {
                  const st = currentState(o);
                  const call = o.economics?.nextCall;
                  const pct = o.notional ? Math.min(100, (o.sold / o.notional) * 100) : 0;
                  return (
                    <tr key={id} {...rowProps(id, o.name)} data-note={id}>
                      <td>
                        <strong>{o.name}</strong>
                        <div className="xs muted">
                          {byKey[o.chain]?.cfg.name ?? o.chain}
                          {earlier(id)}
                        </div>
                      </td>
                      <td>
                        <StatePill o={o} />
                      </td>
                      <td>
                        <div className="bar">
                          <span style={{ width: `${pct}%` }} />
                        </div>
                        <div className="xs muted num mt-3">
                          {fmtMoney(o.sold, 0)} of {fmtMoney(o.notional, 0)}
                        </div>
                      </td>
                      <td>
                        {o.economics?.collateral.length ? (
                          <span className="coll-line justify-start">
                            {o.economics.collateral.map((c) => (
                              <Asset
                                key={c.asset}
                                sym={c.symbol === 'USD' ? cashSymbol(byKey[o.chain]?.cfg, o.cashToken) : c.symbol}
                                size={16}
                              />
                            ))}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="r num">
                        {o.economics?.coveragePct != null ? fmtPct(o.economics.coveragePct) : '—'}
                      </td>
                      <td className="small">
                        {call && !call.funded && (st.key === 'due' || st.key === 'grace') ? (
                          <Link
                            to={`/note/${encodeURIComponent(id)}`}
                            className="btn primary sm"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Fund {fmtMoney(call.total)}
                          </Link>
                        ) : (
                          <span className="muted">{nextEvent(o)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'paid' &&
        (payouts === undefined ? (
          <p className="muted">Loading…</p>
        ) : payouts.length === 0 ? (
          <Empty
            title="No payouts yet."
            body="Each claim of a coupon or redemption shows here, with a receipt id you can check on-chain. Payouts wait in the note until you claim them under Claimable."
          />
        ) : (
          <div className="card scroll-x p-0" data-paid>
            <table className="t">
              <thead>
                <tr>
                  <th>Note</th>
                  <th className="r">Payment</th>
                  <th className="r">Amount</th>
                  <th>Receipt (payout id)</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => {
                  const chainKey = p.noteId.split(':')[0];
                  const cfg = byKey[chainKey]?.cfg;
                  const pos = (positions ?? []).find((x) => x.id === p.noteId);
                  const cashAsset = p.asset === CASH_ASSET;
                  const sym = cashAsset ? cashSymbol(cfg, pos?.view.cashToken) : `asset ${p.asset}`;
                  const amount = cashAsset
                    ? Number(BigInt(p.amount)) / 10 ** (cfg?.stablecoin.decimals ?? 6)
                    : Number(p.amount);
                  return (
                    <tr key={p.payoutId} {...rowProps(p.noteId, noteName(p.noteId))} data-payout={p.payoutId}>
                      <td>
                        <strong>{noteName(p.noteId)}</strong>
                        <div className="xs muted">{cfg?.name ?? chainKey}</div>
                      </td>
                      <td className="r num">#{p.period}</td>
                      <td className="r num">
                        <span className="asset justify-end">
                          <span className="num">{cashAsset ? fmtMoney(amount) : amount}</span>
                          {cashAsset && <Asset sym={sym} size={16} />}
                        </span>
                      </td>
                      <td className="small num">
                        {cfg?.explorer ? (
                          <a
                            href={`${cfg.explorer}/tx/${p.tx}`}
                            target="_blank"
                            rel="noreferrer"
                            title={`payoutId ${p.payoutId}: keccak256(chainid, engine, note, asset, period, holder, amount)`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {p.payoutId.slice(0, 10)}…{p.payoutId.slice(-6)}
                          </a>
                        ) : (
                          <span title={p.payoutId}>
                            {p.payoutId.slice(0, 10)}…{p.payoutId.slice(-6)}
                          </span>
                        )}
                      </td>
                      <td className="small muted">{new Date(p.at * 1000).toLocaleDateString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'claim' &&
        (positions === undefined ? (
          <p className="muted">Loading…</p>
        ) : withdrawable.length === 0 ? (
          <Empty
            title="Nothing to claim right now."
            body="Coupons and redemptions wait in the note until you claim them: they show here when a payment has been made. Delivered stock, and (for issuers) the USDG you raised, show here too."
          />
        ) : (
          (() => {
            const claimRows = withdrawable.filter(
              (p) => cashOf(p) > 1e-6 && !isIssuerOf(p) && entryFor(byKey, { chain: p.chain, id: p.id }),
            );
            return (
              <div className="stack">
                <div className="spread">
                  <p className="small muted m-0">
                    Coupons and redemptions accrue in each note until you claim them. One claim collects everything a
                    note owes you so far, with a receipt; you pay the network fee.
                  </p>
                  {!readOnly && claimRows.length > 1 && (
                    <button
                      className="btn primary sm"
                      disabled={!!busy}
                      onClick={() => claimAll(claimRows)}
                      data-claim-all
                    >
                      {busy === 'all' ? 'Claiming…' : `Claim all (${claimRows.length} notes)`}
                    </button>
                  )}
                </div>
                <div className="card scroll-x p-0">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Note</th>
                        <th className="r">Claimable</th>
                        <th>Tokens</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {withdrawable.map((p) => {
                        const sym = cashSymbol(byKey[p.chain]?.cfg, p.view.cashToken);
                        const tokens = p.position.holdings.filter(
                          (h) => h.asset > CASH_ASSET && BigInt(h.balance) > 0n,
                        );
                        const cash = cashOf(p);
                        const issuer = isIssuerOf(p);
                        return (
                          <tr key={p.id} {...rowProps(p.id, p.view.name)} data-note={p.id}>
                            <td>
                              <strong>{p.view.name}</strong>
                              <div className="xs muted">
                                {issuer ? 'Raised as issuer' : 'Paid to you, waiting to be claimed'}
                                {earlier(p.id)}
                              </div>
                            </td>
                            <td className="r num" data-cash>
                              <span className="asset justify-end">
                                <span className="num">{fmtMoney(cash)}</span>
                                <Asset sym={sym} size={16} />
                              </span>
                            </td>
                            <td className="small">
                              {tokens.length ? (
                                <span className="muted">
                                  {tokens.length} token{tokens.length > 1 ? 's' : ''}: withdraw on the note page
                                </span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td className="r">
                              <button
                                className="btn primary sm"
                                disabled={
                                  readOnly || !(cash > 1e-6) || !!busy || !entryFor(byKey, { chain: p.chain, id: p.id })
                                }
                                data-claim={issuer ? undefined : p.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  claim1(p, cash);
                                }}
                              >
                                {busy === p.id
                                  ? issuer
                                    ? 'Withdrawing…'
                                    : 'Claiming…'
                                  : `${issuer ? 'Withdraw' : 'Claim'} ${fmtMoney(cash)} ${sym}`}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()
        ))}

      {tab === 'collateral' && (
        <div className="stack">
          {!readOnly && <RedeemOnAssetChain />}
          {issued.some((n) => n.view.economics?.collateral.length) ? (
            <div className="card scroll-x p-0">
              <table className="t">
                <thead>
                  <tr>
                    <th>Note</th>
                    <th>Collateral locked</th>
                    <th>Held on</th>
                    <th className="r">Value counted</th>
                  </tr>
                </thead>
                <tbody>
                  {issued.flatMap(({ id, view: o }) =>
                    (o.economics?.collateral ?? []).map((c) => (
                      <tr key={`${id}:${c.asset}`} {...rowProps(id, o.name)}>
                        <td>
                          <strong>{o.name}</strong>
                        </td>
                        <td>
                          <span className="asset">
                            <span className="num">{fmtMoney(c.amount, c.amount < 1 ? 6 : 2)}</span>
                            <Asset
                              sym={c.symbol === 'USD' ? cashSymbol(byKey[o.chain]?.cfg, o.cashToken) : c.symbol}
                              size={16}
                            />
                          </span>
                        </td>
                        <td className="small">
                          {/\.[a-z]+$/.test(c.symbol)
                            ? 'Another chain (via Chainlink CCIP)'
                            : (byKey[o.chain]?.cfg.name ?? o.chain)}
                        </td>
                        <td className="r num">{c.value == null ? '—' : fmtMoney(c.value)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No collateral locked."
              body="Issuers lock collateral in the note when they issue, on Robinhood Chain: USDG, WETH or Robinhood's stock tokens. Collateral a note pays you after a default can be claimed from the note; it shows here."
            />
          )}
        </div>
      )}

      {tab === 'wallet' &&
        (wallet === null ? (
          <p className="muted">Reading balances on each chain…</p>
        ) : (
          <div className="pf-chains">
            {wallet.map((c) => (
              <section key={c.key} className="card">
                <h3>{c.name}</h3>
                {c.error ? (
                  <p className="small muted">Couldn't read this chain: {c.error}</p>
                ) : (
                  <ul className="pf-bal">
                    {c.balances.map((b) => (
                      <li key={b.sym}>
                        <Asset sym={b.sym} size={20} />
                        <span className="xs muted">
                          {b.kind === 'gas'
                            ? 'gas'
                            : b.kind === 'cash'
                              ? 'cash'
                              : b.kind === 'receipt'
                                ? 'receipt'
                                : b.kind === 'legacy'
                                  ? "older notes' dollar"
                                  : b.kind === 'stock'
                                    ? 'stock token'
                                    : ''}
                        </span>
                        <span className="num r">
                          {fmtMoney(b.amount, b.amount !== 0 && Math.abs(b.amount) < 1 ? 6 : 2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        ))}
    </main>
  );
}

function Empty({ title, body, cta }: { title: string; body: string; cta?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <span className="small">{body}</span>
      {cta}
    </div>
  );
}

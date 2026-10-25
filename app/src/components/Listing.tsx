/**
 * A note as an investor sees it first: the yield as an annual rate (honest about conditions), the assets, the
 * term, when you get your money back, early repayment, the collateral behind it, the price per unit and what's
 * left. Used by the marketplace and at the top of a note page. Technical terms live in <FullTerms>.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock, Clock, Coins, HandCoins, LifeBuoy, ShieldCheck, Undo2 } from 'lucide-react';
import { payoutMethodOf, PRODUCT_LABELS } from '@sn/core';
import type { NoteView } from '@sn/sdk';
import { fmtMoney } from '../lib/format';
import { inTime, listingOf, PAYOUT_TEXT, SIMPLE_STATUS_LABEL, simpleStatus } from '../lib/listing';
import { AssetStack } from './AssetIcon';

const symsOf = (o: NoteView) =>
  o.unds.length ? o.unds.map((u) => u.symbol) : o.params.underlyings.map((u) => u.symbol);

export function collateralPhrase(o: NoteView, cash: string): string | null {
  const ratio =
    o.economics?.ratio ?? (o.params.collateralRatioPct !== undefined ? o.params.collateralRatioPct / 100 : null);
  if (ratio == null) return null;
  const lines = o.economics?.collateral.length
    ? o.economics.collateral.map((c) => c.symbol)
    : (o.params.collateral ?? []).map((c) => c.symbol);
  const remote = lines.some((s) => /\.rh$/i.test(s)) || o.params.collateralChain === 'robinhood';
  const names = [...new Set(lines.map((s) => (s === 'USD' ? cash : s.replace(/\.rh$/i, ''))))];
  return `Backed by ${Math.round(ratio * 100)}% collateral${names.length ? ` (${names.join(' + ')}${remote ? ' on Robinhood Chain' : ''})` : ''}`;
}

export function StatusPill({ phase }: { phase: string }) {
  const s = simpleStatus(phase);
  return (
    <span className={`pill s-${s}`}>
      <span className="dot" />
      {SIMPLE_STATUS_LABEL[s]}
    </span>
  );
}

function Spec({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li>
      <span className="ls-ic" aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  );
}

/** The yield block: headline rate, how it's paid, and the condition when it isn't guaranteed. */
export function YieldBlock({ o, cash, big = false }: { o: NoteView; cash: string; big?: boolean }) {
  const l = listingOf(o.params, { strikeDate: o.strikeDate, obsDates: o.obsDates }, cash);
  return (
    <div className={`ls-yield ${big ? 'big' : ''}`}>
      <strong className="num">{l.yield.headline}</strong>
      {l.yield.rateLabel && <span className="ls-rate-label">{l.yield.rateLabel}</span>}
      <span className="small muted">{l.yield.sub}</span>
      {l.yield.qualifier && <span className="xs ls-cond">{l.yield.qualifier} · not guaranteed</span>}
    </div>
  );
}

/** The plain specs list. */
export function Specs({ o, cash, now }: { o: NoteView; cash: string; now: number }) {
  const l = listingOf(o.params, { strikeDate: o.strikeDate, obsDates: o.obsDates }, cash);
  const left = Math.max(0, o.notional - o.sold);
  const col = collateralPhrase(o, cash);
  return (
    <ul className="ls-specs">
      <Spec icon={<CalendarClock />}>{l.term}</Spec>
      {l.protection && <Spec icon={<LifeBuoy />}>{l.protection}</Spec>}
      {l.early && <Spec icon={<Undo2 />}>{l.early}</Spec>}
      {col && <Spec icon={<ShieldCheck />}>{col}</Spec>}
      {!o.custom && (
        <Spec icon={<HandCoins />}>
          <span data-payout-method={l.payout.method} title={l.payout.detail}>
            {l.payout.text}
          </span>
        </Spec>
      )}
      <Spec icon={<Coins />}>{`${fmtMoney(o.params.issuePricePct / 100)} ${cash} per unit`}</Spec>
      {o.phase === 'book' && (
        <Spec
          icon={<Clock />}
        >{`${fmtMoney(left, 0)} of ${fmtMoney(o.notional, 0)} units left${o.strikeDate ? ` · book closes ${inTime(o.strikeDate, now)}` : ''}`}</Spec>
      )}
    </ul>
  );
}

/** One marketplace listing: a row on wide screens, a card on phones; the whole thing opens the note. */
export function ListingRow({
  id,
  o,
  cash,
  now,
  earlier = false,
}: {
  id: string;
  o: NoteView;
  cash: string;
  now: number;
  earlier?: boolean;
}) {
  const l = listingOf(o.params, { strikeDate: o.strikeDate, obsDates: o.obsDates }, cash);
  const syms = symsOf(o);
  return (
    <Link
      to={`/note/${encodeURIComponent(id)}`}
      className="ls-row"
      data-note={id}
      aria-label={`${o.name}: ${l.yield.headline}`}
    >
      <div className="ls-head">
        <AssetStack syms={syms} size={26} label={false} />
        <div className="ls-assets">
          <strong>{l.assets}</strong>
          <span className="xs muted">{o.name}</span>
        </div>
      </div>
      <YieldBlock o={o} cash={cash} />
      <Specs o={o} cash={cash} now={now} />
      <div className="ls-side">
        <StatusPill phase={o.phase} />
        {earlier && (
          <span
            className="pill plain"
            data-earlier-engine
            title="Issued on an earlier engine: it runs to maturity there and takes no new subscriptions."
          >
            Earlier engine
          </span>
        )}
        <span className="ls-go">
          View <ArrowRight className="i" />
        </span>
      </div>
    </Link>
  );
}

/** Full terms with their technical names, each glossed in plain words. */
export function FullTerms({ o, cash }: { o: NoteView; cash: string }) {
  const p = o.params;
  const syms = symsOf(o);
  const rows: Array<[string, string, string]> = [
    ['Product', PRODUCT_LABELS[p.productType], 'The kind of note: how coupons and the final payment are worked out.'],
    [
      'Underlying',
      syms.length > 1 ? `Worst-of ${syms.join(', ')}` : (syms[0] ?? '—'),
      syms.length > 1
        ? 'Worst-of: every test uses whichever asset has done worst since the start.'
        : 'The asset whose price decides what you get.',
    ],
    [
      'Issue price',
      `${p.issuePricePct}% (${fmtMoney(p.issuePricePct / 100)} ${cash} per unit)`,
      'What one unit costs; each unit has 1 ' + cash + ' of face value.',
    ],
    ['Observations', String(p.observations), 'The dates Chainlink checks the price; the last one is maturity.'],
  ];
  if (p.couponRatePct)
    rows.push([
      'Coupon',
      `${p.couponRatePct}% per period`,
      p.productType === 'snowball'
        ? 'Builds up each period; paid when the note ends.'
        : 'Paid in ' + cash + ' on each observation date it is due.',
    ]);
  if (p.couponBarrierPct)
    rows.push([
      'Coupon barrier',
      `${p.couponBarrierPct}% of strike${p.memory ? ', with memory' : ''}`,
      `A coupon is paid only if the price is at or above this level.${p.memory ? ' Memory: missed coupons are paid later if the price recovers.' : ''}`,
    ]);
  if (p.autocallLevelPct)
    rows.push([
      'Autocall',
      `${p.autocallLevelPct}% of strike, from observation ${p.autocallFromPeriod ?? 1}`,
      'If the price is at or above this level on a date, the note ends early and you get your money back.',
    ]);
  if (p.knockInBarrierPct)
    rows.push([
      'Knock-in barrier',
      `${p.knockInBarrierPct}% of strike`,
      `If the price ends below this, you get back only what it is worth${p.settlement === 'physical' ? ', paid in the stock or token itself' : ''}.`,
    ]);
  if (p.protectionPct)
    rows.push([
      'Protection',
      `${p.protectionPct}%`,
      'The share of your money you get back at the end whatever happens.',
    ]);
  if (p.participationPct)
    rows.push(['Participation', `${p.participationPct}%`, 'Your share of any rise in the price.']);
  rows.push([
    'Settlement',
    p.settlement === 'physical' ? 'Physical' : 'Cash',
    p.settlement === 'physical'
      ? 'Below the knock-in, holders receive the asset itself.'
      : `Everything is paid in ${cash}.`,
  ]);
  const pay = PAYOUT_TEXT[payoutMethodOf(p)];
  rows.push(['Payouts', pay.text, pay.detail]);
  if (o.isin) rows.push(['Reference (ISIN)', o.isin, "The issuer's reference for this issuance."]);
  return (
    <details className="card adv full-terms">
      <summary>Full terms</summary>
      <dl className="ft">
        {rows.map(([k, v, g]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              <span className="num">{v}</span>
              <span className="xs muted">{g}</span>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

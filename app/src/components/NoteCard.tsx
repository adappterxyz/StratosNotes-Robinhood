/**
 * A note as a card: its plain name first (from its terms), the product type as a small tag, where it runs and in
 * which currency, one big rate, a few facts, the barrier bar with each underlying's latest level, and a countdown to
 * the next check while it runs. A finished note says calmly what holders got (a default reads "Paid from collateral"
 * with the amount, not an alarm). The issue builder shows the same card, from terms alone, as its live preview.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { isAtlasFeed, isNoteChain, NOTE_CHAIN_SHORT, type ProductParams } from '@sn/core';
import type { NoteView } from '@sn/sdk';
import { listingOf, type Schedule } from '../lib/listing';
import {
  CALM_LABEL,
  countdown,
  marksOf,
  nextCheck,
  plainName,
  productTag,
  statusOf,
  termShort,
  type Calm,
  type Mark,
} from '../lib/story';
import { AssetStack } from './AssetIcon';
import { BarrierBar } from './BarrierBar';
import { collateralPhrase } from './Listing';

/** The headline rate as one big number and the words around it. */
export function rateOf(p: ProductParams, cash: string, s: Schedule = {}) {
  const l = listingOf(p, s, cash);
  if (p.productType === 'ppn')
    return {
      big: `${p.protectionPct ?? 100}%`,
      sub: `back at the end, plus ${p.participationPct ?? 0}% of any rise`,
      cond: null,
      l,
    };
  const rate = l.yield.headline.replace(/^Up to /, '');
  return {
    big: rate,
    sub: `a year in ${cash}, ${l.yield.sub.replace(/^in \S+, /, '')}`,
    cond: l.yield.qualifier ? `${l.yield.qualifier}${l.yield.guaranteed ? '' : ', not guaranteed'}` : 'fixed',
    l,
  };
}

/** Three or four short facts: the term, the money-back line, early repayment, the collateral. */
export function factsOf(p: ProductParams, s: Schedule, extra: Array<ReactNode | null> = []): ReactNode[] {
  const l = listingOf(p, s);
  const out: ReactNode[] = [<b key="t">{termShort(p, s)}</b>];
  if (p.productType !== 'ppn' && p.knockInBarrierPct)
    out.push(
      <span key="k">
        Money back above <b>{p.knockInBarrierPct}%</b>
      </span>,
    );
  if (l.early) out.push(<span key="e">{l.early.replace(/ if above \d+%$/, '').replace(' date ', ' check ')}</span>);
  return [...out, ...extra.filter((x) => x !== null)];
}

const chainShort = (key: string, fallback?: string) => (isNoteChain(key) ? NOTE_CHAIN_SHORT[key] : (fallback ?? key));

function Live({ calm, next, now }: { calm: Calm; next: { label: string; at: number } | null; now: number }) {
  if (calm === 'open' || calm === 'running') {
    return (
      <span className={`nc-live${calm === 'open' ? ' open' : ''}`} data-countdown>
        {next ? (
          <>
            {next.label} in <b className="num">{countdown(next.at, now)}</b>
          </>
        ) : (
          CALM_LABEL[calm]
        )}
      </span>
    );
  }
  return <span className={`nc-done c-${calm}`}>{CALM_LABEL[calm]}</span>;
}

/** A marketplace card: the whole card opens the note. */
export function NoteCard({
  id,
  o,
  cash,
  now,
  chainKey,
  earlier = false,
}: {
  id: string;
  o: NoteView;
  cash: string;
  now: number;
  chainKey: string;
  earlier?: boolean;
}) {
  const s = { strikeDate: o.strikeDate, obsDates: o.obsDates };
  const r = rateOf(o.params, cash, s);
  const st = statusOf(o, cash);
  const marks = marksOf(o);
  const next = nextCheck(o, now);
  const syms = o.unds.length ? o.unds.map((u) => u.symbol) : o.params.underlyings.map((u) => u.symbol);
  const col = collateralPhrase(o, cash);
  const finished = st.key !== 'open' && st.key !== 'running';
  const name = o.hasTerms ? plainName(o.params) : o.name;
  return (
    <Link
      to={`/note/${encodeURIComponent(id)}`}
      className={`nc${finished ? ' finished' : ''}`}
      data-note={id}
      data-status={st.key}
      aria-label={`${name}: ${r.big} ${r.sub}`}
    >
      <div className="nc-top">
        <AssetStack syms={syms} size={30} label={false} />
        <div className="nc-title">
          <h3>{name}</h3>
          <div className="nc-tags">
            {o.hasTerms && <span className="tag">{productTag(o.params)}</span>}
            <span className="tag chain">
              <span data-note-chain>{chainShort(chainKey)}</span> · {cash}
            </span>
            {earlier && (
              <span
                className="tag"
                data-earlier-engine
                title="Issued on an earlier engine: it takes no new subscriptions."
              >
                Earlier engine
              </span>
            )}
          </div>
        </div>
        <Live calm={st.key} next={next} now={now} />
      </div>
      {o.hasTerms && (
        <div className="nc-mid">
          <div className="nc-rate">
            <strong className="num">{r.big}</strong>
            <span>{r.sub}</span>
            {r.cond && r.cond !== 'fixed' && <span className="nc-cond">{r.cond}</span>}
          </div>
          <ul className="nc-facts">
            {factsOf(o.params, s, [col ? <span key="c">{col.replace(/^Backed by /, '')}</span> : null]).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {o.hasTerms && (
        <BarrierBar
          p={o.params}
          marks={marks}
          past={finished}
          legend={false}
          note={
            o.phase === 'book' ? 'Lines are set against the starting price, fixed when the book closes.' : undefined
          }
        />
      )}
      {st.story && <p className="nc-story">{st.story}</p>}
      <div className="nc-foot">
        <span className="nc-feed">{feedLine(o, marks, now)}</span>
        <span className={`btn sm${st.key === 'open' && !earlier ? ' primary' : ''}`}>
          {st.key === 'open' && !earlier ? 'Buy units' : 'See the note'}
          <ArrowRight className="i" />
        </span>
      </div>
    </Link>
  );
}

function feedLine(o: NoteView, marks: Mark[], now: number) {
  const k = o.perfs.length;
  if (o.phase === 'book') {
    const left = Math.max(0, o.notional - o.sold);
    return `${Math.round(left).toLocaleString()} of ${Math.round(o.notional).toLocaleString()} units left`;
  }
  const src = o.params?.underlyings?.some((u) => isAtlasFeed(u.feed)) ? 'Atlas' : 'Chainlink';
  if (!k) return o.strikeFixed ? `Starting price fixed by ${src}` : 'Waiting for the starting price';
  const w = marks.find((m) => m.worst);
  const ago = Math.max(0, now - (o.obsDates[k - 1] ?? now));
  return `${src} checked ${k} of ${o.obsDates.length}${w ? ` · ${w.sym} ${w.pct.toFixed(1)}% of start` : ''}${ago < 86400 * 3 && o.phase === 'live' ? ` · ${agoText(ago)}` : ''}`;
}
function agoText(s: number) {
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** The issue builder's live preview: the card investors will see, from terms alone. */
export function PreviewCard({
  p,
  cash,
  chainKey,
  schedule,
  facts = [],
}: {
  p: ProductParams;
  cash: string;
  chainKey: string;
  schedule: Schedule;
  facts?: Array<ReactNode | null>;
}) {
  const r = rateOf(p, cash, schedule);
  return (
    <div className="nc preview" data-preview-card>
      <div className="nc-top">
        <AssetStack syms={p.underlyings.map((u) => u.symbol)} size={30} label={false} />
        <div className="nc-title">
          <h3>{plainName(p)}</h3>
          <div className="nc-tags">
            <span className="tag">{productTag(p)}</span>
            <span className="tag chain">
              {chainShort(chainKey)} · {cash}
            </span>
          </div>
        </div>
        <span className="nc-live open">Open</span>
      </div>
      <div className="nc-mid">
        <div className="nc-rate">
          <strong className="num">{r.big}</strong>
          <span>{r.sub}</span>
          {r.cond && r.cond !== 'fixed' && <span className="nc-cond">{r.cond}</span>}
        </div>
        <ul className="nc-facts">
          {factsOf(p, schedule, facts).map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      </div>
      <BarrierBar p={p} say={false} />
    </div>
  );
}

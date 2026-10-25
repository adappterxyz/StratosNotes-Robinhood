/**
 * "Start from a ready-made note": the built-in examples and the notes issuers saved, as the marketplace shows a
 * note (the annual rate, the assets, term, protection, collateral), with the marketplace's filters.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock, LifeBuoy, ShieldCheck, Undo2, Workflow } from 'lucide-react';
import { collateralTokenOf, economicsOf, isRemoteCollateral, NOTE_CHAIN_LABELS, noteChainOf } from '@sn/core';
import { listingOf } from '../../lib/listing';
import { BUILT_IN, libraryReadyMade, type ReadyMade } from '../../lib/readymade';
import { short } from '../../lib/format';
import { AssetStack } from '../AssetIcon';

const FIRST = 6;
type Filter = 'stocks' | 'crypto' | 'yield' | 'protect';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'stocks', label: 'Stocks' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'yield', label: 'Earn yield' },
  { id: 'protect', label: 'Protect capital' },
];

function collateralLine(r: ReadyMade) {
  const e = economicsOf(r.params);
  const names = [
    ...new Set(
      e.collateral.map((c) => (collateralTokenOf(r.params, c.symbol)?.token ?? c.symbol).replace(/\.[a-z]+$/, '')),
    ),
  ];
  const where = isRemoteCollateral(r.params)
    ? 'locked on another chain'
    : `on ${NOTE_CHAIN_LABELS[noteChainOf(r.params)]}`;
  return `Backed by ${e.collateralRatioPct}% collateral (${names.join(' + ')}, ${where})`;
}

function Card({ r, onPick }: { r: ReadyMade; onPick: (r: ReadyMade) => void }) {
  const l = listingOf(r.params);
  const inner = (
    <>
      <div className="ls-head">
        <AssetStack syms={r.params.underlyings.map((u) => u.symbol)} size={26} label={false} />
        <div className="ls-assets">
          <strong>{r.name}</strong>
          <span className="xs muted">{l.assets}</span>
        </div>
      </div>
      <div className="ls-yield">
        <strong className="num">{l.yield.headline}</strong>
        {l.yield.rateLabel && <span className="ls-rate-label">{l.yield.rateLabel}</span>}
        <span className="small muted">{l.yield.sub}</span>
        {l.yield.qualifier && <span className="xs ls-cond">{l.yield.qualifier} · not guaranteed</span>}
      </div>
      <ul className="ls-specs">
        <li>
          <span className="ls-ic" aria-hidden="true">
            <CalendarClock />
          </span>
          <span>{l.term}</span>
        </li>
        {l.protection && (
          <li>
            <span className="ls-ic" aria-hidden="true">
              <LifeBuoy />
            </span>
            <span>{l.protection}</span>
          </li>
        )}
        {l.early && (
          <li>
            <span className="ls-ic" aria-hidden="true">
              <Undo2 />
            </span>
            <span>{l.early}</span>
          </li>
        )}
        <li>
          <span className="ls-ic" aria-hidden="true">
            <ShieldCheck />
          </span>
          <span>{collateralLine(r)}</span>
        </li>
      </ul>
      {r.description && <p className="xs muted rm-desc">{r.description}</p>}
      <div className="rm-foot">
        <span className={`rm-by ${r.author ? '' : 'house'}`}>
          {r.author ? `by ${short(r.author)}` : 'notes.markets'}
        </span>
        {r.custom ? (
          <span className="ls-go">
            <Workflow className="i" />
            Customise the workflow
          </span>
        ) : (
          <span className="ls-go">
            Use this note
            <ArrowRight className="i" />
          </span>
        )}
      </div>
      {r.custom && (
        <p className="xs muted">
          A custom workflow: it adds steps beyond the standard payoff, so you set it up and issue it in the studio.
        </p>
      )}
    </>
  );
  return r.custom ? (
    <Link to={`/issue/advanced?template=${r.id}`} className="rm-card" data-ready={r.id}>
      {inner}
    </Link>
  ) : (
    <button type="button" className="rm-card" data-ready={r.id} onClick={() => onPick(r)}>
      {inner}
    </button>
  );
}

export default function ReadyMadeList({ onPick }: { onPick: (r: ReadyMade) => void }) {
  const [saved, setSaved] = useState<ReadyMade[] | null>(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    libraryReadyMade()
      .then((x) => live && setSaved(x))
      .catch((e) => {
        if (live) {
          setSaved([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...BUILT_IN, ...(saved ?? [])].filter((r) => {
      const l = listingOf(r.params);
      if (filters.has('yield') && l.goal !== 'yield') return false;
      if (filters.has('protect') && l.goal !== 'protect') return false; // capital back whatever happens, not only above a barrier
      if (filters.has('stocks') && l.kind === 'crypto') return false;
      if (filters.has('crypto') && l.kind === 'stocks') return false;
      if (
        needle &&
        ![
          r.name,
          r.description,
          l.assets,
          r.author ?? 'notes.markets',
          ...r.params.underlyings.map((u) => u.symbol),
        ].some((s) => s.toLowerCase().includes(needle))
      )
        return false;
      return true;
    });
  }, [saved, filters, q]);
  // A few at first, so the other ways in stay in view; filtering or searching shows every match.
  const open = all || filters.size > 0 || !!q.trim();
  const toggle = (f: Filter) =>
    setFilters((s) => {
      const n = new Set(s);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });

  return (
    <div className="stack gap-12">
      <div className="filters" role="group" aria-label="Filter ready-made notes">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`chip ${filters.has(f.id) ? 'on' : ''}`}
            aria-pressed={filters.has(f.id)}
            onClick={() => toggle(f.id)}
          >
            {f.label}
          </button>
        ))}
        <input
          type="search"
          aria-label="Search ready-made notes"
          placeholder="Search Tesla, ETH…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {error && (
        <div className="notice warn" role="status">
          Only the built-in notes are shown: {error}
        </div>
      )}
      {shown.length === 0 ? (
        <div className="empty">
          <strong>No ready-made notes match.</strong>
          <span className="small">Try fewer filters, or build your own below.</span>
        </div>
      ) : (
        <div className="rm-grid">
          {(open ? shown : shown.slice(0, FIRST)).map((r) => (
            <Card key={r.id} r={r} onPick={onPick} />
          ))}
        </div>
      )}
      {!open && shown.length > FIRST && (
        <button className="btn rm-more" onClick={() => setAll(true)}>
          Show all {shown.length} ready-made notes
        </button>
      )}
      {saved === null && <p className="xs muted">Loading the notes issuers saved…</p>}
    </div>
  );
}

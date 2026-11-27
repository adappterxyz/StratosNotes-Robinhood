/**
 * "Start from a ready-made note", on the chain picked first: the built-in examples and the notes issuers saved, each
 * as investors would see it (plain name, rate, the barrier bar), with its terms moved to that chain (toChain). A note
 * written for the other chain says what changes (a stock it cannot deliver there settles in cash; collateral it
 * cannot hold there is swapped). RecentList: the notes issued recently on that chain, to issue again.
 */
import { neverIssued } from '../../lib/listing';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Workflow } from 'lucide-react';
import { economicsOf, isNoteChain, NOTE_CHAIN_SHORT, noteChainOf, toChain, type ProductParams } from '@sn/core';
import { parseNoteId } from '@sn/sdk';
import type { NoteItem } from '../../lib/api';
import { useChains } from '../../lib/chains';
import { listingOf } from '../../lib/listing';
import { BUILT_IN, libraryReadyMade, recentReadyMade, type ReadyMade } from '../../lib/readymade';
import { plainName, productTag } from '../../lib/story';
import { fmtDate, short } from '../../lib/format';
import { AssetStack } from '../AssetIcon';
import { BarrierBar } from '../BarrierBar';
import { rateOf } from '../NoteCard';
import { cashOn } from './ChainPicker';

const FIRST = 6;
type Filter = 'stocks' | 'crypto' | 'yield' | 'protect';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'stocks', label: 'Stocks' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'yield', label: 'Income' },
  { id: 'protect', label: 'Protect capital' },
];

/** The terms on `chain`, and what had to change to get them there (empty when written for it). */
export function onChain(p: ProductParams, chain: string): { params: ProductParams; changes: string[] } {
  if (!isNoteChain(chain) || noteChainOf(p) === chain) return { params: p, changes: [] };
  const q = toChain(p, chain);
  const changes: string[] = [];
  if (p.settlement === 'physical' && q.settlement !== 'physical') changes.push('settles in cash');
  const a = economicsOf(p)
    .collateral.map((c) => c.symbol)
    .join();
  const b = economicsOf(q)
    .collateral.map((c) => c.symbol)
    .join();
  if (a !== b || p.collateralChain !== q.collateralChain) changes.push('different collateral');
  return { params: q, changes };
}

function Card({
  r,
  chain,
  onPick,
  recent = false,
}: {
  r: ReadyMade;
  chain: string;
  onPick: (r: ReadyMade) => void;
  recent?: boolean;
}) {
  const { config } = useChains();
  const cfg = config.chains.find((c) => c.key === chain);
  const cash = cfg ? cashOn(cfg) : 'USD';
  const { params, changes } = onChain(r.params, chain);
  const rate = rateOf(params, cash);
  const where = isNoteChain(chain) ? NOTE_CHAIN_SHORT[chain] : chain;
  const inner = (
    <>
      <div className="nc-top">
        <AssetStack syms={params.underlyings.map((u) => u.symbol)} size={28} label={false} />
        <div className="nc-title">
          <h3>{plainName(params)}</h3>
          <div className="nc-tags">
            <span className="tag">{productTag(params)}</span>
            <span className="tag">{listingOf(params).term}</span>
          </div>
        </div>
      </div>
      <div className="tpl-rate">
        <strong className="num">{rate.big}</strong>
        <span>{rate.sub}</span>
      </div>
      <BarrierBar p={params} say={false} legend={false} />
      {r.description && (
        <p className="tpl-desc" data-desc>
          {r.description}
        </p>
      )}
      {changes.length > 0 && (
        <p className="tpl-moved" data-moved>
          Written for {NOTE_CHAIN_SHORT[noteChainOf(r.params)]}: on {where} it {changes.join(' and ')}.
        </p>
      )}
      <div className="rm-foot">
        <span className={`rm-by ${r.author || r.issuedAt ? '' : 'house'}`}>
          {r.issuedAt ? `Issued ${fmtDate(r.issuedAt)}` : r.author ? `by ${short(r.author)}` : 'notes.markets'}
        </span>
        {r.custom ? (
          <span className="ls-go">
            <Workflow className="i" />
            See the workflow
          </span>
        ) : (
          <span className="ls-go">
            {r.issuedAt ? 'Issue again' : 'Use this note'}
            <ArrowRight className="i" />
          </span>
        )}
      </div>
    </>
  );
  return r.custom ? (
    <Link
      to={`/issue?custom=${r.id}`}
      className="nc tpl"
      data-ready={r.id}
      data-recent={recent || undefined}
      title={r.description}
    >
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      className="nc tpl"
      data-ready={r.id}
      data-recent={recent || undefined}
      title={r.description || undefined}
      onClick={() => onPick({ ...r, params })}
    >
      {inner}
    </button>
  );
}

/** The notes issued most recently on this chain's current engine: issue one again with a fresh schedule. */
export function RecentList({ chain, onPick }: { chain: string; onPick: (r: ReadyMade) => void }) {
  const { config } = useChains();
  const [recent, setRecent] = useState<Array<{ note: NoteItem; ready: ReadyMade }> | null>(null);
  const [error, setError] = useState('');
  const engines = config.chains
    .filter((c) => c.key === chain)
    .map((c) => `${c.key}:${c.engine.toLowerCase()}`)
    .join(',');
  useEffect(() => {
    if (!engines) {
      setRecent([]);
      return;
    }
    let live = true;
    setRecent(null);
    const current = new Set(engines.split(','));
    recentReadyMade((n) => {
      const id = parseNoteId(n.id);
      // A note that was started and never approved (a failed issue) is not something to issue again.
      return !!id && current.has(`${id.chain}:${id.engine.toLowerCase()}`) && !neverIssued(n.view);
    }, 3)
      .then((x) => live && setRecent(x))
      .catch((e) => {
        if (live) {
          setRecent([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      live = false;
    };
  }, [engines]);
  if (recent === null) return <p className="xs muted">Loading the notes issued recently…</p>;
  if (error)
    return (
      <div className="notice warn" role="status">
        {error}
      </div>
    );
  if (!recent.length) return null;
  return (
    <div className="stack gap-10">
      <h3 className="iw-sub">Issued recently here</h3>
      <div className="tpl-grid" data-recent-list>
        {recent.map(({ note, ready }) => (
          <Card key={note.id} r={ready} chain={chain} onPick={onPick} recent />
        ))}
      </div>
    </div>
  );
}

export default function ReadyMadeList({ chain, onPick }: { chain: string; onPick: (r: ReadyMade) => void }) {
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
    const list = [...BUILT_IN, ...(saved ?? [])].filter((r) => {
      const l = listingOf(r.params);
      if (filters.has('yield') && l.goal !== 'yield') return false;
      if (filters.has('protect') && l.goal !== 'protect') return false;
      if (filters.has('stocks') && l.kind === 'crypto') return false;
      if (filters.has('crypto') && l.kind === 'stocks') return false;
      if (
        needle &&
        ![
          r.name,
          r.description,
          plainName(r.params),
          l.assets,
          r.author ?? 'notes.markets',
          ...r.params.underlyings.map((u) => u.symbol),
        ].some((s) => s.toLowerCase().includes(needle))
      )
        return false;
      return true;
    });
    // Notes written for this chain first, then the ones that need nothing changed, then the rest.
    const rank = (r: ReadyMade) =>
      noteChainOf(r.params) === chain ? 0 : onChain(r.params, chain).changes.length ? 2 : 1;
    return list
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
      .map((x) => x.r);
  }, [saved, filters, q, chain]);
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
          <span className="small">Try fewer filters, or build your own.</span>
        </div>
      ) : (
        <div className="tpl-grid">
          {(open ? shown : shown.slice(0, FIRST)).map((r) => (
            <Card key={r.id} r={r} chain={chain} onPick={onPick} />
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

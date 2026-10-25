/**
 * The marketplace, for investors: each note as its yield (an annual rate, honest about conditions) and the few
 * things to know, with filters in plain words. Technical terms are on each note's page under "Full terms".
 */
import { cashSymbol } from '../lib/chains';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { engineOf, marketplaceNotes, useChains, PREFERRED_CHAIN } from '../lib/chains';
import { listingOf } from '../lib/listing';
import { useNotes, useNow } from '../lib/live';
import { ListingRow } from '../components/Listing';

type Filter = 'yield' | 'protect' | 'stocks' | 'crypto';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'yield', label: 'Earn yield' },
  { id: 'protect', label: 'Protect capital' },
  { id: 'stocks', label: 'Stocks' },
  { id: 'crypto', label: 'Crypto' },
];
type Sort = 'yield' | 'closing' | 'newest';

export default function Marketplace() {
  const { config } = useChains();
  const now = useNow(30_000);
  const [openOnly, setOpenOnly] = useState(true);
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [sort, setSort] = useState<Sort>('yield');
  const [q, setQ] = useState('');
  const { notes, error } = useNotes({ status: 'all', q: q.trim() || undefined });
  // Each note's own cash token (older demo notes settle in tUSD), falling back to the chain's stablecoin.
  const cashOf = (chain: string, token?: string) =>
    cashSymbol(
      config.chains.find((c) => c.key === chain),
      token,
    );
  // Notes on an earlier engine (v3) take no new subscriptions: never "open now", labelled when shown.
  const earlier = (id: string) => !!engineOf(config, id)?.legacy;

  const shown = useMemo(() => {
    // Notes issued on Robinhood Chain (a collateral chain only) are legacy: never listed, reachable by link.
    const items = marketplaceNotes(notes ?? [])
      .filter((n) => !openOnly || (n.view.phase === 'book' && !earlier(n.id)))
      .map((n) => ({
        n,
        l: listingOf(
          n.view.params,
          { strikeDate: n.view.strikeDate, obsDates: n.view.obsDates },
          cashOf(n.chain, n.view.cashToken),
        ),
      }))
      .filter(({ l }) => {
        if (filters.has('yield') && l.goal !== 'yield') return false;
        if (filters.has('protect') && l.goal !== 'protect' && !l.protection) return false;
        if (filters.has('stocks') && l.kind === 'crypto') return false;
        if (filters.has('crypto') && l.kind === 'stocks') return false;
        return true;
      });
    const by: Record<Sort, (a: (typeof items)[number], b: (typeof items)[number]) => number> = {
      yield: (a, b) => (b.l.yield.apr ?? -1) - (a.l.yield.apr ?? -1),
      closing: (a, b) =>
        (a.n.view.phase === 'book' ? a.n.view.strikeDate : Infinity) -
        (b.n.view.phase === 'book' ? b.n.view.strikeDate : Infinity),
      newest: (a, b) => b.n.view.createdAt - a.n.view.createdAt,
    };
    // Arbitrum first (where notes run) when otherwise equal.
    const rank = (k: string) => (k === PREFERRED_CHAIN ? 0 : 1);
    return items.sort((a, b) => by[sort](a, b) || rank(a.n.chain) - rank(b.n.chain)).map((x) => x.n);
  }, [notes, filters, sort, openOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (f: Filter) =>
    setFilters((s) => {
      const n = new Set(s);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Notes</h1>
          <p>
            Buy into a note with USDG. You know the terms before you buy; Chainlink checks the prices on each date and
            every payment is made on-chain.
          </p>
        </div>
        <Link to="/issue" className="btn primary lg">
          <Plus className="i" />
          Issue a note
        </Link>
      </div>

      <div className="filters" role="group" aria-label="Filters">
        <button
          className={`chip ${openOnly ? 'on' : ''}`}
          aria-pressed={openOnly}
          onClick={() => setOpenOnly((v) => !v)}
        >
          Open now
        </button>
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
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="yield">Highest yield</option>
          <option value="closing">Closing soon</option>
          <option value="newest">Newest</option>
        </select>
        <input
          type="search"
          aria-label="Search"
          placeholder="Search Tesla, ETH…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {error && (
        <div className="notice err" role="alert">
          Could not load notes: {error}
        </div>
      )}

      {notes === undefined ? (
        <p className="muted">Loading notes…</p>
      ) : shown.length === 0 ? (
        <div className="empty">
          <strong>{notes.length ? 'No notes match.' : 'No notes yet.'}</strong>
          <span className="small">
            {openOnly
              ? 'Only notes you can buy now are shown: turn off "Open now" to see running and finished ones.'
              : 'Try fewer filters.'}
          </span>
          <Link to="/issue" className="btn">
            Issue a note
          </Link>
        </div>
      ) : (
        <div className="ls-list">
          {shown.map(({ id, view, chain }) => (
            <ListingRow
              key={id}
              id={id}
              o={view}
              cash={cashOf(chain, view.cashToken)}
              now={now}
              earlier={earlier(id)}
            />
          ))}
        </div>
      )}
      <p className="xs muted mt-14">
        Rates are annualised from each note's terms. "Up to" rates depend on prices staying above a level and are not
        guaranteed. Testnet only.
      </p>
    </main>
  );
}

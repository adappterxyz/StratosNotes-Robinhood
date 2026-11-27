/**
 * The marketplace, for investors: every note as a card (its plain name, one big rate, a few facts and the barrier bar
 * with where its underlyings stand now), open ones first, then running, then finished. It never opens on an empty
 * screen: every note is shown by default, filters say how many they hide and clear in one click, and with no notes at
 * all you can still play an example note.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { EXAMPLE_WORST_OF, FEEDS } from '@sn/core';
import { cashSymbol, chainName, engineOf, issueChains, useChains } from '../lib/chains';
import { listingOf, neverIssued } from '../lib/listing';
import { useNotes, useNow } from '../lib/live';
import { statusOf } from '../lib/story';
import { NoteCard } from '../components/NoteCard';
import { PlayNote } from '../components/PlayNote';

type Filter = 'yield' | 'protect' | 'stocks' | 'crypto';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'yield', label: 'Income' },
  { id: 'protect', label: 'Protect capital' },
  { id: 'stocks', label: 'Stocks' },
  { id: 'crypto', label: 'Crypto' },
];
type Show = 'all' | 'open' | 'running' | 'finished';
const SHOW: Array<{ id: Show; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open to buy' },
  { id: 'running', label: 'Running' },
  { id: 'finished', label: 'Finished' },
];
type Sort = 'status' | 'yield' | 'closing' | 'newest';
const RANK = { open: 0, running: 1, 'repaid-early': 2, matured: 2, loss: 2, collateral: 2 } as const;

export default function Marketplace() {
  const { config } = useChains();
  const now = useNow(1000);
  const [show, setShow] = useState<Show>('all');
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [sort, setSort] = useState<Sort>('status');
  const [q, setQ] = useState('');
  // Which network's notes: all, or one (each chain the deployment serves).
  const nets = issueChains(config);
  const [net, setNet] = useState<string>('all');
  const multi = nets.length > 1;
  const { notes, error } = useNotes({ status: 'all', q: q.trim() || undefined });
  // Each note's own cash token (older demo notes settle in tUSD), falling back to the chain's stablecoin.
  const cashOf = (chain: string, token?: string) =>
    cashSymbol(
      config.chains.find((c) => c.key === chain),
      token,
    );
  // Notes on an earlier engine (none today) take no new subscriptions: never "open", labelled when shown.
  const earlier = (id: string) => !!engineOf(config, id)?.legacy;

  const all = useMemo(
    () =>
      // A note whose terms were never approved (started, then abandoned) was never offered: not listed.
      (notes ?? [])
        .filter((n) => !neverIssued(n.view))
        .map((n) => {
          const cash = cashOf(n.chain, n.view.cashToken);
          const st = statusOf(n.view, cash).key;
          const group: Show =
            st === 'open' && !earlier(n.id) ? 'open' : st === 'open' || st === 'running' ? 'running' : 'finished';
          return {
            n,
            cash,
            st,
            group,
            l: listingOf(n.view.params, { strikeDate: n.view.strikeDate, obsDates: n.view.obsDates }, cash),
          };
        }),
    [notes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const matches = (x: (typeof all)[number], ignoreShow = false) => {
    if (net !== 'all' && x.n.chain !== net) return false;
    if (!ignoreShow && show !== 'all' && x.group !== show) return false;
    if (filters.has('yield') && x.l.goal !== 'yield') return false;
    if (filters.has('protect') && x.l.goal !== 'protect' && !x.l.protection) return false;
    if (filters.has('stocks') && x.l.kind === 'crypto') return false;
    if (filters.has('crypto') && x.l.kind === 'stocks') return false;
    return true;
  };
  const shown = useMemo(() => {
    const by: Record<Sort, (a: (typeof all)[number], b: (typeof all)[number]) => number> = {
      status: (a, b) => RANK[a.st] - RANK[b.st] || b.n.view.createdAt - a.n.view.createdAt,
      yield: (a, b) => (b.l.yield.apr ?? -1) - (a.l.yield.apr ?? -1),
      closing: (a, b) =>
        (a.n.view.phase === 'book' ? a.n.view.strikeDate : Infinity) -
        (b.n.view.phase === 'book' ? b.n.view.strikeDate : Infinity),
      newest: (a, b) => b.n.view.createdAt - a.n.view.createdAt,
    };
    return all.filter((x) => matches(x)).sort(by[sort]);
  }, [all, filters, sort, show, net]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const c: Record<Show, number> = { all: 0, open: 0, running: 0, finished: 0 };
    for (const x of all)
      if (matches(x, true)) {
        c.all++;
        c[x.group]++;
      }
    return c;
  }, [all, filters, net]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (f: Filter) =>
    setFilters((s) => {
      const n = new Set(s);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });
  const clear = () => {
    setFilters(new Set());
    setShow('all');
    setNet('all');
    setQ('');
  };
  const narrowed = filters.size > 0 || show !== 'all' || net !== 'all' || !!q.trim();
  const cashWords = multi
    ? nets.map((c) => `${c.stablecoin.symbol} on ${chainName(config, c.key, true)}`).join(' or ')
    : (nets[0]?.stablecoin.symbol ?? 'USDG');

  return (
    <main className="page market">
      <div className="page-head">
        <div>
          <h1>Notes</h1>
          <p>
            Earn from how stocks and crypto move, with the rules set before you buy. Pay in {cashWords}; the prices are
            checked on each date (by Chainlink, or by Atlas and CoinMarketCap for Binance&apos;s stock tokens) and every
            payment is made on-chain.
          </p>
        </div>
        <Link to="/issue" className="btn primary lg">
          <Plus className="i" />
          Issue a note
        </Link>
      </div>

      <div className="mk-bar">
        <div className="seg" role="radiogroup" aria-label="Show" data-status-filter>
          {SHOW.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={show === s.id}
              className={show === s.id ? 'active' : ''}
              onClick={() => setShow(s.id)}
            >
              {s.label}
              {notes && <span className="num dim">{counts[s.id]}</span>}
            </button>
          ))}
        </div>
        {multi && (
          <div className="seg chain-filter" role="radiogroup" aria-label="Network" data-chain-filter>
            {[
              { key: 'all', name: 'All networks' },
              ...nets.map((c) => ({ key: c.key, name: chainName(config, c.key, true) })),
            ].map((c) => (
              <button
                key={c.key}
                type="button"
                role="radio"
                aria-checked={net === c.key}
                className={net === c.key ? 'active' : ''}
                data-chain={c.key}
                onClick={() => setNet(c.key)}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="filters" role="group" aria-label="Filters">
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
          <option value="status">Open first</option>
          <option value="yield">Highest rate</option>
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
        <div className="nc-grid" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="nc skeleton" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        notes.length && narrowed ? (
          <div className="empty mk-empty">
            <strong>
              {show === 'open' && counts.open === 0
                ? 'Nothing is open to buy right now.'
                : 'No notes match these filters.'}
            </strong>
            <span className="small">
              {counts.all > 0
                ? `${counts.all} note${counts.all === 1 ? '' : 's'} ${show !== 'all' ? 'running or finished' : 'on other networks or filters'}: see how they went, or issue a new one.`
                : 'Try fewer filters, or issue a new note.'}
            </span>
            <div className="row">
              <button className="btn primary" onClick={clear}>
                Show all notes
              </button>
              <Link to="/issue" className="btn">
                Issue a note
              </Link>
            </div>
          </div>
        ) : (
          <NoNotes cash={nets[0]?.stablecoin.symbol ?? 'USDG'} />
        )
      ) : (
        <div className="nc-grid">
          {shown.map(({ n, cash }) => (
            <NoteCard
              key={n.id}
              id={n.id}
              o={n.view}
              cash={cash}
              now={now}
              chainKey={n.chain}
              earlier={earlier(n.id)}
            />
          ))}
        </div>
      )}
      <p className="xs muted mt-14">
        Rates are a year's worth of each note's coupons. A rate with a condition is paid only while prices stay above
        its line.
      </p>
    </main>
  );
}

/** No notes yet anywhere: play an example while the first one is issued. */
function NoNotes({ cash }: { cash: string }) {
  return (
    <div className="stack">
      <div className="empty mk-empty">
        <strong>No notes yet.</strong>
        <span className="small">Issue the first one, or play an example below to see how a note pays.</span>
        <Link to="/issue" className="btn primary">
          Issue a note
        </Link>
      </div>
      <PlayNote
        p={{ ...EXAMPLE_WORST_OF, underlyings: [FEEDS.TSLA, FEEDS.NVDA], observations: 3 }}
        cash={cash}
        title="Play an example note"
      />
    </div>
  );
}

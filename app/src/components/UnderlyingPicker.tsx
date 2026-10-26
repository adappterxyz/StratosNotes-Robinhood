/**
 * The underlying picker: any Chainlink price in the catalogue (stocks, crypto, forex, commodities), searchable and
 * grouped by class. The chosen and the popular ones stay as chips in the "Underlyings" group; the rest is one search
 * away. Each entry says where its fixing comes from ("Chainlink · Robinhood Chain").
 */
import { useId, useMemo, useState } from 'react';
import {
  ASSET_CLASSES,
  FEED_CATALOGUE,
  FEED_CHAIN_LABELS,
  POPULAR_UNDERLYINGS,
  UNPRICED_STOCKS,
  type AssetClass,
  type CatalogueFeed,
} from '@sn/core';
import { AssetIcon } from './AssetIcon';

/** "Chainlink · Robinhood Chain". */
export const feedSource = (f: Pick<CatalogueFeed, 'feedChain'>) =>
  `Chainlink · ${FEED_CHAIN_LABELS[f.feedChain] ?? f.feedChain}`;

/**
 * A default-style name ("12M Phoenix on ETH", "… on ETH, BTC") follows a change of underlyings; a name the issuer
 * wrote stays as it is.
 */
export function renameForUnderlyings(name: string, from: string[], to: string[]): string {
  const old = ` on ${from.join(', ')}`;
  return from.length && to.length && name.endsWith(old) ? `${name.slice(0, -old.length)} on ${to.join(', ')}` : name;
}

const CLASS_HINT: Record<AssetClass, string> = {
  Stocks: 'US stocks and ETFs',
  Crypto: 'crypto',
  Forex: 'currencies against the dollar',
  Commodities: 'gold, silver',
};

/** Whether a catalogue entry matches a search: ticker, "EUR/USD", name or class. */
export function matchesFeed(f: CatalogueFeed, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const bare = s.replace(/\s*[/-]?\s*usd$/, '');
  const sym = f.symbol.toLowerCase();
  return (
    sym.startsWith(bare || s) ||
    `${sym}/usd`.startsWith(s.replace(/\s+/g, '')) ||
    f.name.toLowerCase().includes(s) ||
    f.assetClass.toLowerCase().startsWith(s)
  );
}

export function UnderlyingPicker({
  selected,
  onToggle,
  canAdd,
  deliverable,
  idPrefix = 'und',
}: {
  /** Chosen symbols, in order. */
  selected: string[];
  /** Pick or drop a symbol (the caller enforces single / basket rules). */
  onToggle: (symbol: string) => void;
  /** Whether another symbol can be added now (a full basket: no). */
  canAdd: boolean;
  /** The token a symbol is delivered in on the note's chain, if any (shown as a tag). */
  deliverable: (symbol: string) => string | null;
  idPrefix?: string;
}) {
  const [q, setQ] = useState('');
  const [browse, setBrowse] = useState(false);
  const listId = useId();
  const chips = useMemo(() => [...selected, ...POPULAR_UNDERLYINGS.filter((s) => !selected.includes(s))], [selected]);
  const byClass = useMemo(() => {
    const hits = FEED_CATALOGUE.filter((f) => matchesFeed(f, q));
    return ASSET_CLASSES.map((c) => ({ c, feeds: hits.filter((f) => f.assetClass === c) })).filter(
      (g) => g.feeds.length,
    );
  }, [q]);
  const open = browse || q.trim().length > 0;
  const total = byClass.reduce((n, g) => n + g.feeds.length, 0);
  const feedOf = (s: string) => FEED_CATALOGUE.find((f) => f.symbol === s);

  return (
    <div className="und-picker" data-underlying-picker>
      <div className="row iw-unds" role="group" aria-label="Underlyings">
        {chips.map((k) => {
          const on = selected.includes(k);
          const f = feedOf(k);
          return (
            <button
              key={k}
              type="button"
              className={`chip ${on ? 'on' : ''}`}
              aria-pressed={on}
              data-underlying={k}
              disabled={!on && !canAdd}
              title={f ? `${f.name} (${k}/USD), ${feedSource(f)}` : k}
              onClick={() => onToggle(k)}
            >
              <AssetIcon sym={k} size={18} />
              {k}
            </button>
          );
        })}
        {UNPRICED_STOCKS.map((k) => (
          <button
            key={k}
            type="button"
            className="chip"
            disabled
            title={`${k}: a Robinhood Chain stock token you can hold, with no Chainlink price yet`}
          >
            <AssetIcon sym={k} size={18} />
            {k}
          </button>
        ))}
      </div>
      <div className="und-search">
        <input
          id={`${idPrefix}-search`}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${FEED_CATALOGUE.length} prices: EUR, gold, NVDA…`}
          aria-label="Search underlyings"
          aria-controls={listId}
          autoComplete="off"
        />
        {!q && (
          <button type="button" className="btn sm" aria-expanded={browse} onClick={() => setBrowse(!browse)}>
            {browse ? 'Hide the list' : 'Browse all'}
          </button>
        )}
      </div>
      {open && (
        <div className="und-results" id={listId} aria-label="Chainlink prices" role="region">
          {total === 0 && <p className="hint">No Chainlink price matches “{q}”.</p>}
          {byClass.map(({ c, feeds }) => (
            <div key={c} className="und-group" data-class={c}>
              <div className="und-group-h">
                {c} <span className="dim">· {CLASS_HINT[c]}</span>
              </div>
              <ul>
                {feeds.map((f) => {
                  const on = selected.includes(f.symbol);
                  const token = deliverable(f.symbol);
                  return (
                    <li key={f.symbol}>
                      <button
                        type="button"
                        className={`und-item ${on ? 'on' : ''}`}
                        aria-pressed={on}
                        data-underlying-option={f.symbol}
                        disabled={!on && !canAdd}
                        onClick={() => onToggle(f.symbol)}
                      >
                        <AssetIcon sym={f.symbol} size={22} />
                        <span className="und-main">
                          <strong>{f.symbol}/USD</strong>
                          <span className="und-name">{f.name}</span>
                        </span>
                        <span className="und-src">
                          {feedSource(f)}
                          {token ? <span className="pill plain">delivers {token}</span> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

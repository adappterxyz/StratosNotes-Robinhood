import { useEffect, useState } from 'react';
import { Droplets } from 'lucide-react';
import { collateralAdvice, isBStockSymbol, type TokenMarket } from '@sn/core';
import { api } from '../../lib/api';

const usd = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

/**
 * For each stock token pledged: its market on BNB Chain's DEXes (CoinMarketCap DEX API), a suggested haircut and a
 * warning when the pledge is large against the liquidity it would be sold into (core collateralAdvice).
 */
export function CollateralMarket({
  collateral,
  pledgeUsd,
  onUse,
}: {
  /** The collateral chosen: symbol and what % of its value is counted. */
  collateral: Array<{ symbol: string; haircutPct: number }>;
  /** USD value of an asset's pledge at this size, if it alone covered the note. */
  pledgeUsd: (symbol: string) => number;
  onUse: (symbol: string, countedAtPct: number) => void;
}) {
  const tokens = collateral.filter((c) => isBStockSymbol(c.symbol));
  const key = tokens.map((c) => c.symbol).join(',');
  const [markets, setMarkets] = useState<Record<string, TokenMarket> | null>(null);
  useEffect(() => {
    if (!key) return;
    let on = true;
    api
      .marketLiquidity(key.split(','))
      .then((r) => on && setMarkets(r.markets))
      .catch(() => on && setMarkets(null));
    return () => {
      on = false;
    };
  }, [key]);
  if (!tokens.length || !markets) return null;
  return (
    <div className="stack" data-collateral-market>
      {tokens.map((c) => {
        const m = markets[c.symbol];
        if (!m) return null;
        const pledge = pledgeUsd(c.symbol);
        const a = collateralAdvice(m, pledge);
        const share = Number.isFinite(a.sharePct) ? `${a.sharePct < 0.1 ? '<0.1' : a.sharePct.toFixed(1)}%` : 'all';
        return (
          <div
            key={c.symbol}
            className={`notice ${a.size === 'ok' ? 'info' : 'warn'}`}
            data-market={c.symbol}
            data-suggested={a.countedAtPct}
          >
            <Droplets className="i" />{' '}
            <span>
              <b>{c.symbol} on BNB Chain DEXes:</b> {usd(m.liquidityUsd)} of liquidity, {usd(m.volume24hUsd)} traded in
              24 hours, a {a.rangePct.toFixed(1)}% range over the day (CoinMarketCap). This pledge, about {usd(pledge)},
              is {share} of that liquidity.{' '}
              {a.size === 'too-large'
                ? 'It is more than half of what the market holds: it could not be sold near its price. Pledge less, or add another asset.'
                : a.size === 'large'
                  ? 'It is large for this market, so it should count for less.'
                  : ''}{' '}
              {a.countedAtPct === c.haircutPct ? (
                <>Counted at {c.haircutPct}% of its value, as suggested.</>
              ) : (
                <>
                  Suggested: count it at {a.countedAtPct}% of its value (now {c.haircutPct}%).{' '}
                  <button type="button" className="link" onClick={() => onUse(c.symbol, a.countedAtPct)}>
                    Use {a.countedAtPct}%
                  </button>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

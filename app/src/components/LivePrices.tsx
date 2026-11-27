import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { secondSourceTolerance, usMarketOpen } from '@sn/core';
import { api } from '../lib/api';

type Live = Record<string, { price: number; at: number; status?: string; score?: number }>;

/**
 * Where each stock token stands right now against its start price: Atlas's signed price, checked by the API
 * (signature recovered to Atlas's key) and refreshed every 30 seconds. Between checks only; the note's fixings are
 * the on-chain feed confirmed by CoinMarketCap.
 */
export function LivePrices({ unds }: { unds: Array<{ symbol: string; strike: number | null }> }) {
  const key = unds.map((u) => u.symbol).join(',');
  const [live, setLive] = useState<Live | null>(null);
  useEffect(() => {
    let on = true;
    const load = () =>
      api
        .atlasPrices(key.split(','))
        .then((r) => on && setLive(r.prices))
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 30_000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [key]);
  if (!live || !unds.some((u) => live[u.symbol])) return null;
  const open = usMarketOpen(Math.floor(Date.now() / 1000));
  const limit = secondSourceTolerance(Math.floor(Date.now() / 1000)) / 100;
  const unhealthy = unds.filter((u) => live[u.symbol]?.status && live[u.symbol].status !== 'HEALTHY');
  return (
    <p className="xs muted row gap-6" data-live-prices>
      <Radio className="i ic-12" />
      <span>
        <b>Now</b>{' '}
        {unds
          .filter((u) => live[u.symbol])
          .map((u) => {
            const p = live[u.symbol].price;
            return `${u.symbol} ${p.toFixed(2)}${u.strike ? ` (${((p / u.strike) * 100).toFixed(1)}% of start)` : ''}`;
          })
          .join(' · ')}
        . Atlas signed price, signature checked
        {unhealthy.length
          ? `; Atlas rates its sources for ${unhealthy.map((u) => u.symbol).join(' and ')} as ${live[unhealthy[0].symbol].status!.toLowerCase().replace('_', ' ')}`
          : ''}
        {'. '}US stock market {open ? 'open' : 'closed'}: Atlas and CoinMarketCap must agree within {limit}% to fix a
        price.
      </span>
    </p>
  );
}

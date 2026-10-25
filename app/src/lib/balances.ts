/**
 * Wallet balances on every configured chain, read live from each chain's RPC: native ETH (gas), the cash token,
 * WETH, the chain's own stock tokens (Robinhood Chain: TSLA, AMZN, AMD, PLTR, NFLX), and collateral receipts held on
 * the home chain. notes.markets' retired test tokens (tETH, tTSLA…) are never listed; tUSD only when held (older notes
 * settle in it). Zero balances are kept out except the cash token and ETH, which a newcomer needs to see first.
 */
import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, formatUnits } from 'viem';
import { CHAIN_TOKENS, isRetiredTestToken, TEST_CASH_TOKEN, type NoteChain } from '@sn/core';
import { entryFor, useChains } from './chains';

export interface Balance {
  sym: string;
  amount: number;
  kind: 'gas' | 'cash' | 'stock' | 'legacy' | 'receipt' | 'token';
}
export interface ChainBalances {
  key: string;
  name: string;
  balances: Balance[];
  error?: string;
}

const decimalsCache = new Map<string, number>();
const STOCKS = new Set(
  Object.values(CHAIN_TOKENS)
    .flatMap((c) => Object.values(c))
    .filter((t) => t.issuer === 'Robinhood')
    .map((t) => t.token),
);

export function useWalletBalances(address: string | null) {
  const { byKey } = useChains();
  const [data, setData] = useState<ChainBalances[] | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!address) {
      setData(null);
      return;
    }
    let live = true;
    const owner = address as `0x${string}`;
    Promise.all(
      Object.values(byKey).map(async ({ cfg, client }): Promise<ChainBalances> => {
        try {
          const cash = cfg.stablecoin;
          const entries: Array<{ sym: string; token: `0x${string}`; kind: Balance['kind'] }> = [];
          const seen = new Set<string>();
          const add = (sym: string, token: `0x${string}`, kind: Balance['kind']) => {
            const k = token.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            entries.push({ sym, token, kind });
          };
          add(cash.symbol, cash.address, 'cash');
          // Every real token of the chain (even before the API lists it), then what the API names besides.
          const known = Object.values(CHAIN_TOKENS[cfg.key as NoteChain] ?? {}).map(
            (t) => [t.token, t.address] as const,
          );
          for (const [sym, token] of [...known, ...Object.entries(cfg.tokens)]) {
            if (isRetiredTestToken(sym) || sym.endsWith('.rh')) continue; // receipts: listed below, from the gateway
            add(
              sym,
              token as `0x${string}`,
              STOCKS.has(sym)
                ? 'stock'
                : sym === TEST_CASH_TOKEN.token
                  ? 'legacy'
                  : sym === cash.symbol
                    ? 'cash'
                    : 'token',
            );
          }
          if (cfg.crossChain?.role === 'home') {
            for (const r of cfg.crossChain.remotes ?? [])
              for (const [sym, rc] of Object.entries(r.receipts))
                if (!isRetiredTestToken(sym)) add(sym, rc.receipt, 'receipt');
          }
          // Receipts from an earlier engine's gateway (v3 notes' collateral): listed when held, by their version.
          for (const l of cfg.legacyEngines ?? []) {
            if (l.crossChain?.role !== 'home') continue;
            for (const r of l.crossChain.remotes ?? [])
              for (const [sym, rc] of Object.entries(r.receipts))
                if (!isRetiredTestToken(sym)) add(`${sym} (v${l.version})`, rc.receipt, 'receipt');
          }
          const [eth, ...vals] = await Promise.all([
            client.getBalance({ address: owner }),
            ...entries
              .map(async (e) => {
                const key = `${cfg.key}:${e.token.toLowerCase()}`;
                let dec = decimalsCache.get(key);
                if (dec === undefined) {
                  dec = Number(
                    await client.readContract({ address: e.token, abi: erc20Abi, functionName: 'decimals' }),
                  );
                  decimalsCache.set(key, dec);
                }
                const raw = await client.readContract({
                  address: e.token,
                  abi: erc20Abi,
                  functionName: 'balanceOf',
                  args: [owner],
                });
                return Number(formatUnits(raw, dec));
              })
              .map((p) => p.catch(() => NaN)),
          ]);
          const balances: Balance[] = [{ sym: 'ETH', amount: Number(formatUnits(eth, 18)), kind: 'gas' }];
          entries.forEach((e, i) => {
            const amount = vals[i];
            if (Number.isNaN(amount)) return;
            if (amount > 0 || e.kind === 'cash') balances.push({ sym: e.sym, amount, kind: e.kind });
          });
          return { key: cfg.key, name: cfg.name, balances };
        } catch (e) {
          return {
            key: cfg.key,
            name: cfg.name,
            balances: [],
            error: e instanceof Error ? e.message.split('\n')[0] : String(e),
          };
        }
      }),
    ).then((r) => {
      if (live) setData(r);
    });
    return () => {
      live = false;
    };
  }, [address, byKey, tick]);
  return { data, refresh };
}

/**
 * What `address` can claim of each note's cash asset, read from the chain (FlowEngine balanceOf: payouts not
 * claimed yet, and other cash on the account, e.g. an issuer's proceeds). Undefined while loading or for a note
 * whose chain is not configured; the read model's figure is the fallback.
 */
export function useClaimable(address: string | null, notes: Array<{ id: string; chain: string }>, asset = 1, tick = 0) {
  const { byKey } = useChains();
  const [data, setData] = useState<Map<string, bigint>>(new Map());
  const key = notes.map((n) => n.id).join(',');
  useEffect(() => {
    if (!address || !notes.length) {
      setData(new Map());
      return;
    }
    let live = true;
    Promise.all(
      notes.map(async (n) => {
        const c = entryFor(byKey, { chain: n.chain, id: n.id }); // the note's own engine (current or earlier)
        if (!c) return null;
        try {
          return [n.id, await c.adapter.claimable(n.id, address, asset)] as const;
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (live) setData(new Map(rows.filter((r): r is readonly [string, bigint] => !!r)));
    });
    return () => {
      live = false;
    };
  }, [address, key, asset, tick, byKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
}

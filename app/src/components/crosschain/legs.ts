/** The cross-chain legs (home gateway + asset-chain vault) this deployment configures, and hooks reading them. */
import { useEffect, useMemo, useState } from 'react';
import { erc20Abi } from 'viem';
import { homeGatewayAbi } from '@sn/sdk';
import { crossChainLeg, crossChainLegs, useAddress, useChains } from '../../lib/chains';
import type { Leg } from './shared';

/**
 * The cross-chain pair for notes on `homeKey` with collateral locked on `assetKey` (default: the first home chain this
 * deployment serves and its first asset chain), when this deployment has it.
 */
export function useCrossChain(homeKey?: string, assetKey?: string): Leg | null {
  const { config } = useChains();
  // Memoised: the leg is an effect dependency (receipt balances), so it must keep its identity across renders.
  return useMemo(() => {
    const home = homeKey ?? config.chains.find((c) => c.crossChain?.role === 'home')?.key;
    return home ? crossChainLeg(config, home, assetKey) : null;
  }, [config, homeKey, assetKey]);
}

/** Every pair, both directions: current pairs per home chain, then earlier engines' and replaced pairs. */
export function useCrossChainLegs(): Leg[] {
  const { config } = useChains();
  return useMemo(() => crossChainLegs(config), [config]);
}

/** Receipt balances (on the home chain) for the given receipt symbols, refreshed every 20 s. */
export function useReceiptBalances(leg: Leg | null, syms: string[], tick: number) {
  const address = useAddress();
  const { byKey } = useChains();
  const [bal, setBal] = useState<Record<string, bigint>>({});
  const key = syms.join(',');
  useEffect(() => {
    if (!leg || !address) return;
    let live = true;
    const read = async () => {
      const client = byKey[leg.home.key].client;
      const out: Record<string, bigint> = {};
      for (const s of syms) {
        const r = leg.receipts[s];
        if (r)
          out[s] = await client.readContract({
            address: r.receipt,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address as `0x${string}`],
          });
      }
      if (live) setBal(out);
    };
    read().catch(() => {});
    const t = setInterval(() => read().catch(() => {}), 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [leg, address, key, tick, byKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return bal;
}

/** Whether a gateway auto-releases (v2: `VERSION()` = 2; a v1 gateway has no VERSION and reverts). */
const versionCache = new Map<string, Promise<number>>();
export function useGatewayVersion(leg: Leg | null): number | null {
  const { byKey } = useChains();
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    if (!leg) return;
    let live = true;
    const key = `${leg.home.key}:${leg.gateway.toLowerCase()}`;
    if (!versionCache.has(key)) {
      versionCache.set(
        key,
        byKey[leg.home.key].client
          .readContract({ address: leg.gateway, abi: homeGatewayAbi, functionName: 'VERSION' })
          .then((x) => Number(x))
          .catch(() => 1),
      );
    }
    versionCache.get(key)!.then((x) => {
      if (live) setV(x);
    });
    return () => {
      live = false;
    };
  }, [leg, byKey]);
  return v;
}

/**
 * Whether `token` (a note asset on `homeKey`) is a receipt that the chain's current gateway releases automatically when
 * it leaves the note: withdrawing it pays the real token on the asset chain, nothing to redeem. Every pair of that
 * home shares its gateway, so one version read covers them.
 */
export function useAutoReleased(homeKey?: string): (token: string | undefined) => { chain: string } | null {
  const leg = useCrossChain(homeKey);
  const legs = useCrossChainLegs();
  const v = useGatewayVersion(leg);
  return (token) => {
    if (!leg || v !== 2 || !token) return null;
    const t = token.toLowerCase();
    const hit = legs.find(
      (l) =>
        !l.version &&
        l.home.key === leg.home.key &&
        l.gateway.toLowerCase() === leg.gateway.toLowerCase() &&
        Object.values(l.receipts).some((r) => r.receipt.toLowerCase() === t),
    );
    return hit ? { chain: hit.asset.name } : null;
  };
}

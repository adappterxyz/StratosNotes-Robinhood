/** The cross-chain legs (home gateway + asset-chain vault) this deployment configures, and hooks reading them. */
import { useEffect, useMemo, useState } from 'react';
import { erc20Abi } from 'viem';
import { homeGatewayAbi } from '@sn/sdk';
import { legacyConfig, useAddress, useChains } from '../../lib/chains';
import type { Leg } from './shared';

/** The home chain and its first asset chain, when this deployment has cross-chain collateral. */
export function useCrossChain(): Leg | null {
  const { config } = useChains();
  // Memoised: the leg is an effect dependency (receipt balances), so it must keep its identity across renders.
  return useMemo(() => currentLeg(config), [config]);
}

function currentLeg(config: ReturnType<typeof useChains>['config']): Leg | null {
  const home = config.chains.find((c) => c.crossChain?.role === 'home');
  const r = home?.crossChain?.remotes?.[0];
  const asset = r && config.chains.find((c) => c.key === r.chain);
  if (!home || !r || !asset || !home.crossChain?.gateway) return null;
  return { home, asset, vault: r.vault, gateway: home.crossChain.gateway, receipts: r.receipts };
}

/** The current pair, then each earlier engine's pair (receipts from v3 notes redeem through the v3 gateway). */
export function useCrossChainLegs(): Leg[] {
  const { config } = useChains();
  return useMemo(() => legsOf(config), [config]);
}

function legsOf(config: ReturnType<typeof useChains>['config']): Leg[] {
  const current = currentLeg(config);
  const out: Leg[] = current ? [current] : [];
  for (const c of config.chains) {
    for (const l of c.legacyEngines ?? []) {
      const xc = l.crossChain;
      const r = xc?.role === 'home' ? xc.remotes?.[0] : undefined;
      const asset = r && config.chains.find((x) => x.key === r.chain);
      if (!xc?.gateway || !r || !asset) continue;
      out.push({
        home: legacyConfig(c, l),
        asset,
        vault: r.vault,
        gateway: xc.gateway,
        receipts: r.receipts,
        version: l.version,
      });
    }
    // The current engine's earlier pairs (a v1 gateway: receipts held in wallets redeem by hand).
    for (const xc of c.previousCrossChain ?? []) {
      const r = xc?.role === 'home' ? xc.remotes?.[0] : undefined;
      const asset = r && config.chains.find((x) => x.key === r.chain);
      if (!xc?.gateway || !r || !asset) continue;
      out.push({ home: c, asset, vault: r.vault, gateway: xc.gateway, receipts: r.receipts });
    }
  }
  return out;
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
 * Whether `token` (a note asset) is a receipt that the current gateway releases automatically when it leaves the
 * note: withdrawing it pays the real token on the asset chain, nothing to redeem.
 */
export function useAutoReleased(): (token: string | undefined) => { chain: string } | null {
  const leg = useCrossChain();
  const v = useGatewayVersion(leg);
  return (token) => {
    if (!leg || v !== 2 || !token) return null;
    const t = token.toLowerCase();
    return Object.values(leg.receipts).some((r) => r.receipt.toLowerCase() === t) ? { chain: leg.asset.name } : null;
  };
}

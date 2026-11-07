/**
 * Engines per chain (Robinhood Chain testnet, Base Sepolia): each chain's current engine and the earlier ones whose notes stay on them (none today;
 * the mechanism stays for a future engine upgrade). Pure helpers (no React), used by the chains provider and tested on their own.
 */
import type { Chain, PublicClient } from 'viem';
import { parseNoteId, type EngineVersion, type EvmAdapter } from '@sn/sdk';
import {
  HOME_CHAIN,
  isNoteChain,
  NOTE_CHAIN_LABELS,
  NOTE_CHAIN_SHORT,
  remoteCollateralChains,
  type NoteChain,
} from '@sn/core';
import type { AppConfig, ChainConfig, CrossChainReceipt } from './api';

/** One engine on a chain: its config as the app uses it (an earlier engine's address, lens, tokens, cross-chain pair) and adapter. */
export interface EngineEntry {
  cfg: ChainConfig;
  chain: Chain;
  adapter: EvmAdapter;
  client: PublicClient;
  version: EngineVersion;
  /** An earlier engine: its notes are shown and settle there, but take no new subscriptions or issuance. */
  legacy: boolean;
}

/** Each chain's current engine (issuance, faucets, cross-chain locks), with every engine it serves by address. */
export type ByKey = Record<string, EngineEntry & { engines: Record<string, EngineEntry> }>;

/** The chain config an earlier engine's notes use: its engine, lens, receipts and gateway–vault pair. */
export function legacyConfig(cfg: ChainConfig, l: NonNullable<ChainConfig['legacyEngines']>[number]): ChainConfig {
  return {
    ...cfg,
    engine: l.engine,
    lens: l.lens,
    fromBlock: l.fromBlock,
    tokens: { ...cfg.tokens, ...l.tokens },
    crossChain: l.crossChain ?? null,
    legacyEngines: [],
  };
}

/** Whether a note (by id) runs on an earlier engine of its chain, and which version (null: not served here). */
export function engineOf(config: AppConfig, id: string): { legacy: boolean; version: number } | null {
  const p = parseNoteId(id);
  const c = p && config.chains.find((x) => x.key === p.chain);
  if (!p || !c) return null;
  if (c.engine.toLowerCase() === p.engine) return { legacy: false, version: 4 };
  const l = c.legacyEngines?.find((x) => x.engine.toLowerCase() === p.engine);
  return l ? { legacy: true, version: l.version } : null;
}

/**
 * The engine that runs a note, by its engine address or its id: the chain's current engine or an earlier one.
 * Undefined when this deployment does not serve that chain or engine (never another engine's adapter).
 */
export function entryFor(
  byKey: ByKey,
  note: { chain?: string; engine?: string; id?: string },
): EngineEntry | undefined {
  const p = note.id ? parseNoteId(note.id) : null;
  const chain = note.chain ?? p?.chain;
  const engine = (note.engine ?? p?.engine)?.toLowerCase();
  const c = chain ? byKey[chain] : undefined;
  if (!c) return undefined;
  return engine ? c.engines[engine] : c;
}

/**
 * The networks new notes are issued on: every chain this deployment serves (Robinhood Chain testnet and Base
 * Sepolia), the default (Robinhood Chain) first.
 */
export function issueChains(config: AppConfig): ChainConfig[] {
  const rank = (k: string) => (k === HOME_CHAIN ? 0 : 1);
  return [...config.chains].sort((a, b) => rank(a.key) - rank(b.key));
}

/** A chain's name for sentences: the served config's, else the note chain's label, else the key. */
export function chainName(config: AppConfig | null | undefined, key: string, short = false): string {
  if (short && isNoteChain(key)) return NOTE_CHAIN_SHORT[key];
  return config?.chains.find((c) => c.key === key)?.name ?? (isNoteChain(key) ? NOTE_CHAIN_LABELS[key] : key);
}

/**
 * One cross-chain pair: the home chain (runs notes, holds the gateway and receipts) and an asset chain (holds the
 * vault and the real tokens). `version`: set for an earlier engine's own gateway–vault pair.
 */
export type Leg = {
  home: ChainConfig;
  asset: ChainConfig;
  vault: `0x${string}`;
  gateway: `0x${string}`;
  receipts: Record<string, CrossChainReceipt>;
  version?: number;
};

function legFrom(config: AppConfig, home: ChainConfig, xc: ChainConfig['crossChain'], version?: number): Leg[] {
  if (!xc || xc.role !== 'home' || !xc.gateway) return [];
  const out: Leg[] = [];
  for (const r of xc.remotes ?? []) {
    const asset = config.chains.find((c) => c.key === r.chain);
    if (!asset) continue;
    out.push({
      home,
      asset,
      vault: r.vault,
      gateway: xc.gateway,
      receipts: r.receipts,
      ...(version ? { version } : {}),
    });
  }
  return out;
}

/**
 * The current cross-chain pair for notes on `homeKey` whose collateral is locked on `assetKey` (its first asset chain
 * when none is named), or null when this deployment does not serve both sides.
 */
export function crossChainLeg(config: AppConfig, homeKey: string, assetKey?: string): Leg | null {
  const home = config.chains.find((c) => c.key === homeKey);
  if (!home) return null;
  const legs = legFrom(config, home, home.crossChain);
  return (assetKey ? legs.find((l) => l.asset.key === assetKey) : legs[0]) ?? null;
}

/**
 * Every pair this deployment serves: each home chain's current pairs (both directions), then each earlier engine's
 * own pair and the current engine's replaced pairs (receipts held in wallets redeem through their own gateway).
 */
export function crossChainLegs(config: AppConfig): Leg[] {
  const out: Leg[] = [];
  for (const c of config.chains) out.push(...legFrom(config, c, c.crossChain));
  for (const c of config.chains) {
    for (const l of c.legacyEngines ?? []) out.push(...legFrom(config, legacyConfig(c, l), l.crossChain, l.version));
    for (const xc of c.previousCrossChain ?? []) out.push(...legFrom(config, c, xc));
  }
  return out;
}

/**
 * Where a note on `homeKey` can hold its collateral: in the note itself, or locked on another note chain. A remote
 * choice is `live` only when this deployment serves its pair (the home's gateway lists that chain's vault) with the
 * receipts the note would pledge in the home chain's tokens.
 */
export function heldOnChoices(
  config: AppConfig,
  homeKey: string,
): Array<{ key: 'note' | NoteChain; label: string; live: boolean }> {
  const home = config.chains.find((c) => c.key === homeKey);
  const note = { key: 'note' as const, label: chainName(config, homeKey, true), live: true };
  if (!isNoteChain(homeKey)) return [note];
  return [
    note,
    ...remoteCollateralChains(homeKey).map((asset) => {
      const leg = crossChainLeg(config, homeKey, asset);
      const live = !!leg && Object.keys(leg.receipts).some((sym) => !!home?.tokens?.[sym]);
      return { key: asset, label: NOTE_CHAIN_SHORT[asset], live };
    }),
  ];
}

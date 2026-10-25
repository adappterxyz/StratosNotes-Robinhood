/**
 * Engines per chain: each chain's current engine and the earlier ones whose notes stay on them (FlowEngine v3
 * next to v4). Pure helpers (no React), used by the chains provider and tested on their own.
 */
import type { Chain, PublicClient } from 'viem';
import { parseNoteId, type EngineVersion, type EvmAdapter } from '@sn/sdk';
import type { AppConfig, ChainConfig } from './api';

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
 * Robinhood Chain testnet is a collateral chain only (the vault behind Arbitrum notes): no note is issued there.
 * Notes issued on its engines before that (FlowEngine v4 0xf1a1…0244, v3 0xCbF6…b22D) are legacy: they run to
 * maturity there and stay reachable by link and in their holders' portfolios, but are not listed or offered.
 */
export const COLLATERAL_CHAIN = 'robinhood-testnet';
export const ROBINHOOD_LEGACY_ENGINES: readonly string[] = [
  '0xf1a1fa45770582d1eebc173d9076e95f9cfa0244', // FlowEngine v4 on Robinhood Chain testnet
  '0xcbf6eec598b8f3b4a4082f5583db6bd6f488b22d', // FlowEngine v3 on Robinhood Chain testnet
];
export const ROBINHOOD_LEGACY_LABEL = 'Issued on Robinhood Chain (legacy)';

/** Whether a note was issued on Robinhood Chain (by its chain, engine or id): a legacy note, never listed. */
export function onRobinhoodChain(note: { id?: string; chain?: string; engine?: string }): boolean {
  const p = note.id ? parseNoteId(note.id) : null;
  const chain = note.chain ?? p?.chain;
  const engine = (note.engine ?? p?.engine)?.toLowerCase();
  return chain === COLLATERAL_CHAIN || (!!engine && ROBINHOOD_LEGACY_ENGINES.includes(engine));
}

/** The notes the marketplace lists (and can offer as "Open now"): none issued on Robinhood Chain. */
export function marketplaceNotes<T extends { id: string; chain?: string }>(notes: readonly T[]): T[] {
  return notes.filter((n) => !onRobinhoodChain(n));
}

/** The networks new notes are issued on: every chain this deployment serves except the collateral chain. */
export function issueChains(config: AppConfig): ChainConfig[] {
  return config.chains.filter((c) => c.key !== COLLATERAL_CHAIN);
}

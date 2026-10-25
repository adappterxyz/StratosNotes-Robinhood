/**
 * Engines per chain: each chain's current engine and the earlier ones whose notes stay on them (none today;
 * the mechanism stays for a future engine upgrade). Pure helpers (no React), used by the chains provider and tested on their own.
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

/** The networks new notes are issued on: every chain this deployment serves (Robinhood Chain testnet). */
export function issueChains(config: AppConfig): ChainConfig[] {
  return config.chains;
}

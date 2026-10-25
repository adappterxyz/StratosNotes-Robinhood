/**
 * The Worker's configuration: what the API serves (services/api's ApiConfig) and what the cron indexes. Both are
 * generated from deployments/*.json by scripts/server-config.ts (deployments/server/{api,indexer}.json) and
 * bundled into the Worker; `SN_CONFIG` (a JSON string var, e.g. for `wrangler dev` against a local fork)
 * replaces them.
 */
import { z } from 'zod';
import { ApiConfig } from '../../api/src/config';
import type { ChainConfig } from './ingest';

export { ApiConfig };

export const IndexerChain = z
  .object({
    key: z.string().regex(/^[a-z0-9-]{1,40}$/),
    family: z.literal('evm').default('evm'),
    chainId: z.number().int(),
    rpc: z.string().url(),
    engine: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    startBlock: z.number().int().nonnegative(),
    confirmations: z.number().int().nonnegative().optional(),
    finality: z.enum(['confirmations', 'finalized']).optional(),
    maxRange: z.number().int().positive().optional(),
    /** The engine's row key in D1 (default: `key`). */
    indexKey: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
    version: z.number().int().positive().optional(),
    /**
     * Earlier engines on this chain whose notes stay on them (e.g. FlowEngine v3 next to v4): each is indexed too,
     * under `<key>-v<version>`, and its notes keep their ids (`<key>:<engine>:<pid>`).
     */
    legacyEngines: z
      .array(
        z.object({
          engine: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
          startBlock: z.number().int().nonnegative(),
          version: z.number().int().positive(),
        }),
      )
      .default([]),
  })
  .passthrough();

export const EdgeConfig = z.object({
  api: ApiConfig,
  indexer: z.object({ chains: z.array(IndexerChain) }),
});
export type EdgeConfig = z.infer<typeof EdgeConfig>;

export function parseEdgeConfig(raw: unknown): EdgeConfig {
  return EdgeConfig.parse(raw);
}

/** The row key of an earlier engine on chain `key`. */
export const legacyIndexKey = (key: string, version: number) => `${key}-v${version}`;

/**
 * One ingestor config per (chain, engine): each chain's earlier engines first (so an earlier engine adopts the
 * D1 row it was indexed under, the chain key, before the current engine claims that key), then the current ones.
 */
export function indexerChains(c: EdgeConfig): ChainConfig[] {
  const legacy: ChainConfig[] = [];
  const current: ChainConfig[] = [];
  for (const { legacyEngines, ...ch } of c.indexer.chains) {
    const key = ch.indexKey ?? ch.key;
    for (const l of legacyEngines) {
      if (l.engine.toLowerCase() === ch.engine.toLowerCase())
        throw new Error(`${ch.key}: legacy engine ${l.engine} is the current engine`);
      legacy.push({
        ...ch,
        engine: l.engine as `0x${string}`,
        startBlock: l.startBlock,
        version: l.version,
        indexKey: legacyIndexKey(ch.key, l.version),
        adoptFrom: ch.key,
      });
    }
    current.push({ ...ch, engine: ch.engine as `0x${string}`, indexKey: key });
  }
  const keys = [...legacy, ...current].map((x) => x.indexKey);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw new Error(`two engines share the indexer key ${dup}`);
  return [...legacy, ...current];
}

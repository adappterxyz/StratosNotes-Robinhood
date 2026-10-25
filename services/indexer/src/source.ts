/**
 * Where the indexer reads a chain from. `ChainSource` is all it needs; `evmSource` implements it over JSON-RPC
 * with viem. Tests use an in-memory chain that can reorg (test/fake-chain.ts).
 */
import { createPublicClient, http, numberToHex, type Hex, type PublicClient } from 'viem';
import { flowEngineAbi } from '@sn/sdk';

export interface RawLog {
  block: bigint;
  blockHash: string;
  logIndex: number;
  tx: string;
  data: Hex;
  topics: Hex[];
}

export interface ChainSource {
  /** Latest block number. */
  head(): Promise<bigint>;
  /** The chain's finalized block number, when it has one (else null). */
  finalized(): Promise<bigint | null>;
  /** A block's hash and timestamp (null when the block does not exist). */
  block(n: bigint): Promise<{ hash: string; ts: number } | null>;
  /** The engine's logs in [from, to], in chain order. */
  logs(from: bigint, to: bigint): Promise<RawLog[]>;
  /** A registered definition's CORE bytes (content-addressed, so any block will do). */
  definitionCore(id: string): Promise<Hex>;
  /** The engine's fallback reporter as of a block. */
  fallbackReporterAt(block: bigint): Promise<string>;
}

export function evmSource(rpc: string, engine: `0x${string}`, client?: PublicClient): ChainSource {
  const c =
    client ?? (createPublicClient({ transport: http(rpc, { retryCount: 3, timeout: 20_000 }) }) as PublicClient);
  return {
    head: () => c.getBlockNumber({ cacheTime: 0 }),
    async finalized() {
      try {
        return (await c.getBlock({ blockTag: 'finalized' })).number;
      } catch {
        return null;
      }
    },
    async block(n) {
      try {
        const b = await c.getBlock({ blockNumber: n });
        return { hash: b.hash!.toLowerCase(), ts: Number(b.timestamp) };
      } catch {
        return null;
      }
    },
    async logs(from, to) {
      const raw = (await c.request({
        method: 'eth_getLogs',
        params: [{ address: engine, fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
      } as never)) as Array<{
        blockNumber: Hex;
        blockHash: Hex;
        logIndex: Hex;
        transactionHash: Hex;
        data: Hex;
        topics: Hex[];
        removed?: boolean;
      }>;
      return raw
        .filter((l) => !l.removed)
        .map((l) => ({
          block: BigInt(l.blockNumber),
          blockHash: l.blockHash.toLowerCase(),
          logIndex: Number(l.logIndex),
          tx: l.transactionHash.toLowerCase(),
          data: l.data,
          topics: l.topics,
        }))
        .sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
    },
    definitionCore: (id) =>
      c.readContract({ address: engine, abi: flowEngineAbi, functionName: 'definitionCore', args: [id as Hex] }),
    async fallbackReporterAt(block) {
      if (block < 0n) return '0x0000000000000000000000000000000000000000';
      try {
        return (
          await c.readContract({
            address: engine,
            abi: flowEngineAbi,
            functionName: 'fallbackReporter',
            blockNumber: block,
          })
        ).toLowerCase();
      } catch {
        return '0x0000000000000000000000000000000000000000'; // before the engine existed
      }
    },
  };
}

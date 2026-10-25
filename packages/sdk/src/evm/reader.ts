/**
 * Read notes from a FlowEngine through its NotesLens with viem (Node services, scripts, the app).
 */
import type { Address, PublicClient } from 'viem';
import {
  decodeEvmDef,
  dueReports,
  encodeEvmReport,
  type DueReport,
  type ProcessState,
  type WorkflowDef,
} from '@sn/core';
import { lensAbi } from './abi';
import { bytesToHex, hexToBytes, snapshotToState } from './state';

export interface EvmNotes {
  client: PublicClient;
  lens: Address;
  /** Block tag to read at: 'finalized' for keepers, 'latest' for UIs. */
  blockTag?: 'latest' | 'safe' | 'finalized';
}

/** Every running process, paging through the lens. */
export async function readRunning(
  n: EvmNotes,
  opts: { from?: bigint; scan?: bigint; max?: bigint } = {},
): Promise<ProcessState[]> {
  const out: ProcessState[] = [];
  let from = opts.from ?? 1n;
  for (;;) {
    const [snaps, next] = await n.client.readContract({
      address: n.lens,
      abi: lensAbi,
      functionName: 'running',
      args: [from, opts.scan ?? 200n, opts.max ?? 50n],
      blockTag: n.blockTag ?? 'latest',
    });
    for (const s of snaps)
      out.push(snapshotToState({ ...s, tokens: s.tokens, values: s.values, balances: s.balances }));
    if (next === 0n || (snaps.length === 0 && next === from)) break;
    from = next;
  }
  return out;
}

/** A published definition, decoded (null when the lens has no bytes for it). */
export async function readDefinition(n: EvmNotes, id: `0x${string}`): Promise<WorkflowDef | null> {
  const data = await n.client.readContract({
    address: n.lens,
    abi: lensAbi,
    functionName: 'definitionBytes',
    args: [id],
    blockTag: n.blockTag ?? 'latest',
  });
  return data === '0x' ? null : decodeEvmDef(hexToBytes(data));
}

/** What is due across every running process at `nowSec`. */
export async function readDue(
  n: EvmNotes,
  nowSec: number,
): Promise<{ due: DueReport[]; running: number; unpublished: string[] }> {
  const procs = await readRunning(n);
  const defs = new Map<string, WorkflowDef | null>();
  for (const id of new Set(procs.map((p) => p.definition))) defs.set(id, await readDefinition(n, id as `0x${string}`));
  const due: DueReport[] = [];
  const unpublished: string[] = [];
  for (const p of procs) {
    const def = defs.get(p.definition);
    if (!def) {
      unpublished.push(p.definition);
      continue;
    }
    due.push(...dueReports(p, def, nowSec));
  }
  return { due, running: procs.length, unpublished: [...new Set(unpublished)] };
}

/** The report payload for a due step and its observed values (engine fixed point). */
export const reportHex = (d: DueReport, values: bigint[]) =>
  bytesToHex(encodeEvmReport(BigInt(d.process), d.step, values));

/**
 * Engine state -> the keeper's chain-neutral ProcessState (packages/core keeper.ts). Pure: shared by the CRE
 * workflow (which reads through CRE's EVMClient) and the Node services (which read through viem).
 */
import type { ProcessState } from '@sn/core';

export interface EvmSnapshot {
  pid: bigint;
  definition: `0x${string}`;
  status: number;
  updatedAt: number;
  tokens: readonly number[];
  tags: bigint;
  values: readonly `0x${string}`[];
  /** Every role's balance of every asset (NotesLens): balances[role * nAssets + asset]. */
  balances?: readonly bigint[];
}

/** Field f's tag: 0 unset, 1 number, 2 text, 3 party. */
export const tagOf = (tags: bigint, field: number) => Number((tags >> BigInt(2 * field)) & 3n);

export function snapshotToState(s: EvmSnapshot): ProcessState {
  const numbers: Array<bigint | undefined> = s.values.map((v, f) =>
    tagOf(s.tags, f) === 1 ? BigInt.asIntN(256, BigInt(v)) : undefined,
  );
  return {
    id: s.pid.toString(),
    definition: s.definition,
    status: s.status,
    tokens: [...s.tokens],
    numbers,
    ...(s.balances ? { balances: [...s.balances] } : {}),
  };
}

export const hexToBytes = (h: string): Uint8Array => {
  const s = h.replace(/^0x/, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

export const bytesToHex = (b: Uint8Array): `0x${string}` =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

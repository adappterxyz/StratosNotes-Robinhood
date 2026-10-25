import { describe, expect, it } from 'vitest';
import { snapshotToState, tagOf } from '../src';

const word = (v: bigint) => `0x${BigInt.asUintN(256, v).toString(16).padStart(64, '0')}` as const;

describe('engine snapshot -> keeper state', () => {
  it('keeps numbers (negative ones included) and drops text, parties and unset fields', () => {
    // field 0 number, 1 text, 2 unset, 3 number (negative), 4 party
    const tags = 1n | (2n << 2n) | (1n << 6n) | (3n << 8n);
    expect([0, 1, 2, 3, 4].map((f) => tagOf(tags, f))).toEqual([1, 2, 0, 1, 3]);
    const s = snapshotToState({
      pid: 12n,
      definition: '0xab',
      status: 0,
      updatedAt: 5,
      tokens: [3, 3, 9],
      tags,
      values: [word(1_700_000_000n), word(0x41n << 248n), word(0n), word(-5n), word(0xdeadn)],
    });
    expect(s).toEqual({
      id: '12',
      definition: '0xab',
      status: 0,
      tokens: [3, 3, 9],
      numbers: [1_700_000_000n, undefined, undefined, -5n, undefined],
    });
  });
});

/**
 * Claim by default: a holder's claim is `pushTo(pid, asset, [self])` (a receipt per claim), plain `withdraw` takes
 * only what is left that is not a payout; and the issuer bot's push policy is off unless a note opts in.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  toFunctionSelector,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  CHAINS,
  claimPayoutsRequest,
  EvmAdapter,
  flowEngineAbi,
  noteId,
  payoutMethod,
  pushesNote,
  pushPolicyFromEnv,
} from '../src';
import { compileTemplate, EXAMPLE_PRODUCTS, type WorkflowDef } from '@sn/core';

const V4 = '0x7d36da43724b09bb03ed98a4574685070073020b';
const V3 = '0xaf8425a4b2d8994796e019d9b42cd99d40297e10';
const LENS = '0x7544378876d780e69968cd67c3fef9a294c23a0b';
const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x3333333333333333333333333333333333333333';
const PAYOUT_ID = `0x${'ab'.repeat(32)}` as const;

function payoutPaidLog(holder: string, amount: bigint) {
  const topics = encodeEventTopics({
    abi: flowEngineAbi,
    eventName: 'PayoutPaid',
    args: { pid: 5n, asset: 1, holder: holder as `0x${string}` },
  } as never);
  const ev = flowEngineAbi.find((x) => x.type === 'event' && x.name === 'PayoutPaid') as unknown as {
    inputs: ReadonlyArray<{ name: string; type: string; indexed?: boolean }>;
  };
  const plain = ev.inputs.filter((i) => !i.indexed);
  const values: Record<string, unknown> = { period: 2n, amount, payoutId: PAYOUT_ID, pid: 5n, asset: 1, holder };
  const data = encodeAbiParameters(plain as never, plain.map((i) => values[i.name]) as never);
  return {
    address: V4,
    topics,
    data,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: '0xabc',
    blockHash: '0x1',
    transactionIndex: 0,
    removed: false,
  };
}

/** A client whose balanceOf answers from a queue (before the claim, after it), and a wallet that records writes. */
function fakes(balances: bigint[], logs: unknown[] = []) {
  const writes: Array<{ address: string; functionName: string; data: `0x${string}` }> = [];
  const reads: string[] = [];
  const client = {
    readContract: async (r: { functionName: string }) => {
      reads.push(r.functionName);
      if (r.functionName === 'balanceOf') return balances.length > 1 ? balances.shift()! : balances[0];
      if (r.functionName === 'processOf') return { definition: '0xdef' };
      throw new Error(`unexpected read ${r.functionName}`);
    },
    estimateContractGas: async () => 100_000n,
    waitForTransactionReceipt: async () => ({ status: 'success', transactionHash: '0xabc', logs }),
  } as unknown as PublicClient;
  const wallet = {
    account: { address: ME },
    chain: undefined,
    writeContract: async (r: { address: string; abi: never; functionName: string; args: unknown[] }) => {
      writes.push({ address: r.address, functionName: r.functionName, data: encodeCall(r) });
      return '0xabc';
    },
  } as unknown as WalletClient;
  return { client, wallet, writes, reads };
}
const encodeCall = (r: { abi: never; functionName: string; args: unknown[] }) =>
  encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args } as never);
const withCash = (a: EvmAdapter) => {
  (a as unknown as { getDefinition: () => Promise<unknown> }).getDefinition = async () => ({
    assets: [{ decimals: 6 }, { decimals: 6 }],
  });
  return a;
};

describe('a holder claims its payouts with pushTo for itself', () => {
  const id = noteId('arbitrum-sepolia', V4, 5n);

  it('claimPayoutsRequest is pushTo(pid, asset, [holder]) on the engine', () => {
    const r = claimPayoutsRequest(V4, 5n, 1, ME);
    expect(r).toMatchObject({ address: V4, functionName: 'pushTo', args: [5n, 1, [ME]] });
  });

  it('claims with one pushTo for the connected wallet and returns the receipt', async () => {
    const { client, wallet, writes } = fakes(
      [12_500_000_000n, 0n],
      [payoutPaidLog(ME, 1_250_000n), payoutPaidLog(OTHER, 9n)],
    );
    const a = withCash(new EvmAdapter(CHAINS['arbitrum-sepolia'], client, { engine: V4, lens: LENS }));
    const r = await a.claimPayouts(wallet, id, 1);
    expect(writes).toHaveLength(1);
    expect(writes[0].address).toBe(V4);
    expect(writes[0].data.slice(0, 10)).toBe(toFunctionSelector('pushTo(uint256,uint8,address[])'));
    expect(decodeFunctionData({ abi: flowEngineAbi, data: writes[0].data }).args).toEqual([5n, 1, [ME]]);
    expect(r.paid).toBe(1_250_000n); // only this holder's receipt
    expect(r.payoutIds).toEqual([PAYOUT_ID]);
    expect(r.withdrawn).toBe(0n);
    expect(r.deferred).toBe(false);
  });

  it('then withdraws other cash left on the account (not a payout), and ignores sub-base-unit dust', async () => {
    const { client, wallet, writes } = fakes([30_000_000_000n, 20_000_000_000n, 20_000_000_000n]);
    const r = await withCash(
      new EvmAdapter(CHAINS['arbitrum-sepolia'], client, { engine: V4, lens: LENS }),
    ).claimPayouts(wallet, id, 1);
    expect(writes.map((w) => w.functionName)).toEqual(['pushTo', 'withdraw']);
    expect(decodeFunctionData({ abi: flowEngineAbi, data: writes[1].data }).args).toEqual([5n, 1, 2_000_000n]);
    expect(r.withdrawn).toBe(2_000_000n);
    const dust = fakes([12_500_000_000n, 9_999n]);
    await withCash(new EvmAdapter(CHAINS['arbitrum-sepolia'], dust.client, { engine: V4, lens: LENS })).claimPayouts(
      dust.wallet,
      id,
      1,
    );
    expect(dust.writes.map((w) => w.functionName)).toEqual(['pushTo']);
  });

  it('refuses when nothing is owed, without sending anything', async () => {
    const { client, wallet, writes } = fakes([0n]);
    await expect(
      new EvmAdapter(CHAINS['arbitrum-sepolia'], client, { engine: V4, lens: LENS }).claimPayouts(wallet, id, 1),
    ).rejects.toThrow(/Nothing to claim/);
    expect(writes).toHaveLength(0);
  });

  it('on a v3 note a claim is the plain withdrawal (no pushTo there)', async () => {
    const { client, wallet } = fakes([1n]);
    const a = new EvmAdapter(CHAINS['arbitrum-sepolia'], client, { engine: V3, lens: LENS, version: 3 });
    const called: number[] = [];
    a.withdraw = async (_w, _id, asset) => {
      called.push(asset);
      return { tx: ['0xw'] };
    };
    const r = await a.claimPayouts(wallet, noteId('arbitrum-sepolia', V3, 2n), 1);
    expect(called).toEqual([1]);
    expect(r).toEqual({ tx: ['0xw'], paid: 0n, payoutIds: [], withdrawn: 0n, deferred: false });
  });
});

describe('the issuer bot pushes nothing by default', () => {
  const plain = compileTemplate({ product: EXAMPLE_PRODUCTS.phoenix }).def as WorkflowDef;
  const optedIn = compileTemplate({ product: { ...EXAMPLE_PRODUCTS.phoenix, payouts: 'push' } }).def as WorkflowDef;

  it('a note is paid by claim unless its terms opt in to push', () => {
    expect(payoutMethod(plain)).toBe('claim');
    expect(payoutMethod(optedIn)).toBe('push');
  });

  it('no PUSH: only opted-in notes; PUSH=1: every note; PUSH=0: none', () => {
    const dflt = pushPolicyFromEnv({});
    expect(dflt.mode).toBe('opt-in');
    expect(pushesNote(dflt, plain)).toBe(false);
    expect(pushesNote(dflt, optedIn)).toBe(true);
    const all = pushPolicyFromEnv({ PUSH: '1' });
    expect(pushesNote(all, plain)).toBe(true);
    const off = pushPolicyFromEnv({ PUSH: '0' });
    expect(pushesNote(off, optedIn)).toBe(false);
  });

  it("PUSH_MIN is read in the asset's units (engine fixed point), PUSH_ASSETS and PUSH_BATCH as before", () => {
    const p = pushPolicyFromEnv({ PUSH: '1', PUSH_MIN: '0.5', PUSH_ASSETS: '1', PUSH_BATCH: '50' });
    expect(p.min).toBe(5_000_000_000n);
    expect([...p.assets!]).toEqual(['1']);
    expect(p.batch).toBe(50n);
    expect(pushPolicyFromEnv({}).min).toBe(0n);
  });
});

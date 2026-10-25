/**
 * The v3 note path: an EvmAdapter on an earlier engine (version 3) acts on its notes with the v3 ABI where it
 * differs (ledger units, no note token, no pushes) and refuses new issuance.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, toFunctionSelector, type PublicClient, type WalletClient } from 'viem';
import { CHAINS, EvmAdapter, flowEngineAbi, flowEngineV3Abi, noteId } from '../src';

const V3 = '0xaf8425a4b2d8994796e019d9b42cd99d40297e10';
const V4 = '0x7d36da43724b09bb03ed98a4574685070073020b';
const LENS = '0x7544378876d780e69968cd67c3fef9a294c23a0b';
const ME = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';

function fakes(reads: Record<string, unknown>) {
  const calls: Array<{ fn: string; address: string; args?: readonly unknown[] }> = [];
  const writes: Array<{ address: string; data: `0x${string}` }> = [];
  const client = {
    readContract: async (r: { address: string; functionName: string; args?: readonly unknown[] }) => {
      calls.push({ fn: r.functionName, address: r.address, args: r.args });
      if (!(r.functionName in reads)) throw new Error(`unexpected read ${r.functionName}`);
      return reads[r.functionName];
    },
    estimateContractGas: async () => 100_000n,
    waitForTransactionReceipt: async () => ({ status: 'success', transactionHash: '0xabc', logs: [] }),
  } as unknown as PublicClient;
  const wallet = {
    account: { address: ME },
    chain: undefined,
    writeContract: async (r: { address: string; abi: never; functionName: string; args: unknown[] }) => {
      writes.push({
        address: r.address,
        data: encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args } as never),
      });
      return '0xabc';
    },
  } as unknown as WalletClient;
  return { client, wallet, calls, writes };
}

const v3 = (client: PublicClient) =>
  new EvmAdapter(CHAINS['arbitrum-sepolia'], client, { engine: V3, lens: LENS, fromBlock: 322211118n, version: 3 });

describe('EvmAdapter on a v3 engine', () => {
  const id = noteId('arbitrum-sepolia', V3, 2n);

  it("keeps v3 note ids exactly as they were and only runs its own engine's notes", () => {
    const { client } = fakes({});
    const a = v3(client);
    expect(id).toBe('arbitrum-sepolia:0xaf8425a4b2d8994796e019d9b42cd99d40297e10:2');
    expect(a.legacy).toBe(true);
    expect(a.version).toBe(3);
    expect(a.runs(id)).toBe(true);
    expect(a.runs(noteId('arbitrum-sepolia', V4, 2n))).toBe(false);
    expect(new EvmAdapter(CHAINS['arbitrum-sepolia'], client, { engine: V4, lens: LENS }).legacy).toBe(false);
  });

  it('moves units with the v3 ledger transfer (fixed point, no ERC-20), after the recipient check', async () => {
    const { client, wallet, writes, calls } = fakes({
      requireEmail: true,
      emailOf: ['0x' + '0'.repeat(64), BigInt(Math.floor(Date.now() / 1000) + 3600)],
    });
    await v3(client).transferUnits(wallet, id, TO, 12_345n);
    expect(writes).toHaveLength(1);
    expect(writes[0].address).toBe(V3);
    expect(writes[0].data.slice(0, 10)).toBe(toFunctionSelector('transferUnits(uint256,uint8,address,int256)'));
    const d = decodeFunctionData({ abi: flowEngineV3Abi, data: writes[0].data });
    expect(d.args).toEqual([2n, 0, '0x2222222222222222222222222222222222222222', 12_345n]);
    expect(calls.map((c) => c.fn)).not.toContain('assetTokenOf');
  });

  it('refuses a transfer to an unverified recipient', async () => {
    const { client, wallet, writes } = fakes({ requireEmail: true, emailOf: ['0x' + '0'.repeat(64), 0n] });
    await expect(v3(client).transferUnits(wallet, id, TO, 1n)).rejects.toThrow(/verified email/);
    expect(writes).toHaveLength(0);
  });

  it('has no note token and no pushed payouts', async () => {
    const { client, wallet } = fakes({});
    expect(await v3(client).noteToken(id)).toBeNull();
    expect(await v3(client).watchAssetParams(id)).toBeNull();
    await expect(v3(client).pushPayouts(wallet, id, 1, 10)).rejects.toThrow(/v3/);
  });

  it('reads what a holder can withdraw from the engine ledger (same balanceOf as v4)', async () => {
    const { client, calls } = fakes({ balanceOf: 600_000_000_000n });
    expect(await v3(client).claimable(id, ME, 1)).toBe(600_000_000_000n);
    expect(calls[0]).toMatchObject({ fn: 'balanceOf', address: V3, args: [2n, ME, 1n] });
  });

  it('withdraws with the unchanged withdraw ABI', async () => {
    const def = { assets: [{ decimals: 6 }, { decimals: 6 }] };
    const { client, wallet, writes } = fakes({
      processOf: { definition: '0x' + '11'.repeat(32) },
      balanceOf: 600_000_000_000n,
    });
    const a = v3(client);
    (a as unknown as { defs: Map<string, Promise<unknown>> }).defs.set('0x' + '11'.repeat(32), Promise.resolve(def));
    await a.withdraw(wallet, id, 1);
    const d = decodeFunctionData({ abi: flowEngineAbi, data: writes[0].data });
    expect(d.functionName).toBe('withdraw');
    expect(d.args).toEqual([2n, 1, 60_000_000n]); // 60 USDG in 6-decimal base units
  });

  it('takes no new issuance', async () => {
    const { client, wallet } = fakes({});
    await expect(v3(client).issue(wallet, {} as never)).rejects.toThrow(/current engine/);
  });

  it('refuses a v4 note id', async () => {
    const { client } = fakes({ balanceOf: 0n });
    await expect(v3(client).claimable(noteId('arbitrum-sepolia', V4, 1n), ME, 1)).rejects.toThrow(/not a note on/);
  });
});

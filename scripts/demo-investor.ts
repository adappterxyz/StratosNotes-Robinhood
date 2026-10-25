/**
 * Demo autopilot for the investor side of a recorded demo, on Robinhood Chain testnet: the presenter issues a note in
 * the app (signing as the issuer, collateral pledged directly on Robinhood Chain); this subscribes the first demo investor (.keys/investor1.json) to it as soon as its book opens, and then
 * claims every payout to the investor's wallet (pushTo for itself: a receipt per claim) as soon as one is owed.
 *
 *   NAME='TSLA Reverse Convertible' UNITS=20 npx tsx scripts/demo-investor.ts
 *
 * It only touches notes on the current engine created after it starts whose name matches NAME, plus claiming any
 * USDG the investor is already owed (so it has the cash to subscribe). The investor needs Robinhood Chain testnet ETH
 * for gas and USDG (faucet.paxos.com) to subscribe. The key is read from a file, never printed.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodTestnet } from 'viem/chains';
import { CASH_TOKENS, decodeEvmDef, dec, evmInput } from '@sn/core';
import { engineAbi, flowEngineAbi, lensAbi } from '@sn/sdk';

const NAME = process.env.NAME ?? 'TSLA Reverse Convertible';
const UNITS = Number(process.env.UNITS ?? 20);
const raw = (JSON.parse(readFileSync('.keys/investor1.json', 'utf8')) as Array<{ private_key: string }>)[0].private_key;
const inv = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex);
const dep = JSON.parse(readFileSync('deployments/robinhood-testnet.json', 'utf8')) as {
  engine?: Address;
  lens?: Address;
};
if (!dep.engine || !dep.lens) throw new Error('deployments/robinhood-testnet.json has no engine yet: deploy first');
const engine = dep.engine;
const lens = dep.lens;
const t = http(process.env.RPC ?? 'https://rpc.testnet.chain.robinhood.com');
const pub = createPublicClient({ chain: robinhoodTestnet, transport: t });
const wal = createWalletClient({ chain: robinhoodTestnet, account: inv, transport: t });
const USDG = CASH_TOKENS['robinhood-testnet'];
const erc20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const NO = 0xffff;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const startCount = (await pub.readContract({
  address: engine,
  abi: engineAbi,
  functionName: 'processCount',
})) as bigint;
log(`investor ${inv.address}; watching notes after pid ${startCount} named "${NAME}"`);
const subscribed = new Set<bigint>();
const defs = new Map<string, ReturnType<typeof decodeEvmDef>>();

async function claimAll(upTo: bigint) {
  for (let pid = 1n; pid <= upTo; pid++) {
    const owed = (await pub
      .readContract({
        address: engine,
        abi: flowEngineAbi,
        functionName: 'pendingOf',
        args: [pid, inv.address, 1n],
      })
      .catch(() => 0n)) as bigint;
    if (owed <= 0n) continue;
    try {
      const h = await wal.writeContract({
        address: engine,
        abi: flowEngineAbi,
        functionName: 'pushTo',
        args: [pid, 1, [inv.address]],
      });
      await pub.waitForTransactionReceipt({ hash: h });
      log(`claimed note ${pid} payout to the wallet (${h})`);
    } catch (e) {
      log(`claim on ${pid} failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

async function trySubscribe(pid: bigint) {
  const proc = (await pub
    .readContract({ address: engine, abi: engineAbi, functionName: 'processOf', args: [pid] })
    .catch(() => null)) as { definition: Hex } | null;
  const id = proc?.definition;
  if (!id) return;
  if (!defs.has(id)) {
    const bytes = (await pub.readContract({
      address: lens,
      abi: lensAbi,
      functionName: 'definitionBytes',
      args: [id],
    })) as Hex;
    if (bytes === '0x') return;
    defs.set(id, decodeEvmDef(Uint8Array.from(Buffer.from(bytes.slice(2), 'hex'))));
  }
  const def = defs.get(id)!;
  if (!def.name.includes(NAME)) return;
  const step = def.steps.findIndex((s) => s.id === 'Task_Subscribe');
  if (step < 0) return;
  const cost = BigInt(UNITS) * 10n ** 6n;
  try {
    await wal
      .writeContract({ address: USDG, abi: erc20, functionName: 'approve', args: [engine, cost] })
      .then((h) => pub.waitForTransactionReceipt({ hash: h }));
    const { request } = await pub.simulateContract({
      account: inv,
      address: engine,
      abi: engineAbi,
      functionName: 'executeStep',
      args: [pid, step, NO, [evmInput.number(dec(UNITS))]],
    });
    const h = await wal.writeContract(request);
    await pub.waitForTransactionReceipt({ hash: h });
    subscribed.add(pid);
    log(`subscribed ${UNITS} units to note ${pid} (${h})`);
  } catch (e) {
    log(`subscribe to ${pid} not yet: ${(e as Error).message.split('\n')[0]}`);
  }
}

for (;;) {
  try {
    const n = (await pub.readContract({ address: engine, abi: engineAbi, functionName: 'processCount' })) as bigint;
    await claimAll(n);
    for (let pid = startCount + 1n; pid <= n; pid++) if (!subscribed.has(pid)) await trySubscribe(pid);
  } catch (e) {
    log('tick error', (e as Error).message.split('\n')[0]);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}

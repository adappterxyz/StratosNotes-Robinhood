/**
 * Issue the e2e note on a local fork: register + publish the definition, start the process, fix the pre-trade
 * terms (strike STRIKE_IN seconds from now, observations OBS_EVERY apart, settlement lag LAG and grace GRACE
 * seconds) and pledge USDC collateral at the note's ratio into escrow, mandate the paying agent, and subscribe
 * two investors (their USDC goes to the issuer). Optionally make account 9 the engine's fallback reporter.
 *
 *   RPC=http://127.0.0.1:8545 CHAIN_ID=421614 DEPLOYMENT=deployments/local/x.json USDC=0x... \
 *   STRIKE_IN=120 OBS_EVERY=60 FALLBACK=1 OUT=/tmp/note.json npx tsx scripts/e2e/issue.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseAbi, toHex, zeroAddress, type Address } from 'viem';
import { dec, economicsOf, evmInput } from '@sn/core';
import { engineAbi, lensAbi } from '@sn/sdk';
import { acct, approveInputs, clients, compiled, NOTE } from './lib';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`set ${k}`);
  return v;
};
const dep = JSON.parse(readFileSync(env('DEPLOYMENT'), 'utf8')) as { engine: Address; lens: Address };
const usdc = env('USDC') as Address;
const { client, wallet } = clients(env('RPC'), Number(env('CHAIN_ID')));
const erc20 = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const NO = 0xffff;

async function send(i: number, req: Parameters<ReturnType<typeof wallet>['writeContract']>[0]) {
  // Simulate first, so a revert reports its reason instead of a bare status.
  await client.simulateContract({ ...(req as object), account: acct(i) } as never);
  const hash = await wallet(i).writeContract(req as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${req.functionName}`);
  return r;
}

const { c } = compiled();
const def = toHex(c.bytes);
const definition = toHex(c.hash);
const roleIdx = (name: string) => c.def.roles.indexOf(name);
const issuer = acct(1).address,
  pa = acct(2).address;
const investors = [
  { i: 3, units: 600 },
  { i: 4, units: 400 },
];
const notional = investors.reduce((a, b) => a + b.units, 0);
const ratio = economicsOf(NOTE).collateralRatioPct / 100;
const pledge = Math.ceil(notional * ratio); // USDC collateral, exactly covering the requirement

await send(0, { address: dep.engine, abi: engineAbi, functionName: 'registerDefinition', args: [def] });
await send(0, { address: dep.lens, abi: lensAbi, functionName: 'publish', args: [def] });
if (process.env.FALLBACK === '1')
  await send(0, { address: dep.engine, abi: engineAbi, functionName: 'setFallbackReporter', args: [acct(9).address] });

const roles: Address[] = c.def.roles.map(() => zeroAddress);
roles[roleIdx('Issuer')] = issuer;
roles[roleIdx('Paying Agent')] = pa; // the Investor role stays open: anyone may subscribe
const assetTokens: Address[] = c.def.assets.map((a) => (a.kind === 1 ? usdc : zeroAddress)); // cash and USDC collateral
const startReceipt = await send(1, {
  address: dep.engine,
  abi: engineAbi,
  functionName: 'startProcess',
  args: [definition, 1n, roles, assetTokens, c.stepIndex.Start_Issuer, [], 'notes.markets ETH Phoenix e2e', 'nmETH1'],
});
const pid = await client.readContract({ address: dep.engine, abi: engineAbi, functionName: 'processCount' });

const now = Number((await client.getBlock()).timestamp);
const strikeAt = now + Number(env('STRIKE_IN', '120'));
const every = Number(env('OBS_EVERY', '60'));
const obsAt = Array.from({ length: NOTE.observations }, (_, k) => strikeAt + every * (k + 1));
const lag = Number(env('LAG', String(Math.floor(every / 4)))),
  grace = Number(env('GRACE', String(Math.floor(every / 3))));
await send(1, { address: usdc, abi: erc20, functionName: 'mint', args: [issuer, BigInt(pledge) * 10n ** 6n] });
await send(1, { address: usdc, abi: erc20, functionName: 'approve', args: [dep.engine, 2n ** 255n] });
await send(1, {
  address: dep.engine,
  abi: engineAbi,
  functionName: 'executeStep',
  args: [
    pid,
    c.stepIndex.Task_ApproveTerms,
    NO,
    approveInputs(c, {
      isin: evmInput.text(`XSE2E${String(now).slice(-6)}`),
      notional: evmInput.number(dec(notional)),
      strikeDate: evmInput.number(BigInt(strikeAt)),
      ...Object.fromEntries(obsAt.map((t, k) => [`obsDate${k + 1}`, evmInput.number(BigInt(t))])),
      lag: evmInput.number(BigInt(lag)),
      grace: evmInput.number(BigInt(grace)),
      collateralRatio: evmInput.number(dec(ratio)),
      haircut_USD: evmInput.number(dec(1)),
      pledge_USD: evmInput.number(dec(pledge)),
    }),
  ],
});
await send(1, {
  address: dep.engine,
  abi: engineAbi,
  functionName: 'executeStep',
  args: [pid, c.stepIndex.Task_Mandate, NO, []],
});
for (const inv of investors) {
  const cash = BigInt(Math.round((inv.units * NOTE.issuePricePct) / 100)) * 10n ** 6n;
  await send(inv.i, { address: usdc, abi: erc20, functionName: 'mint', args: [acct(inv.i).address, cash] });
  await send(inv.i, { address: usdc, abi: erc20, functionName: 'approve', args: [dep.engine, cash] });
  await send(inv.i, {
    address: dep.engine,
    abi: engineAbi,
    functionName: 'executeStep',
    args: [pid, c.stepIndex.Task_Subscribe, NO, [evmInput.number(dec(inv.units))]],
  });
}

const out = {
  pid: pid.toString(),
  definition,
  engine: dep.engine,
  lens: dep.lens,
  usdc,
  fromBlock: startReceipt.blockNumber.toString(),
  strikeAt,
  obsAt,
  lag,
  grace,
  pledge,
  investors: investors.map((v) => ({ address: acct(v.i).address, units: v.units })),
  issuer,
  pa,
};
writeFileSync(env('OUT'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));

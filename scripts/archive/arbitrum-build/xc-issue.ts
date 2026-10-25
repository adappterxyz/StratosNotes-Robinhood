/**
 * Issue a note whose only collateral is a HomeGateway v2 receipt (TSLA.rh) on a local ANVIL FORK of Arbitrum Sepolia,
 * against the live engine and gateway, for scripts/e2e-xc-autorelease.sh. Fork only: it impersonates the engine
 * owner (fallback reporter = anvil account 9, email check off) and the gateway (mints the receipts a CCIP lock would),
 * and uses a mock ERC-20 as the cash leg. Accounts are anvil's public test accounts; no real key is read.
 *
 *   RPC=http://127.0.0.1:8545 USDC=0x... STRIKE_IN=120 OBS_EVERY=120 OUT=/tmp/note.json npx tsx scripts/e2e/xc-issue.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { encodeFunctionData, parseAbi, parseEther, toHex, zeroAddress, type Address } from 'viem';
import { dec, EXAMPLE_PRODUCTS, evmInput, FEEDS, type ProductParams } from '@sn/core';
import { engineAbi, lensAbi } from '@sn/sdk';
import { acct, approveInputs, clients, compiled } from './lib';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`set ${k}`);
  return v;
};
const dep = JSON.parse(readFileSync('deployments/arbitrum-sepolia.json', 'utf8')) as {
  engine: Address;
  lens: Address;
  owner: Address;
  verifier: Address;
};
const xc = JSON.parse(readFileSync('deployments/crosschain-testnet.json', 'utf8')) as {
  home: { gateway: Address; engine: Address };
  remotes: Array<{ receipts: Record<string, { receipt: Address }> }>;
};
if (xc.home.engine.toLowerCase() !== dep.engine.toLowerCase()) throw new Error('the gateway serves another engine');
const RECEIPT = xc.remotes[0].receipts['TSLA.rh'].receipt;
const usdc = env('USDC') as Address;
const rpc = env('RPC');
const { client, wallet } = clients(rpc, 421614);
if (
  (await client.getChainId()) !== 421614 ||
  !((await client.request({ method: 'web3_clientVersion' } as never)) as string).toLowerCase().includes('anvil')
)
  throw new Error('not an anvil fork of Arbitrum Sepolia');
const NO = 0xffff;
const erc20 = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const adminAbi = parseAbi([
  'function setFallbackReporter(address next)',
  'function setEmailPolicy(address verifier, bool requireEmail)',
  'function fallbackReporter() view returns (address)',
]);
const receiptAbi = parseAbi(['function mint(address to, uint256 amount)']);

/** Send as any address (anvil impersonation). */
async function as(from: Address, req: { address: Address; abi: unknown; functionName: string; args: unknown[] }) {
  await client.request({ method: 'anvil_impersonateAccount', params: [from] } as never);
  await client.request({ method: 'anvil_setBalance', params: [from, toHex(parseEther('1'))] } as never);
  const hash = (await client.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: req.address, data: encodeFunctionData(req as never) }],
  } as never)) as `0x${string}`;
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${req.functionName} as ${from}`);
}
async function send(i: number, req: { address: Address; abi: unknown; functionName: string; args: unknown[] }) {
  await client.simulateContract({ ...(req as object), account: acct(i) } as never);
  const hash = await wallet(i).writeContract(req as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${req.functionName}`);
  return r;
}

const product: ProductParams = {
  ...EXAMPLE_PRODUCTS.phoenix,
  name: 'XC auto-release e2e: Phoenix on TSLA',
  underlyings: [FEEDS.TSLA],
  observations: 2,
  autocallFromPeriod: 2,
  chain: 'arbitrum-sepolia',
  collateralChain: 'robinhood',
  collateral: [{ symbol: 'TSLA', haircutPct: 60 }],
} as ProductParams;
const { c } = compiled(product);
const roleIdx = (name: string) => c.def.roles.indexOf(name);
const issuer = acct(1).address,
  pa = acct(2).address;
const investors = [
  { i: 3, units: 600 },
  { i: 4, units: 400 },
];
const notional = investors.reduce((a, b) => a + b.units, 0);
const PLEDGE = BigInt(env('PLEDGE_TSLA', '10')); // TSLA.rh; ~$4k at 60% haircut covers the 1,000 notional

if (
  (await client.readContract({ address: dep.engine, abi: adminAbi, functionName: 'fallbackReporter' })) !==
  acct(9).address
) {
  await as(dep.owner, {
    address: dep.engine,
    abi: adminAbi,
    functionName: 'setFallbackReporter',
    args: [acct(9).address],
  });
  await as(dep.owner, {
    address: dep.engine,
    abi: adminAbi,
    functionName: 'setEmailPolicy',
    args: [dep.verifier, false],
  });
}
// The receipts a CCIP LOCKED message would mint (the gateway is their only minter).
await as(xc.home.gateway, {
  address: RECEIPT,
  abi: receiptAbi,
  functionName: 'mint',
  args: [issuer, PLEDGE * 10n ** 18n],
});

await send(0, { address: dep.engine, abi: engineAbi, functionName: 'registerDefinition', args: [toHex(c.bytes)] });
await send(0, { address: dep.lens, abi: lensAbi, functionName: 'publish', args: [toHex(c.bytes)] });
const roles: Address[] = c.def.roles.map(() => zeroAddress);
roles[roleIdx('Issuer')] = issuer;
roles[roleIdx('Paying Agent')] = pa;
const assetTokens: Address[] = c.def.assets.map((a) =>
  a.kind !== 1 ? zeroAddress : a.name.includes('TSLA.rh') ? RECEIPT : usdc,
);
if (!assetTokens.includes(RECEIPT))
  throw new Error(`no TSLA.rh asset in ${c.def.assets.map((a) => a.name).join(', ')}`);
const start = await send(1, {
  address: dep.engine,
  abi: engineAbi,
  functionName: 'startProcess',
  args: [toHex(c.hash), 1n, roles, assetTokens, c.stepIndex.Start_Issuer, [], 'notes.markets XC e2e', 'nmXCE'],
});
const pid = await client.readContract({ address: dep.engine, abi: engineAbi, functionName: 'processCount' });

const now = Number((await client.getBlock()).timestamp);
const strikeAt = now + Number(env('STRIKE_IN', '120'));
const every = Number(env('OBS_EVERY', '120'));
const obsAt = Array.from({ length: product.observations }, (_, k) => strikeAt + every * (k + 1));
const lag = Number(env('LAG', String(Math.floor(every / 2)))),
  grace = Number(env('GRACE', String(Math.floor(every / 2))));
await send(1, { address: RECEIPT, abi: erc20, functionName: 'approve', args: [dep.engine, PLEDGE * 10n ** 18n] });
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
      isin: evmInput.text(`XSXC${String(now).slice(-6)}`),
      notional: evmInput.number(dec(notional)),
      strikeDate: evmInput.number(BigInt(strikeAt)),
      ...Object.fromEntries(obsAt.map((t, k) => [`obsDate${k + 1}`, evmInput.number(BigInt(t))])),
      lag: evmInput.number(BigInt(lag)),
      grace: evmInput.number(BigInt(grace)),
      collateralRatio: evmInput.number(dec(1)),
      haircut_TSLA: evmInput.number(dec(0.6)),
      pledge_TSLA: evmInput.number(dec(PLEDGE)),
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
  const cash = BigInt(Math.round((inv.units * product.issuePricePct) / 100)) * 10n ** 6n;
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
  engine: dep.engine,
  lens: dep.lens,
  gateway: xc.home.gateway,
  receipt: RECEIPT,
  usdc,
  fromBlock: start.blockNumber.toString(),
  strikeAt,
  obsAt,
  lag,
  grace,
  pledge: PLEDGE.toString(),
  issuer,
  investors: investors.map((v) => ({ address: acct(v.i).address, units: v.units })),
};
writeFileSync(env('OUT'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));

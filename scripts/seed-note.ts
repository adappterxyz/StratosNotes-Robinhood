/**
 * Issue one short-dated demo note on a real testnet and fill part of its book, so the marketplace has something
 * live and CRE has something to run:
 *
 *   NOTE=crypto STRIKE_IN=900 OBS_EVERY=300 npx tsx scripts/seed-note.ts
 *   NOTE=equity npx tsx scripts/seed-note.ts
 *
 * Every note is issued on Robinhood Chain testnet (CHAIN=robinhood-testnet, the only one; RPC overrides its RPC, e.g.
 * a local fork with DEPLOY_DIR naming its deployment). NOTE=crypto: a worst-of phoenix on ETH and BTC; NOTE=equity:
 * on TSLA and NVDA, cash-settled (NVDA has no token on Robinhood Chain; Chainlink feeds on Robinhood Chain mainnet,
 * market hours: outside them the observations see the last close).
 * Cash and collateral are Paxos's testnet USDG on Robinhood Chain (notes.markets mints nothing): the deployer key
 * (.keys/deployer.json), issuer and paying agent, must already hold enough of it (faucet.paxos.com). It pledges USDG
 * collateral covering 100% of the notional into the note's escrow at Approve Terms. Two demo investors
 * (.keys/investor1.json, investor2.json, created if missing) get a little ETH for gas and their USDG from the
 * deployer, and subscribe 600 and 400 units; UNSOLD units stay open for visitors.
 * CASH=tUSD: the retired test dollar instead (local forks of an old deployment only: the deployer mints it).
 * The issuer funds each payment as it falls due with scripts/issuer-bot.ts (run it alongside the keeper; with
 * MISS=pid:period a demo note shows a default). LAG and GRACE: seconds (default OBS_EVERY / 4 and / 3).
 * Keys are read from files and never printed. Writes deployments/notes/<chain>-<pid>.json.
 *
 * Verified emails: when the engine has requireEmail on, the issuer and the demo investors need an email
 * attestation. These are operator-run demo accounts, so the operator's verifier key (.keys/verifier.json) attests
 * them directly to demo identities (demo-<role>@notes.markets, salted); real people verify in the app.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CASH_TOKENS,
  compile,
  dec,
  EXAMPLE_PRODUCTS,
  evmInput,
  FEEDS,
  instantiateProduct,
  parseBpmn,
  SRC,
  type EvmInput,
  type ProductParams,
} from '@sn/core';
import { engineAbi, flowEngineAbi, lensAbi } from '@sn/sdk';

const RPCS: Record<string, { rpc: string; id: number }> = {
  'robinhood-testnet': { rpc: process.env.RPC ?? 'https://rpc.testnet.chain.robinhood.com', id: 46630 },
};
const chainKey = process.env.CHAIN ?? 'robinhood-testnet';
const net = RPCS[chainKey];
if (!net) throw new Error(`CHAIN: ${Object.keys(RPCS).join(' | ')}`);
const DIR = process.env.DEPLOY_DIR ?? 'deployments';
const dep = JSON.parse(readFileSync(`${DIR}/${chainKey}.json`, 'utf8')) as {
  engine: Address;
  lens: Address;
  faucet: Address;
  tokens: Record<string, Address>;
};
if (!dep.engine) throw new Error(`${DIR}/${chainKey}.json has no engine yet: run scripts/deploy-testnets.sh first`);
/** Paxos testnet USDG is the cash leg and the collateral (default); the deployer must already hold it (faucet.paxos.com),
 * and funds the demo investors from its own balance. CASH=tUSD: the retired test dollar, minted by the deployer. */
const usdg = process.env.CASH !== 'tUSD';
const tusd = usdg ? (CASH_TOKENS[chainKey] as Address) : dep.tokens.tUSD;
if (!tusd) throw new Error(`no ${usdg ? 'USDG' : 'tUSD'} on ${chainKey}`);
const CASH = usdg ? 'USDG' : 'tUSD';

const keyFrom = (file: string): Hex => {
  if (!existsSync(file)) execFileSync('bash', ['-c', `umask 077 && cast wallet new --json > ${file}`]);
  const k = (JSON.parse(readFileSync(file, 'utf8')) as Array<{ private_key: string }>)[0].private_key;
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const deployer = privateKeyToAccount(keyFrom('.keys/deployer.json'));
const investors = [
  privateKeyToAccount(keyFrom('.keys/investor1.json')),
  privateKeyToAccount(keyFrom('.keys/investor2.json')),
];

const chain = defineChain({
  id: net.id,
  name: chainKey,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [net.rpc] } },
});
const client = createPublicClient({ chain, transport: http(net.rpc) });
const walletOf = (a: typeof deployer) => createWalletClient({ chain, account: a, transport: http(net.rpc) });
const erc20 = parseAbi([
  'function mint(address to, uint256 amount)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const faucetAbi = parseAbi([
  'function claim(address token)',
  'function nextClaimAt(address token, address account) view returns (uint256)',
]);
const NO = 0xffff;

async function send(a: typeof deployer, req: Record<string, unknown>) {
  const hash = await walletOf(a).writeContract(req as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${String(req.functionName)} (${hash})`);
  console.log(`  ${String(req.functionName).padEnd(18)} ${hash}`);
  return r;
}

const product: ProductParams =
  process.env.NOTE === 'equity'
    ? {
        ...EXAMPLE_PRODUCTS.phoenix,
        name: 'Demo Worst-of Phoenix on TSLA, NVDA',
        underlyings: [FEEDS.TSLA, FEEDS.NVDA],
        observations: 3,
        settlement: 'cash',
      }
    : {
        ...EXAMPLE_PRODUCTS.phoenix,
        name: 'Demo Worst-of Phoenix on ETH, BTC',
        underlyings: [FEEDS.ETH, FEEDS.BTC],
        observations: 3,
      };
const prod = instantiateProduct(product);
const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
const def = toHex(c.bytes);
const definition = toHex(c.hash);
const roleIdx = (name: string) => c.def.roles.indexOf(name);
const subs = (process.env.SUBS ?? '600,400').split(',').map(Number);
const unsold = Number(process.env.UNSOLD ?? 1000);
const notional = subs.reduce((a, b) => a + b, 0) + unsold;
const ratio = Number(process.env.RATIO ?? 1); // collateral ratio (1 = 100% of the notional)
const pledge = Math.ceil(notional * ratio);

console.log(
  `${product.name} on ${chainKey}: ${notional} units (${unsold} left for visitors), ${pledge} ${CASH} collateral pledged (ratio ${ratio * 100}%)`,
);
// Both are content-addressed and idempotent: re-running for the same design is a cheap no-op.
await send(deployer, { address: dep.engine, abi: engineAbi, functionName: 'registerDefinition', args: [def] });
await send(deployer, { address: dep.lens, abi: lensAbi, functionName: 'publish', args: [def] });

/** Attest a demo account's email on-chain (submitted by the deployer) when the engine requires one. */
const verifier = existsSync('.keys/verifier.json') ? privateKeyToAccount(keyFrom('.keys/verifier.json')) : null;
async function attestDemo(holder: Address, label: string) {
  const required = await client
    .readContract({ address: dep.engine, abi: flowEngineAbi, functionName: 'requireEmail' })
    .catch(() => false);
  if (!required) return;
  const [, until, nonce] = (await client.readContract({
    address: dep.engine,
    abi: flowEngineAbi,
    functionName: 'emailOf',
    args: [holder],
  })) as readonly [Hex, bigint, bigint];
  if (Number(until) > Date.now() / 1000 + 30 * 86_400) return;
  if (!verifier) throw new Error('the engine requires verified emails: .keys/verifier.json is missing');
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const emailHash = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [salt, `demo-${label}@notes.markets`]),
  );
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400);
  const signature = await verifier.signTypedData({
    domain: { name: 'notes.markets', version: '1', chainId: net.id, verifyingContract: dep.engine },
    types: {
      EmailAttestation: [
        { name: 'holder', type: 'address' },
        { name: 'emailHash', type: 'bytes32' },
        { name: 'expiry', type: 'uint64' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'EmailAttestation',
    message: { holder, emailHash, expiry, nonce },
  });
  await send(deployer, {
    address: dep.engine,
    abi: flowEngineAbi,
    functionName: 'attestEmail',
    args: [holder, emailHash, expiry, signature],
  });
}
await attestDemo(deployer.address, 'issuer');

const roles: Address[] = c.def.roles.map(() => zeroAddress);
roles[roleIdx('Issuer')] = deployer.address;
roles[roleIdx('Paying Agent')] = deployer.address; // the Investor role stays open
const assetTokens: Address[] = c.def.assets.map((a) => (a.kind === 1 ? tusd : zeroAddress)); // cash and tUSD collateral
const start = await send(deployer, {
  address: dep.engine,
  abi: engineAbi,
  functionName: 'startProcess',
  args: [
    definition,
    BigInt(Date.now()),
    roles,
    assetTokens,
    c.stepIndex.Start_Issuer,
    [],
    `notes.markets ${product.name}`.slice(0, 64),
    'nmDEMO',
  ],
});
const pid = await client.readContract({ address: dep.engine, abi: engineAbi, functionName: 'processCount' });

const now = Number((await client.getBlock()).timestamp);
const strikeAt = now + Number(process.env.STRIKE_IN ?? 900);
const every = Number(process.env.OBS_EVERY ?? 300);
const obsAt = Array.from({ length: product.observations }, (_, k) => strikeAt + every * (k + 1));
const lag = Number(process.env.LAG ?? Math.floor(every / 4)),
  grace = Number(process.env.GRACE ?? Math.floor(every / 3));
if (usdg) {
  const need = BigInt(pledge + subs.reduce((a, b) => a + b, 0)) * 10n ** 6n;
  const have = await client.readContract({
    address: tusd,
    abi: erc20,
    functionName: 'balanceOf',
    args: [deployer.address],
  });
  if (have < need)
    throw new Error(
      `the deployer holds ${Number(have) / 1e6} USDG; this seed needs ${Number(need) / 1e6} (collateral + investors): claim more at faucet.paxos.com`,
    );
} else {
  await send(deployer, {
    address: tusd,
    abi: erc20,
    functionName: 'mint',
    args: [deployer.address, BigInt(pledge) * 10n ** 6n],
  });
}
await send(deployer, {
  address: tusd,
  abi: erc20,
  functionName: 'approve',
  args: [dep.engine, BigInt(pledge) * 10n ** 6n],
});
const byName: Record<string, EvmInput> = {
  isin: evmInput.text(`XSDEMO${String(now).slice(-6)}`),
  notional: evmInput.number(dec(notional)),
  strikeDate: evmInput.number(BigInt(strikeAt)),
  ...Object.fromEntries(obsAt.map((t, k) => [`obsDate${k + 1}`, evmInput.number(BigInt(t))])),
  lag: evmInput.number(BigInt(lag)),
  grace: evmInput.number(BigInt(grace)),
  collateralRatio: evmInput.number(dec(ratio)),
  haircut_USD: evmInput.number(dec(1)),
  pledge_USD: evmInput.number(dec(pledge)),
};
const approve = c.def.steps[c.stepIndex.Task_ApproveTerms].captures
  .filter((x) => x.source === SRC.INPUT)
  .map((x) => byName[c.def.fields[x.field].name]);
await send(deployer, {
  address: dep.engine,
  abi: engineAbi,
  functionName: 'executeStep',
  args: [pid, c.stepIndex.Task_ApproveTerms, NO, approve],
});
await send(deployer, {
  address: dep.engine,
  abi: engineAbi,
  functionName: 'executeStep',
  args: [pid, c.stepIndex.Task_Mandate, NO, []],
});

for (const [i, inv] of investors.entries()) {
  await attestDemo(inv.address, `investor${i + 1}`);
  const units = subs[i];
  const cash = BigInt(units) * 10n ** 6n; // issue price 100%
  if ((await client.getBalance({ address: inv.address })) < parseEther('0.0005')) {
    const hash = await walletOf(deployer).sendTransaction({ to: inv.address, value: parseEther('0.001') } as never);
    await client.waitForTransactionReceipt({ hash });
    console.log(`  gas for investor ${i + 1}  ${hash}`);
  }
  if (
    (await client.readContract({ address: tusd, abi: erc20, functionName: 'balanceOf', args: [inv.address] })) < cash
  ) {
    // USDG can't be minted by us: the deployer sends the investor what it subscribes with.
    if (usdg) await send(deployer, { address: tusd, abi: erc20, functionName: 'transfer', args: [inv.address, cash] });
    else await send(inv, { address: dep.faucet, abi: faucetAbi, functionName: 'claim', args: [tusd] });
  }
  await send(inv, { address: tusd, abi: erc20, functionName: 'approve', args: [dep.engine, cash] });
  await send(inv, {
    address: dep.engine,
    abi: engineAbi,
    functionName: 'executeStep',
    args: [pid, c.stepIndex.Task_Subscribe, NO, [evmInput.number(dec(units))]],
  });
}

const out = {
  chain: chainKey,
  pid: pid.toString(),
  name: product.name,
  definition,
  engine: dep.engine,
  fromBlock: start.blockNumber.toString(),
  cash: CASH,
  ratio,
  issuer: { address: deployer.address, label: 'notes.markets demo issuer (temporary: deployer key)' },
  strikeAt,
  obsAt,
  lag,
  grace,
  pledge,
  investors: investors.map((a, i) => ({ address: a.address, units: subs[i] })),
  unsold,
};
mkdirSync(`${DIR}/notes`, { recursive: true });
writeFileSync(`${DIR}/notes/${chainKey}-${pid}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`note ${chainKey}:${dep.engine.toLowerCase()}:${pid}  strike ${new Date(strikeAt * 1000).toISOString()}`);

/**
 * Check scripts/e2e-xc-autorelease.sh: after the notes ended, no receipt waits in the engine, every receipt that
 * left it queued a release (the paid-in-full note's to the issuer, the defaulted note's to each holder, plus the
 * issuer's excess), and the bot's fallback flush sent them only after FLUSH_AFTER seconds.
 *
 *   RPC=... PAID=/tmp/a.json DEFAULTED=/tmp/b.json FLUSH_AFTER=180 [STATUS_ONLY=1] npx tsx scripts/e2e/xc-verify.ts
 */
import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { releaseEventsAbi } from '@sn/core';
import { engineAbi } from '@sn/sdk';
import { clients } from './lib';

const env = (k: string) => {
  const v = process.env[k];
  if (v === undefined) throw new Error(`set ${k}`);
  return v;
};
type Note = {
  pid: string;
  engine: Address;
  gateway: Address;
  receipt: Address;
  fromBlock: string;
  issuer: Address;
  investors: Array<{ address: Address }>;
};
const paid = JSON.parse(readFileSync(env('PAID'), 'utf8')) as Note;
const defaulted = JSON.parse(readFileSync(env('DEFAULTED'), 'utf8')) as Note;
const { client } = clients(env('RPC'), 421614);
const status = async (n: Note) =>
  (await client.readContract({ address: n.engine, abi: engineAbi, functionName: 'processOf', args: [BigInt(n.pid)] }))
    .status;

if (process.env.STATUS_ONLY === '1') {
  console.log(`${await status(paid)} ${await status(defaulted)}`);
  process.exit(0);
}

let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const flushAfter = Number(process.env.FLUSH_AFTER ?? 180);
const fromBlock = BigInt(paid.fromBlock < defaulted.fromBlock ? paid.fromBlock : defaulted.fromBlock);
const [queued, sent] = await Promise.all([
  client.getContractEvents({ address: paid.gateway, abi: releaseEventsAbi, eventName: 'ReleaseQueued', fromBlock }),
  client.getContractEvents({ address: paid.gateway, abi: releaseEventsAbi, eventName: 'ReleaseSent', fromBlock }),
]);
const time = async (b: bigint) => Number((await client.getBlock({ blockNumber: b })).timestamp);
const ASSET = 2; // Collateral TSLA.rh

for (const [label, n] of [
  ['paid in full', paid],
  ['defaulted', defaulted],
] as const) {
  const st = await status(n);
  check(st !== 0, `${label} note ${n.pid} ended (status ${st})`);
  const vault = await client.readContract({
    address: n.engine,
    abi: engineAbi,
    functionName: 'vaultOf',
    args: [BigInt(n.pid), BigInt(ASSET)],
  });
  check(vault === 0n, `${label}: no TSLA.rh left in the engine (vault ${vault})`);
}
const issuerQ = queued.filter((l) => l.args.account!.toLowerCase() === paid.issuer.toLowerCase());
check(
  issuerQ.length >= 1,
  `paid in full: release(s) queued to the issuer ${paid.issuer} (${issuerQ.map((l) => `#${l.args.index} ${l.args.added}`).join(', ')})`,
);
for (const inv of defaulted.investors) {
  const q = queued.filter((l) => l.args.account!.toLowerCase() === inv.address.toLowerCase());
  check(
    q.length >= 1,
    `default: release queued to holder ${inv.address} (${q.map((l) => `#${l.args.index} ${l.args.added}`).join(', ')})`,
  );
}
const firsts = [...new Map(queued.map((l) => [l.args.index!, l] as const)).values()].map((l) =>
  queued.find((x) => x.args.index === l.args.index)!,
);
for (const l of firsts) {
  const s = sent.find((x) => x.args.index === l.args.index);
  if (!s) {
    check(false, `release #${l.args.index} sent`);
    continue;
  }
  const waited = (await time(s.blockNumber)) - (await time(l.blockNumber));
  check(
    waited > flushAfter,
    `release #${l.args.index} sent by the fallback flush after ${waited} s (> FLUSH_AFTER ${flushAfter} s; CRE is not running on the fork), CCIP message ${s.args.messageId}`,
  );
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

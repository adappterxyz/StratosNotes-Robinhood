/**
 * Check a finished e2e note against the reference: the strikes and observations are the values the reports
 * actually carried (ReportProcessed); with the issuer funding every payment, each holder's cash must equal
 * units x the reference payoff per unit and the pledged collateral must be back with the issuer; with a payment
 * left unfunded (MISS=pid:period), the note must have defaulted and each holder must hold the coupons paid
 * before it plus its pro-rata share of the collateral (simulateNote). Every report must come from the expected
 * reporter (the forwarder for CRE, or the fallback).
 *
 *   RPC=... CHAIN_ID=421614 NOTE_JSON=/tmp/note.json EXPECT_REPORTER=0x... [MISS=1:1] npx tsx scripts/e2e/verify.ts
 *   STATUS_ONLY=1 ... prints the process status (0 running, 1 completed) and exits.
 */
import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { MILESTONE_NAMES, simulateNote, simulateWorstOf, totalPerUnit } from '@sn/core';
import { engineAbi } from '@sn/sdk';
import { clients, compiled, NOTE } from './lib';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const note = JSON.parse(readFileSync(env('NOTE_JSON'), 'utf8')) as {
  pid: string;
  engine: Address;
  fromBlock: string;
  investors: Array<{ address: Address; units: number }>;
  pa: Address;
  issuer: Address;
  pledge: number;
};
const { client } = clients(env('RPC'), Number(env('CHAIN_ID')));
const pid = BigInt(note.pid);
const proc = await client.readContract({
  address: note.engine,
  abi: engineAbi,
  functionName: 'processOf',
  args: [pid],
});
if (process.env.STATUS_ONLY) {
  console.log(proc.status);
  process.exit(0);
}

const { c } = compiled();
const logs = await client.getContractEvents({
  address: note.engine,
  abi: engineAbi,
  eventName: 'ReportProcessed',
  args: { pid },
  fromBlock: BigInt(note.fromBlock),
});
const byStep = new Map<number, bigint[]>();
const lines: string[] = [];
let ok = true;
const expectReporter = env('EXPECT_REPORTER').toLowerCase();
for (const l of logs) {
  const { step, values, reporter } = l.args as { step: number; values: readonly bigint[]; reporter: Address };
  const receipt = await client.getTransactionReceipt({ hash: l.transactionHash });
  const name = c.def.steps[step]?.id ?? (step === 0xffff ? 'advance' : String(step));
  lines.push(
    `report ${name} [${values.map((v) => (Number(v) / 1e10).toFixed(2)).join(', ')}] by ${reporter} in ${l.transactionHash} (tx gas ${receipt.gasUsed})`,
  );
  if (reporter.toLowerCase() !== expectReporter) {
    ok = false;
    lines.push(`  ! expected reporter ${expectReporter}`);
  }
  byStep.set(step, [...values]);
}
// The note's economic milestones in order (collateral pledged, funding deposited, payment made, missed, ...).
const ms = await client.getContractEvents({
  address: note.engine,
  abi: engineAbi,
  eventName: 'Milestone',
  args: { pid },
  fromBlock: BigInt(note.fromBlock),
});
lines.push(
  `milestones: ${ms.map((m) => `${MILESTONE_NAMES[(m.args as { code: number }).code] ?? (m.args as { code: number }).code}@${c.def.steps[(m.args as { step: number }).step]?.id}`).join(', ') || 'none'}`,
);
const strikes = byStep.get(c.stepIndex.Task_FixStrike)!.map((v) => Number(v) / 1e10);
const rows: number[][] = [];
for (let k = 1; k <= NOTE.observations; k++) {
  const v = byStep.get(c.stepIndex[`Task_Observe${k}`]);
  rows.push(v ? v.map((x) => Number(x) / 1e10) : strikes.map(() => 0)); // not observed: autocalled before
}
const ref = simulateWorstOf(NOTE, strikes, rows);
const sold = note.investors.reduce((a, v) => a + v.units, 0);
const missed = (process.env.MISS ?? '')
  .split(',')
  .map((x) => x.split(':'))
  .find(([p]) => p === note.pid)?.[1];
const out = simulateNote(NOTE, {
  perfs: rows.map((r) => Math.min(...r.map((o, i) => o / strikes[i]))),
  sold,
  ratio: 0,
  collateral: [{ symbol: 'USD', amount: note.pledge, haircut: 1, prices: rows.map(() => 1).concat([1]) }],
  ...(missed ? { behaviour: { missPayment: Number(missed) } } : {}),
});
const perUnit = out.perUnit.cash;
lines.push(
  `reference: coupons [${ref.coupons.join(', ')}], ${ref.calledAt ? `called at ${ref.calledAt}` : 'to maturity'}, redemption ${ref.redemptionCash} -> ${totalPerUnit(ref)} per unit if funded`,
);
lines.push(
  missed
    ? `issuer leaves payment ${missed} unfunded -> ${out.defaulted ? `default at ${out.defaulted.period}` : 'no default (nothing was due then)'}: ${perUnit} cash and ${out.perUnit.collateral.USD ?? 0} USDC collateral per unit`
    : 'issuer funds every payment',
);
if (proc.status !== 1) {
  ok = false;
  lines.push(`! process status ${proc.status}, expected completed (1)`);
}
const colAsset = BigInt(c.assetIndex.col_USD);
for (const inv of note.investors) {
  const cash = await client.readContract({
    address: note.engine,
    abi: engineAbi,
    functionName: 'balanceOf',
    args: [pid, inv.address, 1n],
  });
  const col = await client.readContract({
    address: note.engine,
    abi: engineAbi,
    functionName: 'balanceOf',
    args: [pid, inv.address, colAsset],
  });
  const want = inv.units * perUnit,
    wantCol = inv.units * (out.perUnit.collateral.USD ?? 0);
  const got = Number(cash) / 1e10,
    gotCol = Number(col) / 1e10;
  const good = Math.abs(got - want) <= inv.units * 5e-7 && Math.abs(gotCol - wantCol) <= inv.units * 5e-7;
  if (!good) ok = false;
  lines.push(
    `${inv.address} ${inv.units} units: paid ${got} USDC + ${gotCol} USDC collateral, reference ${want} + ${wantCol} -> ${good ? 'match' : 'MISMATCH'}`,
  );
}
const issuerCol =
  Number(
    await client.readContract({
      address: note.engine,
      abi: engineAbi,
      functionName: 'balanceOf',
      args: [pid, note.issuer, colAsset],
    }),
  ) / 1e10;
const wantIssuerCol = out.defaulted ? 0 : note.pledge;
const goodIssuer = Math.abs(issuerCol - wantIssuerCol) < 1e-6;
if (!goodIssuer) ok = false;
lines.push(
  `issuer collateral ${out.defaulted ? 'after the default' : 'released'}: ${issuerCol} USDC (want ${wantIssuerCol}) -> ${goodIssuer ? 'match' : 'MISMATCH'}`,
);
console.log(lines.join('\n'));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);

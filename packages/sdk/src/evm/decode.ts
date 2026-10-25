/**
 * EVM logs -> chain-neutral EngineEvents (events.ts). FieldSet values are decoded by their tag: numbers as
 * signed 256-bit integers (engine fixed point or plain), text as left-aligned UTF-8, parties as addresses.
 */
import { decodeEventLog, getAddress, type Hex } from 'viem';
import type { EngineEvent } from '../events';
import type { FieldValue } from '../model';
import { flowEngineAbi } from './generated';

export function fieldValue(tag: number, data: Hex): FieldValue {
  if (tag === 2) {
    const bytes = data
      .slice(2)
      .match(/../g)!
      .map((h) => parseInt(h, 16));
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return { tag: 2, value: new TextDecoder().decode(Uint8Array.from(bytes.slice(0, end))) };
  }
  if (tag === 3) return { tag: 3, value: getAddress(`0x${data.slice(-40)}`).toLowerCase() };
  return { tag: 1, value: BigInt.asIntN(256, BigInt(data)).toString() };
}

const lc = (a: string) => a.toLowerCase();

/**
 * Decode one engine log. `isFallback(reporter)` classifies ReportProcessed (the fallback reporter in force at
 * that point of the chain); anything else came through the KeystoneForwarder, i.e. Chainlink CRE.
 * Returns null for events the read model does not use (ownership, pause, forwarder admin).
 */
export function decodeEngineLog(
  log: { data: Hex; topics: readonly Hex[] },
  isFallback: (reporter: string) => boolean,
): EngineEvent | null {
  let d;
  try {
    d = decodeEventLog({ abi: flowEngineAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  } catch {
    return null;
  }
  const a = d.args as Record<string, unknown>;
  const s = (k: string) => String(a[k]);
  switch (d.eventName) {
    case 'DefinitionRegistered':
      return { name: 'DefinitionRegistered', id: lc(s('id')), creator: lc(s('creator')), meta: s('meta') };
    case 'ProcessStarted':
      return {
        name: 'ProcessStarted',
        pid: s('pid'),
        definition: lc(s('definition')),
        creator: lc(s('creator')),
        ref: s('ref'),
        roles: (a.roles as string[]).map(lc),
        assetTokens: (a.assetTokens as string[]).map(lc),
      };
    case 'StepRun':
      return { name: 'StepRun', pid: s('pid'), step: Number(a.step), kind: Number(a.kind), actor: lc(s('actor')) };
    case 'FieldSet':
      return {
        name: 'FieldSet',
        pid: s('pid'),
        field: Number(a.field),
        value: fieldValue(Number(a.tag), a.value as Hex),
      };
    case 'HoldingChanged':
      return {
        name: 'HoldingChanged',
        pid: s('pid'),
        asset: Number(a.asset),
        owner: lc(s('owner')),
        balance: s('balance'),
      };
    case 'TokensUpdated':
      return {
        name: 'TokensUpdated',
        pid: s('pid'),
        status: Number(a.status),
        stepsRun: Number(a.stepsRun),
        tokens: (a.tokens as number[]).map(Number),
      };
    case 'Deposited':
      return { name: 'Deposited', pid: s('pid'), asset: Number(a.asset), account: lc(s('from')), base: s('base') };
    case 'Withdrawn':
      return { name: 'Withdrawn', pid: s('pid'), asset: Number(a.asset), account: lc(s('to')), base: s('base') };
    case 'UnitsTransferred':
      return {
        name: 'UnitsTransferred',
        pid: s('pid'),
        asset: Number(a.asset),
        from: lc(s('from')),
        to: lc(s('to')),
        amount: s('amount'),
      };
    case 'NoteTokenCreated':
      return { name: 'NoteTokenCreated', pid: s('pid'), asset: Number(a.asset), token: lc(s('token')) };
    case 'DistributionRecorded':
      return {
        name: 'DistributionRecorded',
        pid: s('pid'),
        asset: Number(a.asset),
        period: Number(a.period),
        holding: Number(a.holding),
        step: Number(a.step),
        payer: lc(s('payer')),
        perUnit: s('perUnit'),
        total: s('total'),
        supply: s('supplyAtPayment'),
        retire: Boolean(a.retire),
        hash: lc(s('distributionHash')),
      };
    case 'PayoutPaid':
      return {
        name: 'PayoutPaid',
        pid: s('pid'),
        asset: Number(a.asset),
        period: Number(a.period),
        holder: lc(s('holder')),
        amount: s('amount'),
        payoutId: lc(s('payoutId')),
      };
    case 'PayoutDeferred':
      return {
        name: 'PayoutDeferred',
        pid: s('pid'),
        asset: Number(a.asset),
        period: Number(a.period),
        holder: lc(s('holder')),
        amount: s('amount'),
      };
    case 'DistributionSettled':
      return {
        name: 'DistributionSettled',
        pid: s('pid'),
        asset: Number(a.asset),
        period: Number(a.period),
        paidCount: Number(a.paidCount),
        paidTotal: s('paidTotal'),
        rollingHash: lc(s('rollingHash')),
      };
    case 'ReportProcessed': {
      const reporter = lc(s('reporter'));
      return {
        name: 'ReportProcessed',
        pid: s('pid'),
        step: Number(a.step),
        values: (a.values as bigint[]).map(String),
        reporter,
        via: isFallback(reporter) ? 'fallback' : 'cre',
      };
    }
    case 'ProcessCompleted':
      return { name: 'ProcessCompleted', pid: s('pid') };
    case 'Milestone':
      return { name: 'Milestone', pid: s('pid'), code: Number(a.code), step: Number(a.step), actor: lc(s('actor')) };
    case 'FallbackReporterUpdated':
      return { name: 'FallbackReporterUpdated', previous: lc(s('previous')), next: lc(s('next')) };
    case 'EmailAttested':
      return {
        name: 'EmailAttested',
        holder: lc(s('holder')),
        emailHash: lc(s('emailHash')),
        expiry: Number(a.expiry),
      };
    case 'EmailRevoked':
      return { name: 'EmailRevoked', holder: lc(s('holder')) };
    case 'EmailPolicyUpdated':
      return { name: 'EmailPolicyUpdated', verifier: lc(s('verifier')), requireEmail: Boolean(a.requireEmail) };
    default:
      return null;
  }
}

/**
 * Engine events, chain-neutral and JSON-safe (bigints as decimal strings), and the reducer that folds them
 * into a NoteState. The indexer stores these events and projects notes with `applyEvent`; replaying a note's
 * events in order rebuilds it exactly (which is how a reorg is undone). State events carry the absolute new
 * value (balance, tokens, field); only the report counters accumulate, so the indexer applies each stored
 * event once (insert-if-new) and rebuilds a note from scratch when it must undo events.
 *
 * EVM events map one to one (evm/decode.ts). A Canton adapter maps its ledger updates to the same events.
 */
import type { FieldValue, NoteState } from './model';
import { noteId } from './model';

const SCALE_BIG = 10_000_000_000n;

export type EngineEvent =
  | { name: 'DefinitionRegistered'; id: string; creator: string; meta: string }
  | {
      name: 'ProcessStarted';
      pid: string;
      definition: string;
      creator: string;
      ref: string;
      roles: string[];
      assetTokens: string[];
    }
  | { name: 'StepRun'; pid: string; step: number; kind: number; actor: string }
  | { name: 'FieldSet'; pid: string; field: number; value: FieldValue }
  | { name: 'HoldingChanged'; pid: string; asset: number; owner: string; balance: string }
  | { name: 'TokensUpdated'; pid: string; status: number; stepsRun: number; tokens: number[] }
  | { name: 'Deposited'; pid: string; asset: number; account: string; base: string }
  | { name: 'Withdrawn'; pid: string; asset: number; account: string; base: string }
  | { name: 'UnitsTransferred'; pid: string; asset: number; from: string; to: string; amount: string }
  /** The ERC-20 of a note's units (FlowEngine v4: one NoteToken clone per issued asset). */
  | { name: 'NoteTokenCreated'; pid: string; asset: number; token: string }
  /**
   * A payout (coupon, redemption, delivery, a default's distribution): `perUnit` of cash asset `asset` to every
   * holder of `holding` units but the payer, O(1) on-chain (an accumulator). The read model credits each holder
   * here; `retire` redeems the units with it. `period` counts this asset's distributions on the note (1-based).
   */
  | {
      name: 'DistributionRecorded';
      pid: string;
      asset: number;
      period: number;
      holding: number;
      step: number;
      payer: string;
      perUnit: string;
      total: string;
      supply: string;
      retire: boolean;
      hash: string;
    }
  /** A payout sent to a holder's wallet (the holder's claim, or a push): `amount` in the token's base units; `payoutId` is its receipt id. */
  | { name: 'PayoutPaid'; pid: string; asset: number; period: number; holder: string; amount: string; payoutId: string }
  /** A payment that could not be sent (e.g. a frozen address): it stays claimable. */
  | { name: 'PayoutDeferred'; pid: string; asset: number; period: number; holder: string; amount: string }
  /** A push round reached the last holder (or was superseded): its count, total and rolling hash of payoutIds. */
  | {
      name: 'DistributionSettled';
      pid: string;
      asset: number;
      period: number;
      paidCount: number;
      paidTotal: string;
      rollingHash: string;
    }
  /** `via`: which agent submitted the report, classified when ingested. */
  | { name: 'ReportProcessed'; pid: string; step: number; values: string[]; reporter: string; via: 'cre' | 'fallback' }
  | { name: 'ProcessCompleted'; pid: string }
  /** A business event the workflow marks on a step (core MILESTONES): collateral, funding, payments, default. */
  | { name: 'Milestone'; pid: string; code: number; step: number; actor: string }
  | { name: 'FallbackReporterUpdated'; previous: string; next: string }
  /** A verified email bound to an address as a salted hash (the email and salt stay off-chain), or removed. */
  | { name: 'EmailAttested'; holder: string; emailHash: string; expiry: number }
  | { name: 'EmailRevoked'; holder: string }
  | { name: 'EmailPolicyUpdated'; verifier: string; requireEmail: boolean };

export type NoteEvent = Extract<EngineEvent, { pid: string }>;

export const hasPid = (e: EngineEvent): e is NoteEvent => 'pid' in e;

export interface EventContext {
  chain: string;
  engine: string;
  /** Block time of the event (unix seconds). */
  at: number;
}

/**
 * Account ids as the read model stores them: EVM addresses lower-case (checksums vary), everything else exactly
 * as given (Canton party ids are case-sensitive).
 */
export const normAccount = (a: string) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);

/** Fold one event into a note's state. `s` is null before ProcessStarted. Returns the new state (or null). */
export function applyEvent(s: NoteState | null, e: NoteEvent, ctx: EventContext): NoteState | null {
  if (e.name === 'ProcessStarted') {
    return {
      id: noteId(ctx.chain, ctx.engine, e.pid),
      chain: ctx.chain,
      engine: ctx.engine.toLowerCase(),
      pid: e.pid,
      definition: e.definition,
      creator: normAccount(e.creator),
      ref: e.ref,
      roles: e.roles.map(normAccount),
      assetTokens: e.assetTokens.map(normAccount),
      status: 0,
      tokens: [],
      stepsRun: 0,
      values: {},
      holdings: [],
      createdAt: ctx.at,
      updatedAt: ctx.at,
      reports: { cre: 0, fallback: 0, last: null },
      milestones: [],
    };
  }
  if (!s) return null; // an event for a process whose start we have not seen (e.g. before the start block)
  const n: NoteState = { ...s, updatedAt: Math.max(s.updatedAt, ctx.at) };
  switch (e.name) {
    case 'FieldSet':
      n.values = { ...s.values, [e.field]: e.value };
      break;
    case 'HoldingChanged': {
      const owner = normAccount(e.owner);
      const rest = s.holdings.filter((h) => !(h.asset === e.asset && h.owner === owner));
      n.holdings = e.balance === '0' ? rest : [...rest, { asset: e.asset, owner, balance: e.balance }];
      n.holdings.sort((a, b) => a.asset - b.asset || a.owner.localeCompare(b.owner));
      break;
    }
    case 'NoteTokenCreated': {
      const tokens = [...s.assetTokens];
      tokens[e.asset] = normAccount(e.token);
      n.assetTokens = tokens;
      break;
    }
    case 'DistributionRecorded': {
      // Credit every holder its share now, as the chain's accumulator does: the chain logs a cash balance only
      // when it settles (units move, a withdrawal, a push), and every such balance includes all it accrued.
      const payer = normAccount(e.payer);
      const perUnit = BigInt(e.perUnit);
      const credit = new Map<string, bigint>();
      if (BigInt(e.supply) > 0n && perUnit !== 0n) {
        for (const h of s.holdings) {
          if (h.asset !== e.holding || h.owner === payer) continue;
          const pay = (BigInt(h.balance) * perUnit) / SCALE_BIG;
          if (pay > 0n) credit.set(h.owner, pay);
        }
      }
      let holdings = s.holdings.map((h) =>
        h.asset === e.asset && credit.has(h.owner)
          ? { ...h, balance: (BigInt(h.balance) + credit.get(h.owner)!).toString() }
          : h,
      );
      for (const [owner, pay] of credit)
        if (!holdings.some((h) => h.asset === e.asset && h.owner === owner))
          holdings.push({ asset: e.asset, owner, balance: pay.toString() });
      // Redeemed: the units read zero from now on (the chain retires them in one write, not per holder).
      if (e.retire) holdings = holdings.filter((h) => h.asset !== e.holding);
      n.holdings = holdings.sort((a, b) => a.asset - b.asset || a.owner.localeCompare(b.owner));
      break;
    }
    case 'TokensUpdated':
      n.status = e.status;
      n.stepsRun = e.stepsRun;
      n.tokens = [...e.tokens];
      break;
    case 'ReportProcessed':
      n.reports = { ...s.reports, [e.via]: s.reports[e.via] + 1, last: e.via };
      break;
    case 'ProcessCompleted':
      n.status = 1;
      break;
    case 'Milestone':
      // Absolute positions would need a sequence number; milestones only append, and a reorg rebuilds the note
      // from its remaining events, so appending is exact.
      n.milestones = [...(s.milestones ?? []), { code: e.code, step: e.step, at: ctx.at }];
      break;
    default:
      // StepRun, deposits, withdrawals, transfers and payout receipts are history; their effects arrive as
      // HoldingChanged (and DistributionRecorded).
      break;
  }
  return n;
}

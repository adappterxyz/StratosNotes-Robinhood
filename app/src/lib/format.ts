import type { NoteView } from '@sn/sdk';
import { BaseError, ContractFunctionRevertedError } from 'viem';

export const fmtMoney = (x: number, dp = 2) =>
  (Number.isFinite(x) ? x : 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const fmtPrice = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 2 });
export const fmtPct = (r: number) => `${(r * 100).toFixed(1)}%`;
export const fmtDate = (t: number) =>
  t ? new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;

/** What happens next, in a few words. */
export function nextEvent(o: NoteView) {
  const e = o.economics;
  if (o.phase === 'defaulted') return 'Defaulted: collateral to holders';
  if (e?.marginCall) return `Margin call: top-up due ${fmtDate(e.marginCall.deadline)}`;
  if (e?.inGrace) return `Payment ${e.inGrace.period} in grace until ${fmtDate(e.inGrace.deadline)}`;
  if (e?.nextCall)
    return `Payment ${e.nextCall.period} ${e.nextCall.funded ? 'funded' : 'due'} ${fmtDate(e.nextCall.payDate)}`;
  if (o.phase === 'book') return o.strikeDate ? `Book closes ${fmtDate(o.strikeDate)}` : 'Book open';
  if (o.phase === 'fixing') return 'Waiting for the strike fixing';
  if (o.phase === 'live') {
    const k = o.perfs.length;
    return o.obsDates[k] ? `Observation ${k + 1} ${fmtDate(o.obsDates[k])}` : 'In progress';
  }
  return o.outcome?.calledAt ? `Autocalled at observation ${o.outcome.calledAt}` : 'Matured';
}

/** Who acted as calculation agent on this note so far. */
export function agentLabel(o: Pick<NoteView, 'reports'>) {
  if (!o.reports.cre && !o.reports.fallback) return null;
  if (o.reports.fallback && !o.reports.cre) return 'Fallback keeper';
  if (o.reports.cre && !o.reports.fallback) return 'Reported by Chainlink CRE';
  return `Chainlink CRE (${o.reports.cre}) and fallback keeper (${o.reports.fallback})`;
}

/** A receipt for collateral held on another chain (planned, docs/CROSS-CHAIN.md): a token name with a chain suffix,
 * e.g. "USDC.eth". None exists today: every collateral token is a Robinhood Chain token. */
export const isReceipt = (token: string) => /\.[a-z]+$/.test(token);
/** The asset a person locks, for a collateral token name: a receipt ("USDC.eth") reads as its asset ("USDC"). */
export const lockedAsset = (token: string) => token.replace(/\.[a-z]+$/, '');
/** "USDC on another chain" for a receipt, else the token itself. */
export const lockedAssetWhere = (token: string) =>
  isReceipt(token) ? `${lockedAsset(token)} on another chain` : token;

/** What the engine's refusals mean, in the words a person acting on the page would use. */
const ENGINE_ERRORS: Record<string, string> = {
  IssuerEmailNotVerified: 'verify your email before issuing (Alerts in the top bar)',
  SubscriberEmailNotVerified: 'verify your email before subscribing (Alerts in the top bar)',
  RecipientEmailNotVerified: 'the receiving wallet has no verified email',
  WindowClosed: 'the window for this step has closed',
  NotDue: 'this step is not due yet',
  WrongRole: 'this wallet does not hold the role for this step',
  StepNotActive: 'this step is not open right now',
  ProcessFinished: 'the note has finished',
  EnforcedPause: 'the engine is paused',
  DefinitionTooLarge: 'the workflow is too large for the engine (use fewer observations or underlyings)',
  BadDefinition: 'the engine could not read the compiled workflow',
  InsufficientBalance: 'not enough balance',
  SafeERC20FailedOperation: 'the token transfer failed (check the token balance and allowance)',
};

/** One readable line for an error: the engine's own reason when it refused, never a cut-off "reason:". */
export const errText = (e: unknown) => {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r) {
      const head = e.message
        .split('\n')[0]
        .replace(/ with the following (reason|signature):?$/, '')
        .replace(/\.$/, '');
      const name = r.data?.errorName;
      const args = r.data?.args?.length ? ` (${r.data.args.map(String).join(', ')})` : '';
      const why = name
        ? (ENGINE_ERRORS[name] ?? `${name}${args}`)
        : (r.reason ?? (r.signature ? `error ${r.signature}` : 'no reason given'));
      return `${head}: ${why}.`;
    }
  }
  const m = e instanceof Error ? e.message : String(e);
  if (/User rejected the request/i.test(m)) return 'You rejected the request in your wallet.';
  // viem errors carry long details; the first line says what happened, unless it ends where the details begin.
  const lines = m
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return /:$/.test(lines[0] ?? '') && lines[1] ? `${lines[0]} ${lines[1]}` : (lines[0] ?? m);
};

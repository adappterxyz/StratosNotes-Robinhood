/**
 * Who moves a payout from the note to the holder's wallet (docs/ERC20-NOTES.md §5, "Why claim by default").
 *
 * Chainlink CRE pays each coupon and the redemption INTO the note on its payment date, whatever happens here. The
 * last hop is a CLAIM by default: the holder calls `pushTo(pid, asset, [self])` from the portfolio when they like and
 * pays their own gas (a receipt per claim, PayoutPaid). A note whose terms opt in (`payouts: 'push'`) is pushed to
 * every holder by the issuer's bot, at the issuer's cost.
 *
 * scripts/issuer-bot.ts reads its policy from the environment with pushPolicyFromEnv:
 *   PUSH unset    push only the notes whose terms opt in (none, unless the issuer chose it at issuance)
 *   PUSH=1        push every note the bot looks after (or PIDS), opted in or not
 *   PUSH=0        never push, not even notes that opted in
 *   PUSH_MIN=x    when pushing, only holders owed at least x (in the asset's own units, e.g. 0.5 USDG); the rest
 *                 stays claimable
 *   PUSH_ASSETS   only these cash assets (e.g. 1: the stablecoin); PUSH_BATCH holders per transaction (100)
 */
import { dec, payoutMethodOf, type PayoutMethod, type WorkflowDef } from '@sn/core';
import { termsOf } from './model';

export type PushMode = 'off' | 'opt-in' | 'all';

export interface PushPolicy {
  mode: PushMode;
  /** Minimum owed per holder to push, engine fixed point (1e10 = 1 unit of the asset); 0n: everyone owed. */
  min: bigint;
  /** Cash assets to push (by index, as strings), or null for all. */
  assets: Set<string> | null;
  /** Holders per transaction. */
  batch: bigint;
}

export function pushPolicyFromEnv(env: Record<string, string | undefined>): PushPolicy {
  const mode: PushMode = env.PUSH === '1' ? 'all' : env.PUSH === '0' ? 'off' : 'opt-in';
  const min = env.PUSH_MIN ? dec(env.PUSH_MIN) : 0n;
  if (min < 0n) throw new Error('PUSH_MIN must be zero or positive');
  const assets = env.PUSH_ASSETS
    ? new Set(
        env.PUSH_ASSETS.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  const batch = BigInt(env.PUSH_BATCH ?? '100');
  if (batch <= 0n) throw new Error('PUSH_BATCH must be positive');
  return { mode, min, assets, batch };
}

/** How the note's holders are paid: 'push' only when its term sheet (the definition's META) opts in. */
export function payoutMethod(def: WorkflowDef): PayoutMethod {
  const t = termsOf(def);
  return t.hasTerms ? payoutMethodOf(t.params) : 'claim';
}

/** Whether a bot with this policy pushes the note's payouts (before any PUSH_ASSETS filter). */
export function pushesNote(policy: PushPolicy, def: WorkflowDef): boolean {
  if (policy.mode === 'off') return false;
  if (policy.mode === 'all') return true;
  return payoutMethod(def) === 'push';
}

import { zeroAddress } from 'viem';
import type { IssuePlan } from '@sn/sdk';
import type { ByKey } from '../../../lib/engines';
import { short } from '../../../lib/format';

/** Advanced details: which roles the wallet holds, the steps the note runs and the engine it runs on. */
export function IssueAdvanced({
  plan,
  all,
  chain,
}: {
  plan: IssuePlan;
  all: Array<{ name: string }>;
  chain: ByKey[string] | undefined;
}) {
  return (
    <details className="adv">
      <summary>Advanced: roles, steps and contracts</summary>
      <div className="adv-body xs muted">
        <p>
          Your wallet holds {plan.heldPools.join(', ')}
          {plan.openPools.length ? `; ${plan.openPools.join(', ')} is open to anyone` : ''}.
        </p>
        <p>Runs: {all.map((s) => s.name).join(' → ')}.</p>
        {chain && (
          <p>
            Engine {short(chain.cfg.engine)}
            {chain.cfg.engine === zeroAddress ? ' (not deployed)' : ''} on {chain.cfg.name} ·{' '}
            {chain.cfg.cre ? 'reports by Chainlink CRE' : 'reports by the fallback keeper'}
            {chain.cfg.explorer ? (
              <>
                {' '}
                ·{' '}
                <a href={`${chain.cfg.explorer}/address/${chain.cfg.engine}`} target="_blank" rel="noreferrer">
                  view on explorer
                </a>
              </>
            ) : (
              ''
            )}
          </p>
        )}
      </div>
    </details>
  );
}

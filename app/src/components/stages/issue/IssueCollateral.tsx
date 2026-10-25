import type { Dispatch, SetStateAction } from 'react';
import type { ByKey } from '../../../lib/engines';
import { fmtMoney, lockedAsset, lockedAssetWhere } from '../../../lib/format';
import { LockOnRobinhood } from '../../CrossChainCollateral';

/** Step 3 of the issue panel: the collateral ratio, haircuts and what the issuer pledges. */
export function IssueCollateral({
  compact,
  ratioPct,
  setRatioPct,
  required,
  sym,
  collateralSyms,
  tokOf,
  haircuts,
  setHaircuts,
  pledgeOf,
  setPledges,
  remote,
  chain,
  usdCoverage,
}: {
  compact: boolean;
  ratioPct: number;
  setRatioPct: (n: number) => void;
  required: number;
  sym: string;
  collateralSyms: string[];
  tokOf: (c: string) => string;
  haircuts: Record<string, number>;
  setHaircuts: Dispatch<SetStateAction<Record<string, number>>>;
  pledgeOf: (c: string) => string;
  setPledges: Dispatch<SetStateAction<Record<string, string>>>;
  remote: boolean;
  chain: ByKey[string] | undefined;
  usdCoverage: number;
}) {
  return (
    <div className="section" data-collateral>
      <div className="step-h">
        {compact ? (
          <h3>Collateral to lock</h3>
        ) : (
          <>
            <span className="n">3</span>
            <h3>Collateral you lock</h3>
          </>
        )}
      </div>
      <p className="xs muted">
        Locked in the note until every payment is made. If you miss one, holders take what they're owed from it.
      </p>
      <div className="form-grid">
        <div className="field" hidden={compact}>
          <label htmlFor="is-ratio">Collateral ratio, % of the notional</label>
          <input
            id="is-ratio"
            type="number"
            min={0}
            max={1000}
            value={ratioPct}
            onChange={(e) => setRatioPct(Number(e.target.value))}
          />
          <span className="hint">
            Required: {fmtMoney(required)} {sym} of collateral value, checked at the strike and every observation.
          </span>
        </div>
        {collateralSyms.map((c) => {
          const tok = tokOf(c);
          return (
            <div key={c} className="field">
              <label htmlFor={`is-pledge-${c}`}>
                {lockedAssetWhere(tok)} pledged
                {compact ? (
                  ` · ${haircuts[c] ?? 100}% counted`
                ) : (
                  <>
                    {' '}
                    · haircut{' '}
                    <input
                      className="w-64 inline-block"
                      aria-label={`${lockedAsset(tok)} share of value counted, %`}
                      type="number"
                      min={0}
                      max={100}
                      value={haircuts[c] ?? 100}
                      onChange={(e) => setHaircuts((h) => ({ ...h, [c]: Number(e.target.value) }))}
                    />
                    % counted
                  </>
                )}
              </label>
              <input
                id={`is-pledge-${c}`}
                inputMode="decimal"
                value={pledgeOf(c)}
                onChange={(e) => setPledges((x) => ({ ...x, [c]: e.target.value }))}
                placeholder={`${lockedAsset(tok)} amount`}
              />
              {c !== 'USD' && (
                <span className="hint">
                  Valued by Chainlink at the strike; with{' '}
                  {collateralSyms.length > 1 ? 'the other assets' : 'nothing else'} it must cover {fmtMoney(required)}{' '}
                  {sym}.
                </span>
              )}
            </div>
          );
        })}
      </div>
      {remote && (
        <LockOnRobinhood
          needed={collateralSyms.map((c) => ({ receipt: tokOf(c), amount: Number(pledgeOf(c)) || 0 }))}
        />
      )}
      {remote && chain?.cfg.crossChain?.role !== 'home' && (
        <p className="xs err">
          Collateral locked on Robinhood Chain needs this deployment's Arbitrum cross-chain gateway, which it does not
          configure.
        </p>
      )}
      {collateralSyms.every((c) => c === 'USD') && (
        <p className={`xs ${usdCoverage + 1e-9 >= required ? 'muted' : 'err'}`}>
          Coverage at the strike: {fmtMoney(usdCoverage)} {sym} of {fmtMoney(required)} required
          {usdCoverage + 1e-9 >= required ? '.' : ': top it up, or the note goes into a margin call at the strike.'}
        </p>
      )}
    </div>
  );
}

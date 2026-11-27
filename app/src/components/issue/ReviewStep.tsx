import { Backtest } from '../Backtest';
import { useState } from 'react';
import { chainLabel, type CollateralSymbol, type economicsOf, type ProductParams } from '@sn/core';
import { fmtMoney, lockedAsset } from '../../lib/format';
import type { Schedule } from '../../lib/listing';
import { getLine, riskLine } from '../../lib/story';
import PayoffChart from '../PayoffChart';
import { PlayNote } from '../PlayNote';
import { IssuePanel, TemplatePanel, type Built, type DocInfo, type IssuePreset } from '../Stages';
import { FlowPreview } from '../StepPanel';
import { IssuePreview } from './Preview';
import type { Every, Timing } from './schedule';

/**
 * Step 5, Review & issue: what investors will see (their card, what they get and the main risk) and what you commit
 * to, a chance to play the note through before issuing, then the issue panel. The workflow diagram the note is
 * compiled from, and the payout chart, sit under "Under the hood".
 */
export function ReviewStep({
  p,
  eco,
  size,
  sym,
  every,
  strikeAt,
  fmtT,
  dur,
  t,
  remote,
  colToken,
  built,
  doc,
  preset,
  xml,
  chainKey,
  schedule,
}: {
  p: ProductParams;
  eco: ReturnType<typeof economicsOf>;
  size: number;
  sym: string;
  every: Every;
  strikeAt: number;
  fmtT: (s: number) => string;
  dur: (s: number) => string;
  t: Timing;
  remote: boolean;
  colToken: (c: CollateralSymbol) => string | null;
  built: Built | null;
  doc: DocInfo;
  preset: IssuePreset;
  /** The workflow the note is compiled from (BPMN), drawn under the hood. */
  xml: string;
  chainKey: string;
  schedule: Schedule;
}) {
  const [hood, setHood] = useState(false);
  const locked = eco.collateral.map((c) => lockedAsset(colToken(c.symbol) ?? c.symbol)).join(' + ');
  return (
    <>
      <h2>Review & issue</h2>
      <div className="iw-rev">
        <section className="iw-rev-col" aria-labelledby="rev-see">
          <h3 id="rev-see">What investors see</h3>
          <IssuePreview p={p} cash={sym} chainKey={chainKey} schedule={schedule} size={size} />
          <ul className="iw-says">
            <li className="good">{getLine(p, sym)}</li>
            <li className="risk">{riskLine(p, sym)}</li>
          </ul>
          <Backtest p={p} schedule={schedule} cash={sym} />
        </section>
        <section className="iw-rev-col" aria-labelledby="rev-commit">
          <h3 id="rev-commit">What you commit to</h3>
          <ul className="iw-commit">
            <li>
              <b>
                Raise up to {fmtMoney(size, 0)} {sym}.
              </b>{' '}
              The book is open until {fmtT(strikeAt)}; the price is checked {p.observations} time
              {p.observations === 1 ? '' : 's'}, every {every.n} {every.unit}.
            </li>
            <li>
              <b>
                Lock {locked} worth at least {eco.collateralRatioPct}% of what's sold
              </b>
              {remote && p.collateralChain ? `, locked on ${chainLabel(p.collateralChain)}` : ''}, until the last
              payment. It is yours again once every payment is made.
            </li>
            <li>
              <b>Fund each payment within {dur(t.lag)} of its check.</b> If one is late, {dur(t.grace)} of extra time
              follows.
            </li>
            <li>
              <b>If a payment is still missing,</b> holders take{' '}
              {eco.defaultRule === 'cap-at-owed'
                ? "what they're owed from the collateral, and the rest comes back to you"
                : 'everything in escrow'}
              .
            </li>
            <li>
              {p.payouts === 'push'
                ? "You send each payment to every holder's wallet and pay the gas (run the issuer bot)."
                : 'Holders claim their payouts any time from their portfolio, and pay their own gas.'}
            </li>
          </ul>
        </section>
      </div>

      <PlayNote p={p} cash={sym} schedule={schedule} title="Try it before you issue" />

      {built ? (
        <IssuePanel key={JSON.stringify(preset) + p.name} doc={doc} built={built} preset={preset} compact />
      ) : (
        <div className="notice err">This note doesn't compile: go back and check its terms.</div>
      )}

      <details
        className="adv iw-flow"
        data-review-flow
        onToggle={(e) => setHood((e.target as HTMLDetailsElement).open)}
      >
        <summary>Under the hood: how this note runs on-chain</summary>
        <div className="adv-body stack gap-12">
          {hood && xml && (
            <>
              <p className="xs muted m-0">
                The note's workflow, step by step, as it will run on-chain. This diagram is what gets compiled and
                issued.
              </p>
              <FlowPreview xml={xml} params={p} label="How this note runs" />
            </>
          )}
          {hood && (
            <div className="stack gap-6">
              <span className="lbl">Payout per 100 at the end, if not repaid early</span>
              <PayoffChart params={p} />
            </div>
          )}
        </div>
      </details>
      {built && (
        <details className="adv iw-save">
          <summary>Save as a ready-made note</summary>
          <div className="adv-body">
            <TemplatePanel key={p.name} doc={doc} build={async () => built} onSaved={() => {}} bare />
          </div>
        </details>
      )}
    </>
  );
}

import { PRODUCT_LABELS, type CollateralSymbol, type economicsOf, type ProductParams } from '@sn/core';
import { fmtMoney, lockedAsset } from '../../lib/format';
import { AssetStack } from '../AssetIcon';
import { IssuePanel, TemplatePanel, type Built, type DocInfo, type IssuePreset } from '../Stages';
import { FlowPreview } from '../StepPanel';
import type { Every, Timing } from './schedule';

/** Step 5, Review & issue: what investors get and what the issuer commits to, then the issue panel. */
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
  /** The workflow the note is compiled from (BPMN), drawn for review. */
  xml: string;
}) {
  const syms = p.underlyings.map((u) => u.symbol);
  return (
    <>
      <h2>Review & issue</h2>
      <dl className="iw-review">
        <dt>Note</dt>
        <dd>
          <strong>{p.name}</strong> · {PRODUCT_LABELS[p.productType]} on <AssetStack syms={syms} size={16} />
        </dd>
        <dt>Size</dt>
        <dd>
          {fmtMoney(size, 0)} {sym}, book open until {fmtT(strikeAt)}; {p.observations} observations every {every.n}{' '}
          {every.unit}.
        </dd>
        <dt>Investors get</dt>
        <dd>
          {p.couponRatePct
            ? `${p.couponRatePct}% ${p.productType === 'snowball' ? 'added each period, paid when called' : 'coupon each period'} in USDG${p.couponBarrierPct ? ` while the worst price is at least ${p.couponBarrierPct}% of strike` : ''}. `
            : ''}
          {p.autocallLevelPct ? `Repaid early at ${p.autocallLevelPct}% or more. ` : ''}
          {p.protectionPct ? `${p.protectionPct}% back at maturity plus ${p.participationPct}% of any rise. ` : ''}
          {p.knockInBarrierPct
            ? `Below ${p.knockInBarrierPct}% at maturity: ${p.settlement === 'physical' ? 'the stock instead of cash' : 'final ÷ strike in USDG'}.`
            : ''}
        </dd>
        <dt>Payouts</dt>
        <dd>
          {p.payouts === 'push'
            ? "Paid to holders' wallets automatically; you cover the gas."
            : 'Holders claim any time from their portfolio; they pay their own gas.'}
        </dd>
        <dt>You commit to</dt>
        <dd>
          <ul className="iw-list">
            <li>
              Lock {eco.collateral.map((c) => lockedAsset(colToken(c.symbol) ?? c.symbol)).join(' + ')} worth at least{' '}
              {eco.collateralRatioPct}% of what's sold{remote ? ', on Robinhood Chain' : ''}, until the last payment.
            </li>
            <li>
              Fund each payment within {dur(t.lag)} of its observation; a {dur(t.grace)} grace period follows.
            </li>
            <li>
              If a payment is still missing, holders take{' '}
              {eco.defaultRule === 'cap-at-owed' ? "what they're owed" : 'everything in escrow'} from the collateral.
            </li>
            {p.payouts === 'push' && (
              <li>Send each payment to every holder's wallet and pay the gas (run the issuer bot).</li>
            )}
          </ul>
        </dd>
      </dl>
      {xml && (
        <details className="adv iw-flow" open data-review-flow>
          <summary>How this note runs</summary>
          <div className="adv-body">
            <p className="xs muted m-0">
              The note's workflow, step by step, as it will run on-chain. This diagram is what gets compiled and issued.
            </p>
            <FlowPreview xml={xml} params={p} label="How this note runs" />
          </div>
        </details>
      )}
      {built ? (
        <IssuePanel key={JSON.stringify(preset) + p.name} doc={doc} built={built} preset={preset} compact />
      ) : (
        <div className="notice err">This note doesn't compile: go back and check its terms.</div>
      )}
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

import { productUses, type ProductParams } from '@sn/core';
import { Num } from './Num';
import { TermErrors } from './TermErrors';

/** Step 2, Terms: observations, coupons, barriers and protection (only those the note type uses). */
export function TermsStep({
  p,
  set,
  errors,
}: {
  p: ProductParams;
  set: (patch: Partial<ProductParams>) => void;
  errors: string[];
}) {
  const use = productUses(p.productType);
  return (
    <>
      <h2>Terms</h2>
      <div className="form-grid">
        <Num
          id="iw-obs"
          label="Observations"
          value={p.observations}
          step="1"
          min={1}
          onChange={(v) =>
            set({
              observations: v,
              ...(p.autocallFromPeriod && p.autocallFromPeriod > v ? { autocallFromPeriod: 1 } : {}),
            })
          }
          hint="The last one is maturity."
        />
        {use.coupon && (
          <Num
            id="iw-cpn"
            label={p.productType === 'snowball' ? 'Coupon added each period' : 'Coupon each period'}
            suffix="%"
            value={p.couponRatePct}
            onChange={(v) => set({ couponRatePct: v })}
            hint="Paid in USDG."
          />
        )}
        {use.couponBarrier && (
          <Num
            id="iw-cb"
            label="Coupon barrier (of strike)"
            suffix="%"
            value={p.couponBarrierPct}
            onChange={(v) => set({ couponBarrierPct: v })}
          />
        )}
        {use.autocall && (
          <Num
            id="iw-ac"
            label="Early repayment at (of strike)"
            suffix="%"
            value={p.autocallLevelPct}
            onChange={(v) => set({ autocallLevelPct: v })}
          />
        )}
        {use.knockIn && (
          <Num
            id="iw-ki"
            label="Knock-in barrier (of strike)"
            suffix="%"
            value={p.knockInBarrierPct}
            onChange={(v) => set({ knockInBarrierPct: v })}
            hint={
              p.settlement === 'physical'
                ? 'Below it at maturity: the stock.'
                : 'Below it at maturity: final ÷ strike in USDG.'
            }
          />
        )}
        {use.protection && (
          <Num
            id="iw-prot"
            label="Protected"
            suffix="%"
            value={p.protectionPct}
            onChange={(v) => set({ protectionPct: v })}
          />
        )}
        {use.protection && (
          <Num
            id="iw-part"
            label="Share of the upside"
            suffix="%"
            value={p.participationPct}
            onChange={(v) => set({ participationPct: v })}
          />
        )}
      </div>
      {(use.couponBarrier || use.autocall) && (
        <details className="adv">
          <summary>More options</summary>
          <div className="adv-body form-grid">
            {use.couponBarrier && (
              <div className="field">
                <label htmlFor="iw-mem">Missed coupons paid later (memory)</label>
                <select
                  id="iw-mem"
                  value={p.memory ? 'yes' : 'no'}
                  onChange={(e) => set({ memory: e.target.value === 'yes' })}
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
            )}
            {use.autocall && (
              <Num
                id="iw-acf"
                label="Early repayment from observation"
                step="1"
                min={1}
                value={p.autocallFromPeriod ?? 1}
                onChange={(v) => set({ autocallFromPeriod: v })}
              />
            )}
          </div>
        </details>
      )}
      <TermErrors errors={errors} />
    </>
  );
}

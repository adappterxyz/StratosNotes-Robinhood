import { cashTokenOf, productUses, type ProductParams } from '@sn/core';
import { listingOf, type Schedule } from '../../lib/listing';
import { subjectOf } from '../../lib/story';
import { Slider } from './controls';
import { TermErrors } from './TermErrors';

/**
 * Step 2, Terms: the coupon, the lines that decide the note (coupon line, money-back line, early-repayment line),
 * protection and the number of checks, as sliders with their numbers; only the ones the note type uses. Warnings say
 * when a combination is unsafe or unusual; the preview beside it updates as you move them.
 */
export function TermsStep({
  p,
  set,
  errors,
  schedule,
}: {
  p: ProductParams;
  set: (patch: Partial<ProductParams>) => void;
  errors: string[];
  schedule: Schedule;
}) {
  const use = productUses(p.productType);
  const cash = cashTokenOf(p).token;
  const who = subjectOf(p.underlyings.map((u) => u.symbol));
  const apr = listingOf(p, schedule).yield.apr;
  const ki = p.knockInBarrierPct;
  const cb = p.couponBarrierPct;
  const ac = p.autocallLevelPct;
  const couponWarn =
    apr !== null && apr > 25
      ? `About ${Math.round(apr)}% a year is very generous: make sure your collateral covers every coupon.`
      : null;
  const kiWarn =
    ki !== undefined && cb !== undefined && use.couponBarrier && ki > cb
      ? 'The money-back line is above the coupon line: investors would lose money while coupons are still paid.'
      : ki !== undefined && ki >= 95
        ? 'Almost no room: any small fall at the end costs investors money.'
        : null;
  const acWarn =
    ac !== undefined && cb !== undefined && use.couponBarrier && ac < cb
      ? 'The early-repayment line is below the coupon line.'
      : null;
  return (
    <>
      <h2>Terms</h2>
      <p className="small muted m-0">
        Lines are % of each asset's starting price, fixed when the book closes.{' '}
        {who.charAt(0).toUpperCase() + who.slice(1)}{' '}
        {p.underlyings.length > 1 ? 'decides every check.' : 'is checked on each date.'}
      </p>
      <div className="sl-grid">
        {use.coupon && (
          <Slider
            id="iw-cpn"
            label={p.productType === 'snowball' ? 'Payout added each period' : 'Coupon each period'}
            tech="coupon"
            value={p.couponRatePct}
            onChange={(v) => set({ couponRatePct: v })}
            min={0.25}
            max={10}
            step={0.25}
            suffix="%"
            hint={`Paid in ${cash}${apr !== null ? `: about ${Math.round(apr * 10) / 10}% a year` : ''}.`}
            warn={couponWarn}
          />
        )}
        {use.couponBarrier && (
          <Slider
            id="iw-cb"
            label="Coupon line"
            tech="coupon barrier"
            value={cb}
            onChange={(v) => set({ couponBarrierPct: v })}
            min={40}
            max={100}
            suffix="%"
            hint={`A coupon is paid at each check where ${who} is at or above it.`}
          />
        )}
        {use.knockIn && (
          <Slider
            id="iw-ki"
            label="Money-back line"
            tech="knock-in"
            value={ki}
            onChange={(v) => set({ knockInBarrierPct: v })}
            min={30}
            max={100}
            suffix="%"
            safe={{ from: 30, to: 70, label: 'usual' }}
            hint={
              p.settlement === 'physical'
                ? `Below it at the end, investors get the stock instead of their ${cash}.`
                : `Below it at the end, investors get back only what ${who} is worth (final ÷ start).`
            }
            warn={kiWarn}
          />
        )}
        {use.autocall && (
          <Slider
            id="iw-ac"
            label="Early-repayment line"
            tech="autocall"
            value={ac}
            onChange={(v) => set({ autocallLevelPct: v })}
            min={80}
            max={130}
            suffix="%"
            hint={`At or above it on a check, the note ends early and investors get their ${cash} back.`}
            warn={acWarn}
          />
        )}
        {use.protection && (
          <Slider
            id="iw-prot"
            label="Money back at the end"
            tech="protection"
            value={p.protectionPct}
            onChange={(v) => set({ protectionPct: v })}
            min={50}
            max={100}
            suffix="%"
            safe={{ from: 90, to: 100, label: 'usual' }}
            hint="Investors get at least this much back, whatever happens."
          />
        )}
        {use.protection && (
          <Slider
            id="iw-part"
            label="Share of the rise"
            tech="participation"
            value={p.participationPct}
            onChange={(v) => set({ participationPct: v })}
            min={0}
            max={200}
            step={5}
            suffix="%"
            hint={`Of any rise in ${who} above its starting price.`}
          />
        )}
        <Slider
          id="iw-obs"
          label="Number of checks"
          tech="observations"
          value={p.observations}
          onChange={(v) =>
            set({
              observations: v,
              ...(p.autocallFromPeriod && p.autocallFromPeriod > v ? { autocallFromPeriod: 1 } : {}),
            })
          }
          min={1}
          max={12}
          hint="The price is checked on each date; the last check ends the note."
        />
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
              <div className="field">
                <label htmlFor="iw-acf">Early repayment possible from check</label>
                <input
                  id="iw-acf"
                  type="number"
                  step="1"
                  min={1}
                  value={p.autocallFromPeriod ?? 1}
                  onChange={(e) => set({ autocallFromPeriod: Number(e.target.value) })}
                />
              </div>
            )}
          </div>
        </details>
      )}
      <TermErrors errors={errors} />
    </>
  );
}

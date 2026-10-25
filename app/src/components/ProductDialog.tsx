/**
 * Term sheet -> workflow (Flow's ProductDialog). The issuer picks a payoff
 * and one underlying or a worst-of basket; the result opens on the canvas as
 * a stock product. Size and dates are not here: they are set per issuance, in
 * the Issue stage.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  COLLATERAL_SYMBOLS,
  collateralTokenOf,
  DEFAULT_HAIRCUT,
  deliverableToken,
  economicsOf,
  EXAMPLE_PRODUCTS,
  FEEDS,
  MAX_COLLATERAL,
  MAX_GRACE_DAYS,
  MAX_UNDERLYINGS,
  PRODUCT_LABELS,
  productUses,
  simulatePerf,
  toIssuanceTerms,
  totalPerUnit,
  UNPRICED_STOCKS,
  validateProductParams,
  type CollateralSymbol,
  type DefaultRule,
  type ProductParams,
  type ProductType,
} from '@sn/core';
import PayoffChart from './PayoffChart';

type Num = (v: number) => void;
function NumField({
  id,
  label,
  value,
  onChange,
  hint,
  step = 'any',
}: {
  id: string;
  label: string;
  value: number | undefined;
  onChange: Num;
  hint?: string;
  step?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function ProductForm({ p, set }: { p: ProductParams; set: (patch: Partial<ProductParams>) => void }) {
  const use = productUses(p.productType);
  const pick = (t: ProductType) =>
    set({
      ...EXAMPLE_PRODUCTS[t],
      name: EXAMPLE_PRODUCTS[t].name,
      underlyings: p.underlyings,
      issuePricePct: p.issuePricePct,
      collateral: p.collateral,
      collateralRatioPct: p.collateralRatioPct,
      settlementLagDays: p.settlementLagDays,
      gracePeriodDays: p.gracePeriodDays,
      defaultRule: p.defaultRule,
      collateralChain: p.collateralChain,
    });
  /** The token a collateral chip pledges, or null when the note's chain has none. */
  const colToken = (c: CollateralSymbol) => collateralTokenOf(p, c)?.token ?? null;
  const delivered = p.underlyings.map((u) => deliverableToken(p, u.symbol)?.token ?? `no ${u.symbol} token`).join('/');
  const eco = economicsOf(p);
  /** Collateral that stays pledgeable under other terms (the stablecoin when nothing does). */
  const keepCol = (q: ProductParams) => {
    const kept = eco.collateral.filter((c) => !!collateralTokenOf(q, c.symbol));
    return kept.length ? kept : [{ symbol: 'USD' as const, haircutPct: 100 }];
  };
  const colSyms = eco.collateral.map((c) => c.symbol);
  const toggleCol = (c: CollateralSymbol) => {
    if (colSyms.includes(c)) {
      if (colSyms.length > 1) set({ collateral: eco.collateral.filter((x) => x.symbol !== c) });
    } else if (colSyms.length < MAX_COLLATERAL)
      set({ collateral: [...eco.collateral, { symbol: c, haircutPct: DEFAULT_HAIRCUT[c] }] });
  };
  const symbols = p.underlyings.map((u) => u.symbol);
  const toggleUnd = (k: keyof typeof FEEDS) => {
    if (symbols.includes(k)) {
      if (symbols.length > 1) set({ underlyings: p.underlyings.filter((u) => u.symbol !== k) });
    } else if (symbols.length < MAX_UNDERLYINGS) set({ underlyings: [...p.underlyings, FEEDS[k]] });
  };
  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor="pd-type">Payoff</label>
        <select id="pd-type" value={p.productType} onChange={(e) => pick(e.target.value as ProductType)}>
          {(Object.keys(PRODUCT_LABELS) as ProductType[]).map((t) => (
            <option key={t} value={t}>
              {PRODUCT_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      <div className="field span-2">
        <label htmlFor="pd-name">Name</label>
        <input id="pd-name" value={p.name} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="field wide">
        <span className="lbl">Underlying{symbols.length > 1 ? 's: worst of' : ''}</span>
        <div className="row" role="group" aria-label="Underlyings">
          {(Object.keys(FEEDS) as Array<keyof typeof FEEDS>).map((k) => (
            <button
              key={k}
              type="button"
              className={`chip ${symbols.includes(k) ? 'on' : ''}`}
              aria-pressed={symbols.includes(k)}
              onClick={() => toggleUnd(k)}
              disabled={!symbols.includes(k) && symbols.length >= MAX_UNDERLYINGS}
            >
              {k}/USD
            </button>
          ))}
          {UNPRICED_STOCKS.map((k) => (
            <button
              key={k}
              type="button"
              className="chip"
              disabled
              title={`${k}: a Robinhood Chain stock token, no Chainlink price yet`}
            >
              {k}/USD
            </button>
          ))}
        </div>
        <span className="hint">
          {symbols.length > 1
            ? `Worst-of: every barrier, autocall and the redemption use the weakest of ${symbols.join(', ')} against its own strike. Up to ${MAX_UNDERLYINGS}.`
            : "Pick more than one for a worst-of basket. Chainlink price feeds on each asset's own chain (crypto: Ethereum; stocks: Robinhood Chain), read by CRE."}{' '}
          {UNPRICED_STOCKS.join(', ')}: held only, no feed yet.
        </span>
      </div>
      <NumField
        id="pd-obs"
        label="Observations"
        value={p.observations}
        step="1"
        onChange={(v) =>
          set({
            observations: v,
            ...(p.autocallFromPeriod && p.autocallFromPeriod > v ? { autocallFromPeriod: 1 } : {}),
          })
        }
        hint="The last is maturity"
      />
      <NumField
        id="pd-price"
        label="Issue price %"
        value={p.issuePricePct}
        onChange={(v) => set({ issuePricePct: v })}
      />
      {use.coupon && (
        <NumField
          id="pd-cpn"
          label={p.productType === 'snowball' ? 'Accrued coupon / period %' : 'Coupon / period %'}
          value={p.couponRatePct}
          onChange={(v) => set({ couponRatePct: v })}
        />
      )}
      {use.couponBarrier && (
        <NumField
          id="pd-cb"
          label="Coupon barrier %"
          value={p.couponBarrierPct}
          onChange={(v) => set({ couponBarrierPct: v })}
        />
      )}
      {use.couponBarrier && (
        <div className="field">
          <label htmlFor="pd-mem">Memory coupon</label>
          <select
            id="pd-mem"
            value={p.memory ? 'yes' : 'no'}
            onChange={(e) => set({ memory: e.target.value === 'yes' })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
      )}
      {use.autocall && (
        <NumField
          id="pd-ac"
          label="Autocall level %"
          value={p.autocallLevelPct}
          onChange={(v) => set({ autocallLevelPct: v })}
        />
      )}
      {use.autocall && (
        <NumField
          id="pd-acf"
          label="Autocall from observation"
          value={p.autocallFromPeriod ?? 1}
          step="1"
          onChange={(v) => set({ autocallFromPeriod: v })}
        />
      )}
      {use.knockIn && (
        <NumField
          id="pd-ki"
          label="Knock-in barrier %"
          value={p.knockInBarrierPct}
          onChange={(v) => set({ knockInBarrierPct: v })}
          hint={
            p.settlement === 'physical'
              ? "Below it: the underlying's token, units ÷ strike"
              : 'Below it: final / strike in cash'
          }
        />
      )}
      {use.knockIn && (
        <div className="field">
          <label htmlFor="pd-settle">Settlement below the barrier</label>
          <select
            id="pd-settle"
            value={p.settlement ?? 'cash'}
            onChange={(e) => set({ settlement: e.target.value as 'cash' | 'physical' })}
          >
            <option value="cash">Cash (USDG)</option>
            <option value="physical">Physical delivery</option>
          </select>
          <span className="hint">
            {p.settlement === 'physical'
              ? `Holders receive units ÷ strike of ${p.underlyings.length > 1 ? "the worst performer's" : `the ${p.underlyings[0]?.symbol}`} token (${delivered}, on Arbitrum); the issuer funds the delivery before maturity.`
              : 'Holders receive final ÷ strike in USDG.'}
          </span>
        </div>
      )}
      <div className="field wide" data-issue-network>
        <span className="lbl">Network</span>
        <strong>Arbitrum Sepolia</strong>
        <span className="hint">
          Every note is issued and paid on Arbitrum: it can deliver WETH; stocks and BTC settle in cash. Stock
          collateral is locked on Robinhood Chain (below).
        </span>
      </div>
      <div className="field wide">
        <label htmlFor="pd-colchain">Collateral held on</label>
        <select
          id="pd-colchain"
          value={p.collateralChain ?? 'note'}
          onChange={(e) => {
            const v = e.target.value as 'note' | 'robinhood';
            set({ collateralChain: v, collateral: keepCol({ ...p, collateralChain: v }) });
          }}
        >
          <option value="note">Arbitrum: pledged into the note</option>
          <option value="robinhood">Robinhood Chain: locked in place, via Chainlink CCIP</option>
        </select>
        <span className="hint">
          {p.collateralChain === 'robinhood'
            ? 'You lock USDG, TSLA, AMZN, AMD or PLTR in the vault on Robinhood Chain; Chainlink CCIP tells the note (about 15–25 minutes per message). The tokens never leave Robinhood Chain; on a default holders redeem their share there.'
            : 'USDG or WETH, pledged straight into the note.'}
        </span>
      </div>
      {use.protection && (
        <NumField
          id="pd-prot"
          label="Protection %"
          value={p.protectionPct}
          onChange={(v) => set({ protectionPct: v })}
        />
      )}
      {use.protection && (
        <NumField
          id="pd-part"
          label="Participation %"
          value={p.participationPct}
          onChange={(v) => set({ participationPct: v })}
        />
      )}
      <div className="field wide">
        <span className="lbl">Collateral the issuer pledges</span>
        <div className="row" role="group" aria-label="Collateral">
          {COLLATERAL_SYMBOLS.filter((c) => !!colToken(c)).map((c) => (
            <button
              key={c}
              type="button"
              className={`chip ${colSyms.includes(c) ? 'on' : ''}`}
              aria-pressed={colSyms.includes(c)}
              onClick={() => toggleCol(c)}
              disabled={!colSyms.includes(c) && colSyms.length >= MAX_COLLATERAL}
            >
              {colToken(c)}
            </button>
          ))}
          {p.collateralChain === 'robinhood' &&
            UNPRICED_STOCKS.map((k) => (
              <button
                key={k}
                type="button"
                className="chip"
                disabled
                title={`${k}: held on Robinhood Chain, no Chainlink price yet`}
              >
                {k}
              </button>
            ))}
        </div>
        <span className="hint">
          Locked in the note's escrow until the final payment; on a default the holders are paid from it (see the
          default rule). Tokens count at{' '}
          {eco.collateral
            .filter((c) => c.symbol !== 'USD')
            .map((c) => `${c.haircutPct}% (${colToken(c.symbol) ?? c.symbol})`)
            .join(', ') || 'their Chainlink price after a haircut'}{' '}
          of their Chainlink value.
        </span>
      </div>
      {eco.collateral
        .filter((c) => c.symbol !== 'USD')
        .map((c) => (
          <NumField
            key={c.symbol}
            id={`pd-hc-${c.symbol}`}
            label={`${colToken(c.symbol) ?? c.symbol} counted at %`}
            value={c.haircutPct}
            onChange={(v) =>
              set({ collateral: eco.collateral.map((x) => (x.symbol === c.symbol ? { ...x, haircutPct: v } : x)) })
            }
          />
        ))}
      <NumField
        id="pd-ratio"
        label="Collateral ratio % of notional"
        value={eco.collateralRatioPct}
        onChange={(v) => set({ collateralRatioPct: v })}
        hint="Default; set per issuance"
      />
      <NumField
        id="pd-lag"
        label="Payment lag (days)"
        value={eco.settlementLagDays}
        onChange={(v) => set({ settlementLagDays: v })}
        hint="After each observation"
      />
      <NumField
        id="pd-grace"
        label={`Grace period (days, 0-${MAX_GRACE_DAYS})`}
        value={eco.gracePeriodDays}
        onChange={(v) => set({ gracePeriodDays: v })}
        hint="Then default"
      />
      <div className="field">
        <label htmlFor="pd-default">On a default, holders get</label>
        <select
          id="pd-default"
          value={eco.defaultRule}
          onChange={(e) => set({ defaultRule: e.target.value as DefaultRule })}
        >
          <option value="cap-at-owed">What they are owed; the rest back to the issuer</option>
          <option value="all-to-holders">Everything in escrow</option>
        </select>
        <span className="hint">
          Owed = the missed payment plus par, valued at the last Chainlink prices (stablecoin first).
        </span>
      </div>
    </div>
  );
}

export default function ProductDialog({
  initial,
  onClose,
  onCreate,
}: {
  initial: ProductParams | null;
  onClose: () => void;
  onCreate: (p: ProductParams) => void;
}) {
  // Notes are issued on Arbitrum only: an old term sheet (on Robinhood Chain, or delivering a stock) opens moved there.
  const [p, setP] = useState<ProductParams>(toIssuanceTerms(initial ?? EXAMPLE_PRODUCTS.phoenix));
  useEffect(() => {
    if (initial) setP(toIssuanceTerms(initial));
  }, [initial]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const errors = validateProductParams(p);
  const flat = errors.length ? null : simulatePerf(p, new Array(p.observations).fill(1));
  return (
    <div className="scrim" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 id="pd-title">Structured product</h2>
            <p className="xs muted">
              A verified payoff engine from a term sheet, secured by collateral the issuer pledges. Size, dates and the
              collateral amounts are set when you issue.
            </p>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close">
            <X className="i" />
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-cols">
            <ProductForm p={p} set={(patch) => setP((prev) => ({ ...prev, ...patch }))} />
            <div className="stack gap-8">
              <span className="label">Payout per 100 at maturity</span>
              {errors.length ? (
                <ul className="issues">
                  {errors.map((e) => (
                    <li key={e} className="err">
                      {e}
                    </li>
                  ))}
                </ul>
              ) : (
                <PayoffChart params={p} />
              )}
              {flat && (
                <p className="xs muted">
                  If {p.underlyings.length > 1 ? 'every underlying stays' : `${p.underlyings[0].symbol} stays`} at its
                  strike: {(totalPerUnit(flat) * 100).toFixed(2)} per 100
                  {flat.calledAt ? `, called at observation ${flat.calledAt}` : ''}.
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={errors.length > 0} onClick={() => onCreate(p)}>
            Open workflow
          </button>
        </div>
      </div>
    </div>
  );
}

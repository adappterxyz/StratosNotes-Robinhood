import {
  COLLATERAL_SYMBOLS,
  DEFAULT_HAIRCUT,
  MAX_COLLATERAL,
  MAX_GRACE_DAYS,
  UNPRICED_STOCKS,
  type CollateralSymbol,
  type DefaultRule,
  type economicsOf,
  type ProductParams,
} from '@sn/core';
import type { ChainConfig } from '../../lib/api';
import { fmtMoney, lockedAsset } from '../../lib/format';
import { AssetIcon } from '../AssetIcon';
import { Num } from './Num';
import type { Timing } from './schedule';
import { TermErrors } from './TermErrors';

/** Step 4, Collateral: where it is held, what is locked, the ratio, payment timing and the default rule. */
export function CollateralStep({
  p,
  set,
  eco,
  remote,
  colToken,
  chainCfg,
  size,
  sym,
  demo,
  t,
  setTiming,
  timingBad,
  errors,
}: {
  p: ProductParams;
  set: (patch: Partial<ProductParams>) => void;
  eco: ReturnType<typeof economicsOf>;
  remote: boolean;
  colToken: (c: CollateralSymbol) => string | null;
  chainCfg: ChainConfig | undefined;
  size: number;
  sym: string;
  demo: boolean;
  t: Timing;
  setTiming: (t: Timing | null) => void;
  timingBad: string;
  errors: string[];
}) {
  /** A receipt of collateral held on another chain (planned) is offered only when the chain's config lists it. */
  const colLive = (tok: string | null) => !!tok && (!tok.includes('.') || !!chainCfg?.tokens?.[tok]);
  const colSyms = eco.collateral.map((c) => c.symbol);
  const toggleCol = (c: CollateralSymbol) => {
    if (colSyms.includes(c)) {
      if (colSyms.length > 1) set({ collateral: eco.collateral.filter((x) => x.symbol !== c) });
    } else if (colSyms.length < MAX_COLLATERAL)
      set({ collateral: [...eco.collateral, { symbol: c, haircutPct: DEFAULT_HAIRCUT[c] }] });
  };
  return (
    <>
      <h2>Collateral</h2>
      <p className="small muted">
        You lock collateral for the note's whole life. Investors' USDG comes to you; if you miss a payment, holders take
        what they're owed from the collateral.
      </p>
      <div className="field">
        <span className="lbl">Held on</span>
        <span className="small">
          <img src={`${import.meta.env.BASE_URL}assets/robinhood-feather.svg`} alt="" width={14} height={14} />{' '}
          Robinhood Chain, in the note itself
        </span>
        <span className="hint">
          {remote
            ? 'Held in a vault on another chain; Chainlink CCIP tells the note, and the note sends it back there when it lets it go. Nothing is bridged.'
            : "USDG, WETH or Robinhood's stock tokens (TSLA, AMZN, AMD, PLTR), pledged into the note on Robinhood Chain."}
        </span>
      </div>
      <div className="field">
        <span className="lbl">Assets you lock (up to {MAX_COLLATERAL})</span>
        <div className="row iw-unds" role="group" aria-label="Collateral">
          {COLLATERAL_SYMBOLS.filter((c) => !!colToken(c)).map((c) => {
            const tok = colToken(c)!;
            const live = colLive(tok);
            return (
              <button
                key={c}
                type="button"
                className={`chip ${colSyms.includes(c) ? 'on' : ''}`}
                aria-pressed={colSyms.includes(c)}
                onClick={() => toggleCol(c)}
                disabled={!colSyms.includes(c) && (colSyms.length >= MAX_COLLATERAL || !live)}
                title={live ? undefined : `${tok} is not registered on the gateway yet`}
              >
                <AssetIcon sym={tok} size={18} />
                {lockedAsset(tok)}
              </button>
            );
          })}
          {UNPRICED_STOCKS.map((k) => (
            <button
              key={k}
              type="button"
              className="chip"
              disabled
              title={`${k}: on Robinhood Chain, no Chainlink price yet`}
            >
              <AssetIcon sym={k} size={18} />
              {k}
            </button>
          ))}
        </div>
        <span className="hint">
          {UNPRICED_STOCKS.join(', ')}: on Robinhood Chain, no Chainlink price yet, so it can't be pledged.
        </span>
      </div>
      <div className="form-grid">
        <Num
          id="iw-ratio"
          label="Collateral ratio (of size)"
          suffix="%"
          value={eco.collateralRatioPct}
          onChange={(v) => set({ collateralRatioPct: v })}
          hint={`${fmtMoney((eco.collateralRatioPct / 100) * size)} ${sym} of value required.`}
        />
        <Num
          id="is-lag"
          label={`Pay holders within (${demo ? 'seconds' : 'days'})`}
          value={demo ? t.lag : t.lag / 86400}
          min={0}
          onChange={(v) => setTiming({ ...t, lag: Math.max(0, v || 0) * (demo ? 1 : 86400) })}
          hint="After each observation."
        />
        <Num
          id="is-grace"
          label={`Grace period (${demo ? 'seconds' : 'days'})`}
          value={demo ? t.grace : t.grace / 86400}
          min={0}
          onChange={(v) => setTiming({ ...t, grace: Math.max(0, v || 0) * (demo ? 1 : 86400) })}
          hint={`Up to ${MAX_GRACE_DAYS} days, then default.`}
        />
      </div>
      {timingBad && <div className="notice warn">{timingBad}</div>}
      <details className="adv">
        <summary>More options: haircuts, the default rule and how holders get paid</summary>
        <div className="adv-body form-grid">
          {eco.collateral
            .filter((c) => c.symbol !== 'USD')
            .map((c) => (
              <Num
                key={c.symbol}
                id={`iw-hc-${c.symbol}`}
                label={`${lockedAsset(colToken(c.symbol) ?? c.symbol)} counted at (of value)`}
                suffix="%"
                value={c.haircutPct}
                onChange={(v) =>
                  set({
                    collateral: eco.collateral.map((x) => (x.symbol === c.symbol ? { ...x, haircutPct: v } : x)),
                  })
                }
              />
            ))}
          <div className="field">
            <label htmlFor="iw-default">On a default, holders get</label>
            <select
              id="iw-default"
              value={eco.defaultRule}
              onChange={(e) => set({ defaultRule: e.target.value as DefaultRule })}
            >
              <option value="cap-at-owed">What they're owed; the rest back to you</option>
              <option value="all-to-holders">Everything in escrow</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="iw-payouts">Holders get their payouts</label>
            <select
              id="iw-payouts"
              value={p.payouts ?? 'claim'}
              onChange={(e) => set({ payouts: e.target.value === 'push' ? 'push' : undefined })}
            >
              <option value="claim">By claiming them, any time (they pay their own gas)</option>
              <option value="push">Sent to their wallets automatically (you pay the gas)</option>
            </select>
            <span className="hint">
              {p.payouts === 'push'
                ? 'Your bot sends every payment to every holder: about 55,000 gas per holder per payment, paid by you.'
                : 'Payments wait in the note until each holder claims; one claim collects everything, with a receipt.'}
            </span>
          </div>
        </div>
      </details>
      <TermErrors errors={errors} />
    </>
  );
}

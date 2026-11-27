import { CollateralMarket } from './CollateralMarket';
import {
  cashTokenOf,
  chainLabel,
  collateralChoices,
  COLLATERAL_SYMBOLS,
  DEFAULT_HAIRCUT,
  joinList,
  MAX_COLLATERAL,
  MAX_GRACE_DAYS,
  NOTE_CHAIN_SHORT,
  noteChainOf,
  remoteCollateralOf,
  stockTokenNotes,
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
import { Presets, Slider } from './controls';
import type { Timing } from './schedule';
import { TermErrors } from './TermErrors';

const DEMO_TIMING = [
  { label: 'Fast demo', sub: '30 s to pay, 60 s extra', t: { lag: 30, grace: 60 } },
  { label: 'Relaxed demo', sub: '40 s to pay, 60 s extra', t: { lag: 40, grace: 60 } },
];
const REAL_TIMING = [
  { label: 'Standard', sub: '2 days to pay, 2 days extra', t: { lag: 2 * 86400, grace: 2 * 86400 } },
  { label: 'Quick', sub: '1 day to pay, 1 day extra', t: { lag: 86400, grace: 86400 } },
  { label: 'Generous', sub: '2 days to pay, 7 days extra', t: { lag: 2 * 86400, grace: 7 * 86400 } },
];

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
  heldOn,
  onHeldOn,
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
  /** Where the collateral can be held: in the note, or locked on the other chain (live when its pair is deployed). */
  heldOn: Array<{ key: string; label: string; live: boolean }>;
  onHeldOn: (key: string) => void;
}) {
  /** A receipt of collateral locked on the other chain is offered only when the note chain's config lists it. */
  const colLive = (tok: string | null) => !!tok && (!tok.includes('.') || !!chainCfg?.tokens?.[tok]);
  const noteChain = noteChainOf(p);
  const heldKey = remote ? (p.collateralChain ?? 'note') : 'note';
  /** The chain the collateral itself sits on: the note's own, or where it is locked. */
  const collateralOn = remote ? (p.collateralChain ?? noteChain) : noteChain;
  const onRobinhood = collateralOn === 'robinhood-testnet';
  const lockable = Object.values(remoteCollateralOf(p) ?? {})
    .map((r) => r!.locked.token)
    .join(', ');
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
        You lock collateral for the note's whole life. Investors' {cashTokenOf(p).token} comes to you; if you miss a
        payment, holders take what they're owed from the collateral, up to its value.
      </p>
      <div className="field" data-held-on={heldKey}>
        <span className="lbl">Where the collateral sits</span>
        <div className="seg iw-seg-wrap" role="radiogroup" aria-label="Collateral held on">
          {heldOn.map((h) => (
            <button
              key={h.key}
              type="button"
              role="radio"
              aria-checked={h.key === heldKey}
              className={h.key === heldKey ? 'active' : ''}
              data-held-on-choice={h.key}
              disabled={!h.live && h.key !== heldKey}
              title={
                h.live
                  ? undefined
                  : `The cross-chain gateway and vault for ${h.label} are not deployed on this site yet`
              }
              onClick={() => h.key !== heldKey && onHeldOn(h.key)}
            >
              {h.key === 'robinhood-testnet' || (h.key === 'note' && noteChain === 'robinhood-testnet') ? (
                <img src={`${import.meta.env.BASE_URL}assets/robinhood-feather.svg`} alt="" width={14} height={14} />
              ) : null}
              {h.key === 'note' ? `${h.label} (the note's chain)` : `${h.label}, locked via Chainlink CCIP`}
            </button>
          ))}
        </div>
        <span className="hint">
          {remote
            ? `${lockable ? `${lockable} ` : ''}stay locked in the vault on ${chainLabel(collateralOn)}; Chainlink CCIP tells the note (about 15–25 minutes per message), and the note sends them back there when it lets them go. Nothing is bridged. The collateral recovers up to its value in a default, and the tokens' own issuers can freeze them.`
            : `${joinList(
                collateralChoices({ chain: noteChain })
                  .map((c) => c.token)
                  .filter((t): t is string => !!t),
                'or',
              )}, pledged into the note on ${NOTE_CHAIN_SHORT[noteChain]}.${
                heldOn.some((h) => h.key !== 'note')
                  ? ` To pledge another chain's tokens, lock them on ${joinList(
                      heldOn.filter((h) => h.key !== 'note').map((h) => h.label),
                      'or',
                    )}.`
                  : ''
              }`}
          {heldOn.some((h) => h.key !== 'note' && !h.live)
            ? ' Locking on the other chain opens once its cross-chain gateway and vault are deployed.'
            : ''}
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
          {onRobinhood &&
            UNPRICED_STOCKS.map((k) => (
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
        {onRobinhood && (
          <span className="hint">
            {UNPRICED_STOCKS.join(', ')}: on Robinhood Chain, no Chainlink price yet, so it can't be pledged.
          </span>
        )}
        {stockTokenNotes(p)
          .filter((n) => n.key === 'bstock')
          .map((n) => (
            <span key={n.key} className="hint" data-stock-note={n.key}>
              {n.text}
            </span>
          ))}
      </div>
      <Slider
        id="iw-ratio"
        label="How much collateral"
        tech="collateral ratio, % of what's sold"
        value={eco.collateralRatioPct}
        onChange={(v) => set({ collateralRatioPct: v })}
        min={50}
        max={200}
        step={5}
        suffix="%"
        safe={{ from: 100, to: 200, label: 'covers every unit' }}
        hint={`${fmtMoney((eco.collateralRatioPct / 100) * size)} ${sym} of value locked if all ${fmtMoney(size, 0)} units sell.`}
        warn={
          eco.collateralRatioPct < 100
            ? 'Below 100%, a default can leave investors short: most investors look for 100% or more.'
            : null
        }
      />
      <div className="iw-field">
        <div className="iw-field-h">
          <span className="lbl">Time to pay investors, then extra time before default</span>
        </div>
        <Presets
          label="Payment timing"
          options={(demo ? DEMO_TIMING : REAL_TIMING).map((o) => ({ label: o.label, sub: o.sub, value: o.t }))}
          value={t}
          onPick={(v) => setTiming(v)}
        />
        <div className="iw-pair">
          <div className="field">
            <label htmlFor="is-lag">Pay within ({demo ? 'seconds' : 'days'}) of each check</label>
            <input
              id="is-lag"
              type="number"
              min={0}
              value={demo ? t.lag : t.lag / 86400}
              onChange={(e) => setTiming({ ...t, lag: Math.max(0, Number(e.target.value) || 0) * (demo ? 1 : 86400) })}
            />
          </div>
          <div className="field">
            <label htmlFor="is-grace">Extra time ({demo ? 'seconds' : 'days'}, grace)</label>
            <input
              id="is-grace"
              type="number"
              min={0}
              value={demo ? t.grace : t.grace / 86400}
              onChange={(e) =>
                setTiming({ ...t, grace: Math.max(0, Number(e.target.value) || 0) * (demo ? 1 : 86400) })
              }
            />
          </div>
        </div>
        <span className="hint">
          You fund each payment by its date; if you miss it, the extra time (up to {MAX_GRACE_DAYS} days) follows, then
          holders are paid from the collateral.
        </span>
      </div>
      {timingBad && <div className="notice warn">{timingBad}</div>}
      <CollateralMarket
        collateral={eco.collateral}
        pledgeUsd={(c) => {
          const hc = eco.collateral.find((x) => x.symbol === c)?.haircutPct || 100;
          // What must be locked of this asset alone to cover the whole size at the ratio, after its haircut.
          return (size * (eco.collateralRatioPct / 100)) / (hc / 100);
        }}
        onUse={(c, v) => set({ collateral: eco.collateral.map((x) => (x.symbol === c ? { ...x, haircutPct: v } : x)) })}
      />
      <details className="adv">
        <summary>More options: haircuts, the default rule and how holders get paid</summary>
        <div className="adv-body form-grid">
          {eco.collateral
            .filter((c) => c.symbol !== 'USD')
            .map((c) => (
              <Num
                key={c.symbol}
                id={`iw-hc-${c.symbol}`}
                label={`${lockedAsset(colToken(c.symbol) ?? c.symbol)} counted at (haircut, % of its value)`}
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

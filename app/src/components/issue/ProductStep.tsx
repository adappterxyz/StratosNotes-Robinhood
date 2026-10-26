import {
  catalogueFeed,
  deliverableToken,
  EXAMPLE_PRODUCTS,
  FEEDS,
  isCatalogueSymbol,
  MAX_UNDERLYINGS,
  PRODUCT_LABELS,
  productUses,
  type ProductParams,
  type ProductType,
} from '@sn/core';
import type { ChainConfig } from '../../lib/api';
import { Asset, AssetStack } from '../AssetIcon';
import { feedSource, renameForUnderlyings, UnderlyingPicker } from '../UnderlyingPicker';
import { Num } from './Num';
import { PRODUCTS, type Kind } from './wizard-data';

/** Step 1, Product: the underlyings, the payoff on a basket, how a knock-in settles, and the name. */
export function ProductStep({
  kind,
  p,
  set,
  chainCfg,
  moved,
}: {
  kind: Kind;
  p: ProductParams;
  set: (patch: Partial<ProductParams>) => void;
  chainCfg: ChainConfig | undefined;
  moved: boolean;
}) {
  const use = productUses(p.productType);
  const syms = p.underlyings.map((u) => u.symbol);
  const delivered = (s: string) => deliverableToken(p, s)?.token ?? null;
  const physicalOk = syms.every((s) => !!delivered(s));
  const toggleUnd = (k: string) => {
    if (!isCatalogueSymbol(k)) return;
    const pick = (underlyings: ProductParams['underlyings']) =>
      set({
        underlyings,
        name: renameForUnderlyings(
          p.name,
          syms,
          underlyings.map((u) => u.symbol),
        ),
      });
    if (syms.includes(k)) {
      if (syms.length > 1) pick(p.underlyings.filter((u) => u.symbol !== k));
    } else if (kind !== 'worst-of') pick([FEEDS[k]]);
    else if (syms.length < MAX_UNDERLYINGS) pick([...p.underlyings, FEEDS[k]]);
  };
  const undeliverable = syms.filter((s) => !delivered(s));
  /** Why physical delivery is off: no token on the note's chain for these (forex, commodities, most stocks). */
  const whyCashOnly = undeliverable.length
    ? `${undeliverable.join(', ')} ${undeliverable.length > 1 ? 'have' : 'has'} no token on ${chainCfg?.name ?? 'Robinhood Chain'} to deliver${undeliverable.some((s) => ['Forex', 'Commodities'].includes(catalogueFeed(s)?.assetClass ?? '')) ? ' (a currency or commodity price is cash-settled)' : ''}: the note settles in cash, final ÷ strike in USDG.`
    : '';
  return (
    <>
      <h2>
        <span className="iw-ic sm" aria-hidden="true">
          {PRODUCTS.find((x) => x.kind === kind)?.icon}
        </span>
        {PRODUCT_LABELS[p.productType]}
        {kind === 'worst-of' ? ' on a basket' : ''}
      </h2>
      <div className="field">
        <span className="lbl">
          {kind === 'worst-of' ? `Underlyings (2–${MAX_UNDERLYINGS}): the weakest decides` : 'Underlying'}
        </span>
        <UnderlyingPicker
          selected={syms}
          onToggle={toggleUnd}
          canAdd={kind !== 'worst-of' || syms.length < MAX_UNDERLYINGS}
          deliverable={delivered}
          idPrefix="iw-und"
        />
        <span className="hint" data-underlying-sources>
          Any Chainlink price: stocks, crypto, forex, commodities, each fixed on its own oracle.{' '}
          {p.underlyings
            .map((u) => {
              const f = catalogueFeed(u.symbol);
              return `${u.symbol}/USD${f && f.name !== u.symbol ? ` (${f.name})` : ''} from ${f ? feedSource(f) : `Chainlink feed ${u.feed}`}`;
            })
            .join('; ')}
          .
        </span>
      </div>
      <div className="field" data-issue-network>
        <span className="lbl">Network</span>
        <strong>{chainCfg?.name ?? 'Robinhood Chain testnet'}</strong>
        <span className="hint">
          Notes run on Robinhood Chain: issued, paid and collateralised there. Below the knock-in a note can deliver
          Robinhood's TSLA, AMZN, AMD or PLTR token, or WETH; every other underlying (BTC, other stocks, forex,
          commodities) settles in cash.
        </span>
      </div>
      {moved && (
        <div className="notice info" role="note" data-moved-to-robinhood>
          These terms named another chain, collateral held elsewhere, or a token Robinhood Chain does not have. Notes
          run on Robinhood Chain only, so they were moved there: such an underlying settles in cash, and the collateral
          is pledged into the note on Robinhood Chain.
        </div>
      )}
      {kind === 'worst-of' && (
        <div className="field">
          <label htmlFor="iw-base">Payoff</label>
          <select
            id="iw-base"
            value={p.productType}
            onChange={(e) =>
              set({
                ...EXAMPLE_PRODUCTS[e.target.value as ProductType],
                name: p.name,
                underlyings: p.underlyings,
              })
            }
          >
            {(Object.keys(PRODUCT_LABELS) as ProductType[]).map((x) => (
              <option key={x} value={x}>
                {PRODUCT_LABELS[x]}
              </option>
            ))}
          </select>
        </div>
      )}
      {use.knockIn && (
        <div className="field">
          <span className="lbl">If the price falls through the knock-in barrier, holders get</span>
          <div className="seg" role="radiogroup" aria-label="Settlement">
            <button
              role="radio"
              aria-checked={(p.settlement ?? 'cash') === 'cash'}
              className={(p.settlement ?? 'cash') === 'cash' ? 'active' : ''}
              onClick={() => set({ settlement: 'cash' })}
            >
              <Asset sym="USDG" size={16} />
              Cash
            </button>
            <button
              role="radio"
              aria-checked={p.settlement === 'physical'}
              className={p.settlement === 'physical' ? 'active' : ''}
              disabled={!physicalOk && p.settlement !== 'physical'}
              title={physicalOk ? undefined : whyCashOnly}
              data-physical-disabled={physicalOk ? undefined : true}
              onClick={() => set({ settlement: 'physical' })}
            >
              <AssetStack syms={syms} size={16} label={false} />
              The asset itself
            </button>
          </div>
          <span className="hint">
            {physicalOk
              ? `The asset itself: ${syms.map((s) => delivered(s)).join(', ')} on ${chainCfg?.name ?? "the note's network"}.`
              : `Cash only. ${whyCashOnly}`}
          </span>
          {p.settlement === 'physical' && !physicalOk && (
            <div className="notice warn">
              Robinhood Chain has no token to deliver for {syms.filter((s) => !delivered(s)).join(', ')}: settle in
              cash, or pick another underlying.
            </div>
          )}
        </div>
      )}
      <div className="field">
        <label htmlFor="iw-name">Name</label>
        <input id="iw-name" value={p.name} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <details className="adv">
        <summary>More options</summary>
        <div className="adv-body form-grid">
          <Num
            id="iw-price"
            label="Issue price"
            suffix="%"
            value={p.issuePricePct}
            onChange={(v) => set({ issuePricePct: v })}
          />
        </div>
      </details>
    </>
  );
}

import {
  deliverableToken,
  EXAMPLE_PRODUCTS,
  FEEDS,
  MAX_UNDERLYINGS,
  PRODUCT_LABELS,
  productUses,
  UNPRICED_STOCKS,
  type ProductParams,
  type ProductType,
} from '@sn/core';
import type { ChainConfig } from '../../lib/api';
import { Asset, AssetIcon, AssetStack } from '../AssetIcon';
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
  const toggleUnd = (k: keyof typeof FEEDS) => {
    if (syms.includes(k)) {
      if (syms.length > 1) set({ underlyings: p.underlyings.filter((u) => u.symbol !== k) });
    } else if (kind !== 'worst-of') set({ underlyings: [FEEDS[k]] });
    else if (syms.length < MAX_UNDERLYINGS) set({ underlyings: [...p.underlyings, FEEDS[k]] });
  };
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
        <div className="row iw-unds" role="group" aria-label="Underlyings">
          {(Object.keys(FEEDS) as Array<keyof typeof FEEDS>).map((k) => (
            <button
              key={k}
              type="button"
              className={`chip ${syms.includes(k) ? 'on' : ''}`}
              aria-pressed={syms.includes(k)}
              onClick={() => toggleUnd(k)}
            >
              <AssetIcon sym={k} size={18} />
              {k}
            </button>
          ))}
          {UNPRICED_STOCKS.map((k) => (
            <button
              key={k}
              type="button"
              className="chip"
              disabled
              title={`${k}: a Robinhood Chain stock token you can hold, with no Chainlink price yet`}
            >
              <AssetIcon sym={k} size={18} />
              {k}
            </button>
          ))}
        </div>
        <span className="hint">
          Fixed by Chainlink on each asset's own chain: crypto on Ethereum, stocks on Robinhood Chain.{' '}
          {UNPRICED_STOCKS.join(', ')}: held on Robinhood Chain, no Chainlink price yet.
        </span>
      </div>
      <div className="field" data-issue-network>
        <span className="lbl">Network</span>
        <strong>{chainCfg?.name ?? 'Arbitrum Sepolia'}</strong>
        <span className="hint">
          Every note is issued and paid on Arbitrum. It can deliver WETH; stocks and BTC settle in cash. Stock
          collateral (TSLA, AMZN, AMD, PLTR) is locked on Robinhood Chain in the Collateral step.
        </span>
      </div>
      {moved && (
        <div className="notice info" role="note" data-moved-to-arbitrum>
          These terms named Robinhood Chain or delivered a stock. Notes are now issued on Arbitrum only, so they were
          moved there: stock settles in cash, and stock collateral is locked on Robinhood Chain.
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
                collateralChain: p.collateralChain,
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
              title={
                physicalOk
                  ? undefined
                  : `No ${syms.filter((s) => !delivered(s)).join(', ')} token on ${chainCfg?.name ?? 'this network'}`
              }
              onClick={() => set({ settlement: 'physical' })}
            >
              <AssetStack syms={syms} size={16} label={false} />
              The asset itself
            </button>
          </div>
          <span className="hint">
            {physicalOk
              ? `The asset itself: ${syms.map((s) => delivered(s)).join(', ')} on ${chainCfg?.name ?? "the note's network"}.`
              : `No ${syms.filter((s) => !delivered(s)).join(', ')} token on ${chainCfg?.name ?? 'Arbitrum'}: cash only (stocks stay on Robinhood Chain).`}
          </span>
          {p.settlement === 'physical' && !physicalOk && (
            <div className="notice warn">
              This network has no token to deliver for {syms.filter((s) => !delivered(s)).join(', ')}: settle in cash
              (stock notes are cash-settled), or pick another underlying.
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

import { PRODUCT_LABELS, underlyingLabel } from '@sn/core';
import { headline } from '@sn/sdk';
import { short } from '../../lib/format';
import { Head } from './Head';
import type { DocInfo, Stage } from './types';

export function OverviewPanel({
  doc,
  info,
  onEditTerms,
  onStage,
}: {
  doc: DocInfo;
  info: { pools: string[]; steps: number; fields: string[]; errors: number; warnings: number };
  onEditTerms: () => void;
  onStage: (s: Stage) => void;
}) {
  const p = doc.basis;
  return (
    <>
      <Head title={doc.name} sub={doc.template ? `Ready-made note by ${short(doc.template.author)}` : undefined} />
      <div className="section">
        <div className="row">
          <span className={`pill ${doc.origin === 'product' && !doc.edited ? 'book' : 'live'}`}>
            <span className="dot" />
            {doc.origin === 'product' && !doc.edited
              ? 'Standard note'
              : doc.edited && doc.origin === 'product'
                ? 'Edited: custom workflow'
                : 'Custom workflow'}
          </span>
          <span className="xs muted">{info.steps} steps</span>
        </div>
        <p className="xs muted">
          {doc.origin === 'product' && !doc.edited
            ? 'Runs a verified payoff engine: the marketplace prices it from the reference payoff.'
            : 'The workflow on the canvas is the payoff: it runs exactly as drawn.'}
        </p>
      </div>
      {p && (
        <div className="section">
          <span className="label">Term sheet{doc.edited ? ' (started from)' : ''}</span>
          <div className="small">
            <strong>{PRODUCT_LABELS[p.productType]}</strong> on {underlyingLabel(p)}
          </div>
          <div className="xs muted">
            {headline(p)} · {p.observations} observation{p.observations > 1 ? 's' : ''} · issue price {p.issuePricePct}%
          </div>
          <div>
            <button className="btn" onClick={onEditTerms}>
              Edit terms
            </button>
          </div>
        </div>
      )}
      <div className="section">
        <details className="adv">
          <summary>Advanced: parties and fields</summary>
          <div className="adv-body">
            <span className="label">Parties</span>
            <div className="row">
              {info.pools.map((x) => (
                <span key={x} className="pill plain">
                  {x}
                </span>
              ))}
            </div>
            <span className="label">Fields</span>
            <div className="xs muted num lh-1-7">{info.fields.join(', ') || 'none'}</div>
          </div>
        </details>
      </div>
      <div className="section">
        <span className="label">Next</span>
        <button className="btn primary lg" onClick={() => onStage('issue')} disabled={info.errors > 0}>
          {info.errors ? 'Fix the errors first' : 'Set the terms and issue →'}
        </button>
        <div className="row">
          {info.errors > 0 && (
            <button className="btn" onClick={() => onStage('validate')}>
              Fix {info.errors} error{info.errors > 1 ? 's' : ''}
            </button>
          )}
          <button className="btn" onClick={() => onStage('payoff')}>
            See the payoff
          </button>
          <button className="btn" onClick={() => onStage('template')}>
            Save as ready-made note
          </button>
        </div>
        <p className="xs muted">Advanced: select a step, gateway or flow on the canvas to change what it does.</p>
      </div>
    </>
  );
}

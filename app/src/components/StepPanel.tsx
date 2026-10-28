/**
 * The panel beside a workflow diagram: for the step picked, what it does, who acts, when, whether it ran and the
 * values it recorded (lib/stepFacts.ts). Read-only. FlowPreview is the same diagram and panel for a workflow that is
 * not issued yet (the review step, an AI draft, a saved custom workflow): what each step does and who acts.
 */
import { useState } from 'react';
import type { ProductParams } from '@sn/core';
import FlowMap from './FlowMap';
import { Addr, When } from './ui';
import { previewFacts, type DiagramElement, type StepFacts } from '../lib/stepFacts';

export function StepPanel({ f, explorer, hint }: { f: StepFacts | null; explorer?: string; hint?: string }) {
  if (!f)
    return (
      <div className="nf-panel empty" aria-live="polite">
        <p className="small muted m-0">
          {hint ??
            'Pick a step on the diagram (click, tap, or Tab to it) to see what it does and its values for this note.'}
        </p>
      </div>
    );
  return (
    <div className="nf-panel" aria-live="polite" data-step-panel>
      <div className="nf-panel-h">
        <h4 data-step-title>{f.title}</h4>
        <span className="pill plain">{f.kind}</span>
        {f.status && (
          <span className={`pill nf-status ${f.status}`} data-step-status={f.status}>
            {f.statusText}
          </span>
        )}
      </div>
      {f.plain && <p className="small m-0">{f.plain}</p>}
      <dl className="nf-facts">
        <div className="nf-fact">
          <dt>Who</dt>
          <dd>{f.who}</dd>
        </div>
        {f.when && (
          <div className="nf-fact">
            <dt>{f.when.label}</dt>
            <dd>
              <When t={f.when.t} />
            </dd>
          </div>
        )}
        {f.runs.length > 0 && (
          <div className="nf-fact">
            <dt>{f.runs.length > 1 ? 'Ran' : 'Ran on'}</dt>
            <dd>
              {f.runs.slice(-3).map((r) => (
                <span key={r.tx + r.at} className="nf-run">
                  <When t={r.at} />
                  {explorer && (
                    <>
                      {' · '}
                      <a href={`${explorer}/tx/${r.tx}`} target="_blank" rel="noreferrer">
                        transaction
                      </a>
                    </>
                  )}
                </span>
              ))}
              {f.runs.length > 3 && <span className="xs muted">and {f.runs.length - 3} earlier</span>}
            </dd>
          </div>
        )}
        {f.facts.map((x) => (
          <div key={x.label + x.value} className="nf-fact" data-fact={x.label}>
            <dt>{x.label}</dt>
            <dd className={`num ${x.tone ?? ''}`}>{x.addr ? <Addr value={x.value} /> : x.value}</dd>
          </div>
        ))}
      </dl>
      {f.moves.length > 0 && (
        <div>
          <span className="label">Moves</span>
          <ul className="nf-list">
            {f.moves.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {f.branches.length > 0 && (
        <div>
          <span className="label">Ways out</span>
          <ul className="nf-list">
            {f.branches.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A workflow before it is issued: the diagram, and what each step does when picked. */
export function FlowPreview({ xml, params, label }: { xml: string; params: ProductParams | null; label: string }) {
  const [picked, setPicked] = useState<DiagramElement | null>(null);
  return (
    <div className="nf-body" data-flow-preview>
      <FlowMap xml={xml} active={[]} picked={picked?.id ?? null} onPick={setPicked} label={label} />
      <StepPanel
        f={picked ? previewFacts(picked, params) : null}
        hint="Pick a step on the diagram (click, tap, or Tab to it) to see what it does and who acts."
      />
    </div>
  );
}

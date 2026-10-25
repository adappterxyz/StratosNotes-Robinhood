import { Link } from 'react-router-dom';
import { Workflow } from 'lucide-react';
import type { AiReading, ReadyMade } from '../../lib/readymade';
import DescribeIt from './DescribeIt';
import ReadyMadeList from './ReadyMadeList';
import { PRODUCTS, type Kind } from './wizard-data';

/** The chooser: three ways in (a ready-made note, a note type, or a description for the AI). */
export function IssueChooser({
  pick,
  choose,
  fromAi,
  aiWorkflow,
}: {
  pick: (r: ReadyMade) => void;
  choose: (k: Kind) => void;
  fromAi: (r: AiReading) => void;
  aiWorkflow: (xml: string) => void;
}) {
  return (
    <main className="page iw">
      <div className="page-head">
        <div>
          <h1>Issue a note</h1>
          <p>
            Start from a ready-made note, build your own, or describe it. Either way you set the schedule and collateral
            one step at a time, then review everything before it goes on-chain.
          </p>
        </div>
      </div>
      <section className="iw-door" aria-labelledby="door-ready">
        <div className="iw-door-h">
          <h2 id="door-ready">Start from a ready-made note</h2>
          <span className="small muted">Terms filled in: pick the schedule and collateral, then issue.</span>
        </div>
        <ReadyMadeList onPick={pick} />
      </section>
      <section className="iw-door" aria-labelledby="door-own">
        <div className="iw-door-h">
          <h2 id="door-own">Build your own</h2>
          <span className="small muted">Pick a note type and set every term yourself.</span>
        </div>
        <div className="iw-grid">
          {PRODUCTS.map((x) => (
            <button key={x.kind} className="iw-card" data-product={x.kind} onClick={() => choose(x.kind)}>
              <span className="iw-ic" aria-hidden="true">
                {x.icon}
              </span>
              <span className="iw-t">{x.title}</span>
              <span className="iw-d">{x.line}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="iw-door" aria-labelledby="door-ai">
        <div className="iw-door-h">
          <h2 id="door-ai">Describe it</h2>
          <span className="small muted">
            The AI fills in the note type and terms; anything missing comes back as a question.
          </span>
        </div>
        <DescribeIt onProduct={fromAi} onWorkflow={aiWorkflow} />
      </section>
      <p className="iw-adv">
        <Link to="/issue/advanced">
          <Workflow className="i" />
          Advanced: edit the workflow on the BPMN canvas
        </Link>
      </p>
    </main>
  );
}

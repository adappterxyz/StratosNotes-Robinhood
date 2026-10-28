import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import type { AiReading, ReadyMade } from '../../lib/readymade';
import DescribeIt from './DescribeIt';
import ReadyMadeList, { RecentList } from './ReadyMadeList';
import { PRODUCTS, type Kind } from './wizard-data';

/**
 * The chooser: three ways in. Start from a note (one issued recently, or a ready-made one), the product wizard (a
 * note type, every term set step by step), or describe it to the AI. Each leads to a review that shows the note's
 * workflow diagram before anything is issued; the advanced editor opens from there, never blank.
 */
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
  // /issue#from, #wizard, #describe (links from the advanced editor) land on that way in.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(`door-${hash.slice(1)}`)?.scrollIntoView();
  }, [hash]);
  return (
    <main className="page iw">
      <div className="page-head">
        <div>
          <h1>Issue a note</h1>
          <p>
            Three ways in: start from a note, use the product wizard, or describe it. Each one ends on a review with the
            note's workflow drawn as a diagram, so you see every step before it goes on-chain.
          </p>
        </div>
      </div>
      <section className="iw-door" aria-labelledby="door-from" data-door="from">
        <div className="iw-door-h">
          <h2 id="door-from">Start from a note</h2>
          <span className="small muted">
            Its terms filled in: pick a fresh schedule and the collateral, then issue.
          </span>
        </div>
        <h3 className="iw-sub">Recently issued</h3>
        <RecentList onPick={pick} />
        <h3 className="iw-sub">Ready-made notes</h3>
        <ReadyMadeList onPick={pick} />
      </section>
      <section className="iw-door" aria-labelledby="door-wizard" data-door="wizard">
        <div className="iw-door-h">
          <h2 id="door-wizard">Product wizard</h2>
          <span className="small muted">Pick a note type and set every term yourself, one step at a time.</span>
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
      <section className="iw-door" aria-labelledby="door-describe" data-door="describe">
        <div className="iw-door-h">
          <h2 id="door-describe">Describe it</h2>
          <span className="small muted">
            The AI writes the note's terms and its workflow; anything missing comes back as a question.
          </span>
        </div>
        <DescribeIt onProduct={fromAi} onWorkflow={aiWorkflow} />
      </section>
    </main>
  );
}

/**
 * "How this note runs": the note's BPMN workflow on its page, read-only. A section that opens and closes (remembered
 * per viewer), a full-screen view, and a panel that says, for the step picked on the diagram, what it does, who
 * acts, when, whether it ran, and the values it captured or checked for this note (lib/stepFacts.ts).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Maximize2, X } from 'lucide-react';
import type { WorkflowDef } from '@sn/core';
import type { NoteState, NoteView } from '@sn/sdk';
import FlowMap from './FlowMap';
import { StepPanel } from './StepPanel';
import { api, type HistoryEvent } from '../lib/api';
import { ranSteps, runsOf, stepFacts, type DiagramElement } from '../lib/stepFacts';

const OPEN_KEY = 'sn.noteflow.open';
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};
const writeOpen = (v: boolean) => {
  try {
    localStorage.setItem(OPEN_KEY, v ? '1' : '0');
  } catch {
    /* storage blocked: the section just doesn't remember */
  }
};

export default function NoteFlow({
  xml,
  def,
  state,
  view,
  sym,
  explorer,
}: {
  xml: string;
  def: WorkflowDef;
  state: NoteState;
  view: NoteView;
  sym: string;
  explorer?: string;
}) {
  const [open, setOpen] = useState(readOpen);
  const [full, setFull] = useState(false);
  const [picked, setPicked] = useState<DiagramElement | null>(null);
  const [history, setHistory] = useState<HistoryEvent[] | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const fullBtn = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  // The history says when each step ran and what it wrote: read it once the diagram is shown, again on each change.
  useEffect(() => {
    if (!open && !full) return;
    let live = true;
    api
      .history(state.id, 500)
      .then((h) => live && setHistory(h.events))
      .catch(() => live && setHistory((x) => x ?? []));
    return () => {
      live = false;
    };
  }, [open, full, state.id, state.updatedAt]);

  const runs = useMemo(() => runsOf(history ?? [], def), [history, def]);
  const ran = useMemo(() => ranSteps(def, state, runs), [def, state, runs]);
  const facts = useMemo(
    () => (picked ? stepFacts(picked, { def, state, view, sym, runs }) : null),
    [picked, def, state, view, sym, runs],
  );
  // The diagram's elements by id (name, type, ways out), to pick a step from outside the diagram.
  const elements = useMemo(() => {
    const out = new Map<string, DiagramElement>();
    try {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const flows = [...doc.getElementsByTagNameNS('*', 'sequenceFlow')];
      for (const e of doc.querySelectorAll('[id]')) {
        const id = e.getAttribute('id')!;
        const type = `bpmn:${e.localName[0].toUpperCase()}${e.localName.slice(1)}`;
        out.set(id, {
          id,
          type,
          name: (e.getAttribute('name') ?? '').replace(/\s+/g, ' ').trim(),
          branches: /Gateway$/.test(type)
            ? flows
                .filter((f) => f.getAttribute('sourceRef') === id)
                .map((f) => (f.getAttribute('name') ?? '').trim())
                .filter(Boolean)
            : [],
        });
      }
    } catch {
      /* the diagram itself reports a workflow it can't draw */
    }
    return out;
  }, [xml]);
  // Where the note is now, by name: buttons that pick those steps (a way in without the diagram).
  const now = useMemo(
    () => view.activeSteps.map((id) => elements.get(id) ?? { id, name: id, type: '', branches: [] }),
    [view.activeSteps, elements],
  );

  const toggle = () => {
    setOpen((o) => {
      writeOpen(!o);
      return !o;
    });
  };
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (full && !d.open) {
      d.showModal();
      closeBtn.current?.focus();
    }
  }, [full]);
  const closeFull = () => {
    dialog.current?.close();
    setFull(false);
    fullBtn.current?.focus();
  };

  const legend = (
    <div className="nf-legend xs muted" aria-hidden="true">
      <span>
        <i className="sw now" /> Where it is now
      </span>
      <span>
        <i className="sw ran" /> Done
      </span>
      <span>
        <i className="sw picked" /> Picked
      </span>
    </div>
  );
  const nowRow = now.length > 0 && (
    <div className="nf-now" role="group" aria-label="Where the note is now">
      <span className="xs muted">Now at:</span>
      {now.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`chip ${picked?.id === s.id ? 'on' : ''}`}
          onClick={() => setPicked(s)}
          data-now-step={s.id}
        >
          {s.name || s.id}
        </button>
      ))}
    </div>
  );

  return (
    <section className="card noteflow" aria-labelledby="nf-h" data-noteflow>
      <div className="nf-head">
        <button
          type="button"
          className="nf-toggle"
          aria-expanded={open}
          aria-controls="nf-body"
          onClick={toggle}
          data-noteflow-toggle
        >
          <h3 id="nf-h">How this note runs</h3>
          <span className="small nf-sh">
            {open ? 'Hide' : 'Show'}
            <ChevronDown className={`i ${open ? 'flip' : ''}`} />
          </span>
        </button>
        {open && (
          <button type="button" className="btn sm" ref={fullBtn} onClick={() => setFull(true)} data-fullscreen>
            <Maximize2 className="i" />
            Full screen
          </button>
        )}
      </div>
      {!open && (
        <p className="xs muted m-0">
          The note's workflow, step by step: who does what, when, and the values each step recorded.
        </p>
      )}
      {open && (
        <div id="nf-body" className="nf-body">
          <p className="xs muted m-0">
            Every step of this note as it runs on-chain. Pick a step to see what it does and its values for this note.
          </p>
          {legend}
          {nowRow}
          {!full && (
            <FlowMap
              xml={xml}
              active={view.activeSteps}
              ran={ran}
              picked={picked?.id ?? null}
              onPick={setPicked}
              label="How this note runs"
            />
          )}
          <StepPanel f={facts} explorer={explorer} />
        </div>
      )}
      <dialog
        ref={dialog}
        className="nf-dialog"
        aria-labelledby="nf-full-h"
        onCancel={(e) => {
          e.preventDefault();
          closeFull();
        }}
        data-noteflow-dialog
      >
        {full && (
          <div className="nf-full">
            <div className="nf-full-h">
              <h2 id="nf-full-h">How this note runs</h2>
              <span className="small muted nf-full-name">{view.name}</span>
              <button
                type="button"
                className="btn sm"
                ref={closeBtn}
                onClick={closeFull}
                aria-label="Close full screen"
                data-close-fullscreen
              >
                <X className="i" />
                Close
              </button>
            </div>
            {legend}
            {nowRow}
            <div className="nf-full-body">
              <FlowMap
                xml={xml}
                active={view.activeSteps}
                ran={ran}
                picked={picked?.id ?? null}
                onPick={setPicked}
                variant="full"
                label="How this note runs, full screen"
              />
              <StepPanel f={facts} explorer={explorer} />
            </div>
          </div>
        )}
      </dialog>
    </section>
  );
}

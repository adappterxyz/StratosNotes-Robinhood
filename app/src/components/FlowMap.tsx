/**
 * A note's workflow, read-only and legible: bpmn-js draws it at a readable scale inside its own scrolling box (wide
 * workflows scroll sideways; the page never does), with zoom in / out / fit, the step where the note is now
 * highlighted, the steps that already ran marked, and every step clickable and keyboard-focusable. Picking a step
 * reports it (onPick); nothing on the diagram can be edited.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Viewer from 'bpmn-js/lib/Viewer';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import { Maximize, Minus, Plus } from 'lucide-react';
import { tagTypes } from '../lib/bpmnTheme';
import type { DiagramElement } from '../lib/stepFacts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Fitting never goes below this scale: labels stay at least ~11px (14px text). Wider workflows scroll instead. */
export const READABLE = 0.8;
const MAX_FIT = 1;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;
const PAD = 24;
/** Text in the diagram: larger than bpmn-js's 12px, in the app's font. */
const TEXT = {
  defaultStyle: { fontSize: 14, fontFamily: 'Geist, "Helvetica Neue", Arial, sans-serif', lineHeight: 1.2 },
  externalStyle: { fontSize: 13 },
};
const SKIP =
  /^bpmn:(Process|Collaboration|SequenceFlow|MessageFlow|Association|DataInputAssociation|DataOutputAssociation)$/;

export function elementOf(el: any): DiagramElement {
  const bo = el.businessObject ?? {};
  return {
    id: el.id,
    type: bo.$type ?? '',
    name: (bo.name ?? '').replace(/\s+/g, ' ').trim(),
    branches: /Gateway$/.test(bo.$type ?? '')
      ? (el.outgoing ?? []).map((c: any) => (c.businessObject?.name ?? '').trim()).filter(Boolean)
      : [],
    pool: /^bpmn:(Participant|Lane)$/.test(el.parent?.businessObject?.$type ?? '')
      ? el.parent.businessObject.name
      : undefined,
  };
}

export default function FlowMap({
  xml,
  active,
  ran = [],
  picked,
  onPick,
  variant = 'inline',
  label = 'Workflow diagram',
}: {
  xml: string;
  active: string[];
  ran?: string[];
  picked: string | null;
  onPick: (el: DiagramElement) => void;
  variant?: 'inline' | 'full';
  label?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<any>(null);
  const box = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [scale, setScaleState] = useState(1);
  const scaleRef = useRef(1);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState('');
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  /** Draw at `next`, keeping the point at (ax, ay) of the visible box where it was (default: the centre). */
  const apply = useCallback((next: number, anchor?: { ax: number; ay: number }) => {
    const v = viewer.current,
      sc = scroller.current,
      h = host.current,
      b = box.current;
    if (!v || !sc || !h || !b) return;
    const prev = scaleRef.current;
    const ax = anchor?.ax ?? sc.clientWidth / 2,
      ay = anchor?.ay ?? sc.clientHeight / 2;
    const cx = (sc.scrollLeft + ax) / prev,
      cy = (sc.scrollTop + ay) / prev;
    const W = b.w + 2 * PAD,
      H = b.h + 2 * PAD;
    h.style.width = `${Math.ceil(W * next)}px`;
    h.style.height = `${Math.ceil(H * next)}px`;
    const canvas = v.get('canvas');
    canvas.resized();
    canvas.viewbox({ x: b.x - PAD, y: b.y - PAD, width: W, height: H });
    scaleRef.current = next;
    setScaleState(next);
    sc.scrollLeft = cx * next - ax;
    sc.scrollTop = cy * next - ay;
  }, []);

  /** Fit the width (never below READABLE, never above 1:1), then bring the step where the note is into view. */
  const fit = useCallback(
    (focus: string[] = []) => {
      const sc = scroller.current,
        b = box.current,
        v = viewer.current;
      if (!sc || !b || !v) return;
      const s = Math.min(MAX_FIT, Math.max(READABLE, sc.clientWidth / (b.w + 2 * PAD)));
      apply(s, { ax: 0, ay: 0 });
      sc.scrollLeft = 0;
      sc.scrollTop = 0;
      const el = focus.map((id) => v.get('elementRegistry').get(id)).find(Boolean);
      if (el) {
        const x = (el.x + el.width / 2 - b.x + PAD) * s,
          y = (el.y + el.height / 2 - b.y + PAD) * s;
        sc.scrollTo({
          left: Math.max(0, x - sc.clientWidth / 2),
          top: Math.max(0, y - sc.clientHeight / 2),
          behavior: 'auto',
        });
      }
    },
    [apply],
  );

  // Draw the workflow.
  useEffect(() => {
    if (!host.current) return;
    const v = new (Viewer as any)({ container: host.current, textRenderer: TEXT });
    viewer.current = v;
    let alive = true;
    setReady(false);
    setFailed('');
    v.importXML(xml)
      .then(() => {
        if (!alive) return;
        tagTypes(v);
        const canvas = v.get('canvas');
        const inner = canvas.viewbox().inner;
        box.current = { x: inner.x, y: inner.y, w: inner.width, h: inner.height };
        // Every step (and each role's lane) is a button: focusable, named, picked with Enter or Space.
        for (const el of v.get('elementRegistry').getAll()) {
          const bo = el.businessObject;
          if (!bo || el.labelTarget || el.waypoints || SKIP.test(bo.$type ?? '') || el === canvas.getRootElement())
            continue;
          const gfx = v.get('elementRegistry').getGraphics(el) as SVGGElement | undefined;
          if (!gfx) continue;
          const d = elementOf(el);
          gfx.setAttribute('tabindex', '0');
          gfx.setAttribute('role', 'button');
          gfx.setAttribute(
            'aria-label',
            d.type === 'bpmn:Participant' ? `Role: ${d.name}` : `${d.name || d.id}: show what this step does`,
          );
        }
        setReady(true);
      })
      .catch((e: unknown) => {
        if (alive) setFailed(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      viewer.current = null;
      box.current = null;
      v.destroy();
    };
  }, [xml]);

  // First view: fit, and show where the note is now.
  const fitted = useRef('');
  useEffect(() => {
    if (!ready || fitted.current === xml) return;
    fitted.current = xml;
    fit(active);
  }, [ready, xml, active, fit]);

  // Markers: where the note is now, what already ran, the step picked.
  useEffect(() => {
    const v = viewer.current;
    if (!ready || !v) return;
    const canvas = v.get('canvas');
    const reg = v.get('elementRegistry');
    for (const e of reg.getAll()) {
      canvas.removeMarker(e.id, 'active-step');
      canvas.removeMarker(e.id, 'ran-step');
      canvas.removeMarker(e.id, 'picked-step');
    }
    const mark = (id: string, c: string) => {
      if (reg.get(id)) canvas.addMarker(id, c);
    };
    for (const id of ran) mark(id, 'ran-step');
    for (const id of active) mark(id, 'active-step');
    if (picked) mark(picked, 'picked-step');
  }, [ready, active, ran, picked]);

  // A step picked from outside the diagram (the "Now at" buttons) scrolls into view.
  useEffect(() => {
    const v = viewer.current,
      sc = scroller.current,
      b = box.current;
    if (!ready || !v || !sc || !b || !picked) return;
    const el = v.get('elementRegistry').get(picked);
    if (!el || el.waypoints) return;
    const s = scaleRef.current;
    const x0 = (el.x - b.x + PAD) * s,
      y0 = (el.y - b.y + PAD) * s,
      x1 = x0 + el.width * s,
      y1 = y0 + el.height * s;
    const seen =
      x0 >= sc.scrollLeft &&
      x1 <= sc.scrollLeft + sc.clientWidth &&
      y0 >= sc.scrollTop &&
      y1 <= sc.scrollTop + sc.clientHeight;
    if (!seen && el.width < sc.clientWidth * 2)
      sc.scrollTo({
        left: Math.max(0, (x0 + x1) / 2 - sc.clientWidth / 2),
        top: Math.max(0, (y0 + y1) / 2 - sc.clientHeight / 2),
      });
  }, [ready, picked]);

  // Picking: a click or tap, Enter / Space, or keyboard focus on a step.
  const pickFrom = (target: EventTarget | null) => {
    const v = viewer.current;
    const g = (target as Element | null)?.closest?.('[data-element-id]');
    if (!v || !g) return false;
    let el = v.get('elementRegistry').get(g.getAttribute('data-element-id'));
    if (el?.labelTarget) el = el.labelTarget;
    if (!el || el.waypoints || SKIP.test(el.businessObject?.$type ?? '')) return false;
    pickRef.current(elementOf(el));
    return true;
  };

  const zoomBy = (f: number) => apply(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scaleRef.current * f)));

  return (
    <div className={`flowmap ${variant}`} data-flowmap={variant}>
      <div className="fm-tools" role="toolbar" aria-label="Zoom">
        <button type="button" className="btn sm icon" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">
          <Minus className="i" />
        </button>
        <span className="fm-scale num" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <button type="button" className="btn sm icon" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
          <Plus className="i" />
        </button>
        <button type="button" className="btn sm" onClick={() => fit(active)} aria-label="Fit to width">
          <Maximize className="i" />
          Fit
        </button>
      </div>
      <div
        className="fm-scroll"
        ref={scroller}
        role="region"
        aria-label={`${label}: scroll to see all of it`}
        tabIndex={-1}
        onClick={(e) => pickFrom(e.target)}
        onFocus={(e) => {
          if (e.target !== scroller.current) pickFrom(e.target);
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && pickFrom(e.target)) e.preventDefault();
        }}
      >
        <div className="bpmn fm-canvas" ref={host} aria-label={label} />
      </div>
      {failed && <p className="xs err">The diagram could not be drawn: {failed}</p>}
    </div>
  );
}

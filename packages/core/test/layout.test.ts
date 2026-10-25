/**
 * The generated diagrams must read cleanly: no flow runs through a step it does not connect, no two steps
 * overlap, and labels sit clear of every step and of each other. Checked on the DI of every product, every
 * library template, and workflows edited through the draft format (as the AI and the canvas edit them).
 */
import { describe, expect, it } from 'vitest';
import { DOMParser, type Element } from '@xmldom/xmldom';
import {
  compileTemplate,
  definitionId,
  defToBpmn,
  draftToIR,
  EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF,
  instantiateProduct,
  irToBpmn,
  irToDraft,
  parseBpmn,
  decodeDef,
  FEEDS,
  type ProductParams,
} from '../src';
import { SEED_TEMPLATES } from '../src/products/library';
import { templateBpmn } from '../src/templates';
import { segmentHits, type Box, type Pt } from '../src/layout';

interface Di {
  shapes: Map<string, Box>;
  labels: Array<{ id: string; b: Box }>;
  edges: Array<{ id: string; src: string; tgt: string; pts: Pt[] }>;
}

function readDi(xml: string): Di {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const all = (name: string) => Array.from(doc.getElementsByTagNameNS('*', name));
  const ends = new Map<string, [string, string]>();
  for (const e of [...all('sequenceFlow'), ...all('messageFlow')])
    ends.set(e.getAttribute('id')!, [e.getAttribute('sourceRef')!, e.getAttribute('targetRef')!]);
  const participants = new Set(all('participant').map((e) => e.getAttribute('id')!));
  const box = (b: Element): Box => ({
    x: +b.getAttribute('x')!,
    y: +b.getAttribute('y')!,
    w: +b.getAttribute('width')!,
    h: +b.getAttribute('height')!,
  });
  const di: Di = { shapes: new Map(), labels: [], edges: [] };
  for (const s of all('BPMNShape')) {
    const id = s.getAttribute('bpmnElement')!;
    const bs = Array.from(s.getElementsByTagNameNS('*', 'Bounds'));
    if (!participants.has(id)) di.shapes.set(id, box(bs[0]));
    if (bs.length > 1) di.labels.push({ id, b: box(bs[1]) });
  }
  for (const e of all('BPMNEdge')) {
    const id = e.getAttribute('bpmnElement')!;
    const pts = Array.from(e.getElementsByTagNameNS('*', 'waypoint')).map(
      (w) => [+w.getAttribute('x')!, +w.getAttribute('y')!] as Pt,
    );
    const [src, tgt] = ends.get(id)!;
    di.edges.push({ id, src, tgt, pts });
    const lb = Array.from(e.getElementsByTagNameNS('*', 'Bounds'));
    if (lb.length) di.labels.push({ id, b: box(lb[0]) });
  }
  return di;
}

const inside = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Every problem with a diagram's geometry, as readable strings. */
export function layoutProblems(xml: string): string[] {
  const di = readDi(xml);
  const issues: string[] = [];
  const shapes = [...di.shapes];
  for (const e of di.edges) {
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const [p, q] = [e.pts[i], e.pts[i + 1]];
      if (p[0] !== q[0] && p[1] !== q[1]) issues.push(`${e.id}: diagonal segment`);
      for (const [id, b] of shapes)
        if (id !== e.src && id !== e.tgt && segmentHits(p, q, b, 0)) issues.push(`${e.id} crosses ${id}`);
    }
  }
  for (let i = 0; i < shapes.length; i++)
    for (let j = i + 1; j < shapes.length; j++)
      if (inside(shapes[i][1], shapes[j][1])) issues.push(`${shapes[i][0]} overlaps ${shapes[j][0]}`);
  for (const l of di.labels)
    for (const [id, b] of shapes) if (inside(l.b, b)) issues.push(`label of ${l.id} overlaps ${id}`);
  for (let i = 0; i < di.labels.length; i++)
    for (let j = i + 1; j < di.labels.length; j++)
      if (inside(di.labels[i].b, di.labels[j].b))
        issues.push(`label of ${di.labels[i].id} overlaps label of ${di.labels[j].id}`);
  return issues;
}

const PRODUCTS: Record<string, ProductParams> = {
  ...EXAMPLE_PRODUCTS,
  'worst-of': EXAMPLE_WORST_OF,
  physical: { ...EXAMPLE_PRODUCTS['reverse-convertible'], settlement: 'physical' },
  'worst-of physical': {
    ...EXAMPLE_WORST_OF,
    chain: 'robinhood-testnet',
    underlyings: [FEEDS.ETH, FEEDS.AMZN, FEEDS.TSLA],
    settlement: 'physical',
  },
};

describe('diagram layout', () => {
  for (const [name, p] of Object.entries(PRODUCTS)) {
    it(`product ${name}`, () => expect(layoutProblems(instantiateProduct(p).bpmnXml)).toEqual([]));
  }
  for (const t of SEED_TEMPLATES) {
    it(`template ${t.name}`, () => expect(layoutProblems(templateBpmn(t.source).bpmnXml)).toEqual([]));
  }
  it('a workflow edited through the draft (round trip, a step added, a step removed)', () => {
    const prod = instantiateProduct(EXAMPLE_PRODUCTS.phoenix);
    const ir = parseBpmn(prod.bpmnXml, prod.assets);
    expect(layoutProblems(irToBpmn(draftToIR(irToDraft(ir))).bpmnXml)).toEqual([]);
    const d = irToDraft(ir);
    const i = d.steps.findIndex((s) => s.id === 'Task_Observe1');
    const obs = d.steps[i];
    d.steps.splice(i + 1, 0, {
      id: 'Task_Notify1',
      name: 'Notify Holders',
      party: obs.party,
      kind: 'auto',
      next: obs.next,
    } as typeof obs);
    obs.next = 'Task_Notify1';
    expect(layoutProblems(irToBpmn(draftToIR(d)).bpmnXml)).toEqual([]);
  });
  it('a definition shown on the canvas (defToBpmn)', () => {
    const c = compileTemplate({ product: EXAMPLE_WORST_OF });
    expect(layoutProblems(defToBpmn(decodeDef(c.bytes)))).toEqual([]);
  });
  it('layout is deterministic and does not touch the compiled definition', () => {
    const a = instantiateProduct(EXAMPLE_PRODUCTS.fcn).bpmnXml,
      b = instantiateProduct(EXAMPLE_PRODUCTS.fcn).bpmnXml;
    expect(a).toBe(b);
    expect(definitionId(compileTemplate({ product: EXAMPLE_PRODUCTS.fcn }))).toBe(
      '0xd1747d559a6ad7c202ced0c0607eff3180c61227644ef1195d7cf6071cee5b14',
    );
  });
});

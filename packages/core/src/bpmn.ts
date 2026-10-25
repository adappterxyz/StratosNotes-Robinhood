/**
 * BPMN 2.0 collaboration XML <-> workflow IR.
 *
 * Step properties live in each element's extensionElements as
 * <flow:Properties templateFields="[json]" assetOperation="{json}" timer="{json}"
 * receiveGuard="..."/>. Flow's <canton:Properties> is read the same way, so
 * diagrams exported from Flow import unchanged.
 */
import { DOMParser } from '@xmldom/xmldom';
import { layoutCollaboration, type Box, type Pt } from './layout';
import {
  MILESTONES,
  type AssetDefinition,
  type IrFlow,
  type IrMessageFlow,
  type IrNode,
  type IrPool,
  type Milestone,
  type NodeProps,
  type NodeType,
  type PropsMap,
  type TemplateField,
  type WorkflowIR,
} from './types';

export const FLOW_NS = 'https://stratosnotes.dev/bpmn';

const NODE_TYPES: NodeType[] = [
  'startEvent',
  'endEvent',
  'userTask',
  'serviceTask',
  'task',
  'receiveTask',
  'sendTask',
  'exclusiveGateway',
  'parallelGateway',
  'intermediateCatchEvent',
];

// Structural DOM shape shared by the browser DOMParser and @xmldom; child nodes are narrowed by nodeType below.
type El = {
  localName: string;
  getAttribute(n: string): string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  childNodes: ArrayLike<any>;
  textContent: string | null;
};

const local = (e: El) => e.localName || '';
const kids = (e: El, name?: string): El[] => {
  const out: El[] = [];
  for (let i = 0; i < e.childNodes.length; i++) {
    const c = e.childNodes[i];
    if (c.nodeType === 1 && (!name || local(c) === name)) out.push(c);
  }
  return out;
};

function readProps(el: El): NodeProps {
  const props: NodeProps = {};
  const ext = kids(el, 'extensionElements')[0];
  const p = ext && kids(ext).find((c) => local(c) === 'Properties' || local(c) === 'properties');
  if (p) {
    const json = <T>(name: string): T | undefined => {
      const v = p.getAttribute(name);
      if (!v) return undefined;
      try {
        return JSON.parse(v) as T;
      } catch {
        throw new Error(`${el.getAttribute('id')}: ${name} is not valid JSON`);
      }
    };
    const tf = json<TemplateField[]>('templateFields');
    if (tf?.length) props.templateFields = tf;
    const ao = json<NodeProps['assetOperation']>('assetOperation');
    if (ao) props.assetOperation = ao;
    const aos = json<NodeProps['assetOperations']>('assetOperations');
    if (aos?.length) props.assetOperations = aos;
    const until = json<NodeProps['until']>('until');
    if (until) props.until = until;
    const timer = json<NodeProps['timer']>('timer');
    if (timer) props.timer = timer;
    const guard = p.getAttribute('receiveGuard');
    if (guard) props.receiveGuard = guard;
    const ctrl = p.getAttribute('controllers');
    if (ctrl)
      props.controllers = ctrl
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const ms = p.getAttribute('milestone');
    if (ms) {
      if (!(ms in MILESTONES)) throw new Error(`${el.getAttribute('id')}: unknown milestone '${ms}'`);
      props.milestone = ms as Milestone;
    }
    const notify = json<NodeProps['notify']>('notify');
    if (notify?.length) props.notify = notify;
  }
  // Standard BPMN timer (any tool): <timerEventDefinition><timeDate>.
  const td = kids(el, 'timerEventDefinition')[0];
  const date = td && kids(td, 'timeDate')[0]?.textContent?.trim();
  if (date && !props.timer) props.timer = { date };
  return props;
}

export function parseBpmn(xml: string, assets: AssetDefinition[] = []): WorkflowIR {
  const doc = new DOMParser().parseFromString(xml.replace(/<\?xml[^?]*\?>\s*/g, ''), 'text/xml');
  const root = doc.documentElement as unknown as El;
  if (!root || local(root) !== 'definitions') throw new Error('Not a BPMN document (no definitions root)');
  const collab = kids(root, 'collaboration')[0];
  const processes = kids(root, 'process');
  if (!processes.length) throw new Error('No process in the BPMN document');

  const procToPool = new Map<string, IrPool>();
  const pools: IrPool[] = [];
  for (const part of collab ? kids(collab, 'participant') : []) {
    const pool: IrPool = {
      id: part.getAttribute('id') || '',
      name: part.getAttribute('name') || part.getAttribute('id') || '',
    };
    if (part.getAttribute('flow:escrow') === 'true') pool.escrow = true;
    if (part.getAttribute('flow:open') === 'true') pool.open = true;
    pools.push(pool);
    const ref = part.getAttribute('processRef');
    if (ref) procToPool.set(ref, pool);
  }
  if (!pools.length) {
    const only = { id: 'Pool_1', name: processes[0].getAttribute('name') || 'Initiator' };
    pools.push(only);
    procToPool.set(processes[0].getAttribute('id') || '', only);
  }

  const nodes: IrNode[] = [];
  const flows: IrFlow[] = [];
  for (const proc of processes) {
    const pool = procToPool.get(proc.getAttribute('id') || '') ?? pools[0];
    for (const el of kids(proc)) {
      const t = local(el) as NodeType;
      if (NODE_TYPES.includes(t)) {
        const id = el.getAttribute('id') || '';
        nodes.push({
          id,
          type: t,
          name: el.getAttribute('name') || id,
          pool: pool.id,
          props: readProps(el),
          incoming: [],
          outgoing: [],
          ...(el.getAttribute('default') ? { defaultFlow: el.getAttribute('default')! } : {}),
        });
      } else if (local(el) === 'sequenceFlow') {
        const cond = kids(el, 'conditionExpression')[0]?.textContent?.trim();
        flows.push({
          id: el.getAttribute('id') || '',
          source: el.getAttribute('sourceRef') || '',
          target: el.getAttribute('targetRef') || '',
          ...(el.getAttribute('name') ? { name: el.getAttribute('name')! } : {}),
          ...(cond ? { condition: cond } : {}),
        });
      }
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const f of flows) {
    byId.get(f.source)?.outgoing.push(f.id);
    byId.get(f.target)?.incoming.push(f.id);
  }
  const messageFlows = (collab ? kids(collab, 'messageFlow') : []).map((m): IrMessageFlow => ({
    id: m.getAttribute('id') || '',
    source: m.getAttribute('sourceRef') || '',
    target: m.getAttribute('targetRef') || '',
    ...(m.getAttribute('flow:notice') === 'true' ? { notice: true } : {}),
  }));
  const defs = root.getAttribute('id') || 'Workflow';
  return {
    name: collab?.getAttribute('name') || defs.replace(/^Definitions_/, ''),
    pools,
    nodes,
    flows,
    messageFlows,
    assets,
  };
}

// ---------------------------------------------------------------------------
// Deterministic builder (Flow's products/bpmn-builder.ts): a compact pool/grid
// spec in, laid-out BPMN XML with the step properties embedded out.

export interface SpecNode {
  id: string;
  type: 'startEvent' | 'endEvent' | 'userTask' | 'serviceTask' | 'receiveTask' | 'exclusiveGateway' | 'parallelGateway';
  name: string;
  /** Layout hints. Columns and rows are computed from the graph (layout.ts); `row: 0` marks the happy path. */
  col?: number;
  row?: number;
  props?: NodeProps;
}
export interface SpecFlow {
  id: string;
  src: string;
  tgt: string;
  name?: string;
  cond?: string;
  isDefault?: boolean;
}
export interface SpecPool {
  id: string;
  name: string;
  proc: string;
  nodes: SpecNode[];
  flows: SpecFlow[];
  escrow?: boolean;
  open?: boolean;
}
export interface SpecMessage {
  id: string;
  src: string;
  tgt: string;
  notice?: boolean;
}
export interface BuildSpec {
  key: string;
  name: string;
  pools: SpecPool[];
  messages: SpecMessage[];
  assets: AssetDefinition[];
}
export interface BuiltWorkflow {
  bpmnXml: string;
  props: PropsMap;
  assets: AssetDefinition[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const field = (
  name: string,
  type: TemplateField['type'],
  extra: Partial<TemplateField> = {},
): TemplateField => ({ name, type, ...extra });
export const chain = (prefix: string, ...ids: string[]): SpecFlow[] =>
  ids.slice(1).map((tgt, i) => ({ id: `${prefix}${i + 1}`, src: ids[i], tgt }));

function propsXml(p: NodeProps | undefined): string {
  if (!p) return '';
  const attrs: string[] = [];
  if (p.templateFields?.length) attrs.push(`templateFields="${esc(JSON.stringify(p.templateFields))}"`);
  if (p.assetOperation) attrs.push(`assetOperation="${esc(JSON.stringify(p.assetOperation))}"`);
  if (p.assetOperations?.length) attrs.push(`assetOperations="${esc(JSON.stringify(p.assetOperations))}"`);
  if (p.until) attrs.push(`until="${esc(JSON.stringify(p.until))}"`);
  if (p.timer) attrs.push(`timer="${esc(JSON.stringify(p.timer))}"`);
  if (p.receiveGuard) attrs.push(`receiveGuard="${esc(p.receiveGuard)}"`);
  if (p.milestone) attrs.push(`milestone="${p.milestone}"`);
  if (p.notify?.length) attrs.push(`notify="${esc(JSON.stringify(p.notify))}"`);
  return attrs.length ? `<bpmn:extensionElements><flow:Properties ${attrs.join(' ')} /></bpmn:extensionElements>` : '';
}

export function buildWorkflow(spec: BuildSpec): BuiltWorkflow {
  const lay = layoutCollaboration(
    spec.pools.map((p) => ({
      id: p.id,
      nodes: p.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, rowHint: n.row })),
      flows: p.flows,
    })),
    spec.messages,
  );
  const bounds = (b: Box) => `<dc:Bounds x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" />`;
  const label = (id: string) =>
    lay.labels[id] ? `<bpmndi:BPMNLabel>${bounds(lay.labels[id])}</bpmndi:BPMNLabel>` : '';
  const shapes: string[] = [],
    edges: string[] = [],
    procs: string[] = [];
  for (const p of spec.pools) {
    shapes.push(
      `      <bpmndi:BPMNShape id="${p.id}_di" bpmnElement="${p.id}" isHorizontal="true">${bounds(lay.pools[p.id])}</bpmndi:BPMNShape>`,
    );
    for (const n of p.nodes) {
      const marker = n.type === 'exclusiveGateway' ? ' isMarkerVisible="true"' : '';
      shapes.push(
        `      <bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${marker}>${bounds(lay.shapes[n.id])}${label(n.id)}</bpmndi:BPMNShape>`,
      );
    }
  }
  const pts = (ps: Pt[]) => ps.map(([a, b]) => `<di:waypoint x="${a}" y="${b}" />`).join('');
  for (const p of spec.pools) {
    const lines = [`  <bpmn:process id="${p.proc}" isExecutable="${p.nodes.length ? 'true' : 'false'}">`];
    const defaults = new Map(p.flows.filter((f) => f.isDefault).map((f) => [f.src, f.id]));
    for (const n of p.nodes) {
      const d = defaults.has(n.id) ? ` default="${defaults.get(n.id)}"` : '';
      const inner = propsXml(n.props);
      lines.push(
        inner
          ? `    <bpmn:${n.type} id="${n.id}" name="${esc(n.name)}"${d}>${inner}</bpmn:${n.type}>`
          : `    <bpmn:${n.type} id="${n.id}" name="${esc(n.name)}"${d} />`,
      );
    }
    for (const f of p.flows) {
      const nm = f.name ? ` name="${esc(f.name)}"` : '';
      lines.push(
        f.cond
          ? `    <bpmn:sequenceFlow id="${f.id}"${nm} sourceRef="${f.src}" targetRef="${f.tgt}"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${esc(f.cond)}</bpmn:conditionExpression></bpmn:sequenceFlow>`
          : `    <bpmn:sequenceFlow id="${f.id}"${nm} sourceRef="${f.src}" targetRef="${f.tgt}" />`,
      );
      edges.push(
        `      <bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}">${pts(lay.edges[f.id])}${label(f.id)}</bpmndi:BPMNEdge>`,
      );
    }
    lines.push('  </bpmn:process>');
    procs.push(lines.join('\n'));
  }
  for (const m of spec.messages)
    edges.push(
      `      <bpmndi:BPMNEdge id="${m.id}_di" bpmnElement="${m.id}">${pts(lay.edges[m.id])}</bpmndi:BPMNEdge>`,
    );
  const k = spec.key;
  const bpmnXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:flow="${FLOW_NS}"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  id="Definitions_${k}" targetNamespace="${FLOW_NS}">
  <bpmn:collaboration id="Collab_${k}" name="${esc(spec.name)}">
${spec.pools.map((p) => `    <bpmn:participant id="${p.id}" name="${esc(p.name)}" processRef="${p.proc}"${p.escrow ? ' flow:escrow="true"' : ''}${p.open ? ' flow:open="true"' : ''} />`).join('\n')}
${spec.messages.map((m) => `    <bpmn:messageFlow id="${m.id}"${m.notice ? ' flow:notice="true"' : ''} sourceRef="${m.src}" targetRef="${m.tgt}" />`).join('\n')}
  </bpmn:collaboration>
${procs.join('\n')}
  <bpmndi:BPMNDiagram id="BPMNDiagram_${k}">
    <bpmndi:BPMNPlane id="BPMNPlane_${k}" bpmnElement="Collab_${k}">
${shapes.join('\n')}
${edges.join('\n')}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
  const props: PropsMap = {};
  for (const p of spec.pools) for (const n of p.nodes) if (n.props) props[n.id] = n.props;
  return { bpmnXml, props, assets: spec.assets };
}

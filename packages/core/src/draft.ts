/**
 * Workflow drafts (Flow's ai/workflow-draft.ts, for the Solana engine): a
 * compact JSON form of a BPMN collaboration that maps 1:1 onto the IR. The AI
 * reads the open workflow as a draft and answers with a PATCH (upsert whole
 * steps, remove ids), so step ids and everything it did not touch survive;
 * the BPMN and its layout are then produced deterministically.
 */
import { buildWorkflow, type SpecFlow, type SpecNode, type SpecPool } from './bpmn';
import type { NotifyDecl } from './notify';
import type {
  AssetDefinition,
  AssetOperation,
  IrFlow,
  IrNode,
  Milestone,
  NodeType,
  TemplateField,
  WorkflowIR,
} from './types';

export type StepKind = 'start' | 'task' | 'auto' | 'receive' | 'decision' | 'parallel' | 'end';
export interface DraftBranch {
  label?: string;
  condition?: string;
  next: string;
  default?: boolean;
}
export interface DraftStep {
  id: string;
  party: string;
  kind: StepKind;
  name: string;
  fields?: TemplateField[];
  next?: string;
  branches?: DraftBranch[];
  sendTo?: string[];
  /** Notice message flows (drawn, not token handoffs): e.g. a funding window informing the paying agent. */
  noticeTo?: string[];
  timerField?: string;
  timerDate?: string;
  /** Repeatable window until this Date field (user tasks: e.g. a subscription book). */
  untilField?: string;
  guard?: string;
  ops?: AssetOperation[];
  /** The business event this step announces (collateral pledged, payment made, defaulted, ...). */
  milestone?: Milestone;
  /** Email notifications (notify.ts): when, to whom, and which template. Keep them when editing a step. */
  notify?: NotifyDecl[];
}
export interface WorkflowDraft {
  name: string;
  parties: string[];
  /** Parties that are escrow accounts the engine holds (no steps, nobody signs for them). */
  escrow?: string[];
  /** Parties anyone may act in (e.g. the investors' subscription book). */
  open?: string[];
  assets: AssetDefinition[];
  steps: DraftStep[];
}
export interface DraftPatch {
  name?: string;
  parties?: string[];
  assets?: AssetDefinition[];
  upsert?: DraftStep[];
  remove?: string[];
}

const KIND_TO_TYPE: Record<StepKind, NodeType> = {
  start: 'startEvent',
  task: 'userTask',
  auto: 'serviceTask',
  receive: 'receiveTask',
  decision: 'exclusiveGateway',
  parallel: 'parallelGateway',
  end: 'endEvent',
};
const TYPE_TO_KIND: Partial<Record<NodeType, StepKind>> = {
  startEvent: 'start',
  userTask: 'task',
  serviceTask: 'auto',
  task: 'auto',
  sendTask: 'auto',
  receiveTask: 'receive',
  exclusiveGateway: 'decision',
  parallelGateway: 'parallel',
  endEvent: 'end',
  intermediateCatchEvent: 'auto',
};
const poolId = (party: string) => `Part_${party.replace(/[^A-Za-z0-9]+/g, '')}`;

export function irToDraft(ir: WorkflowIR): WorkflowDraft {
  const flowById = new Map(ir.flows.map((f) => [f.id, f]));
  const poolName = new Map(ir.pools.map((p) => [p.id, p.name]));
  const steps = ir.nodes.map((n): DraftStep => {
    const kind = TYPE_TO_KIND[n.type] ?? 'auto';
    const outs = n.outgoing.map((f) => flowById.get(f)!).filter(Boolean);
    const p = n.props;
    const s: DraftStep = { id: n.id, party: poolName.get(n.pool) ?? n.pool, kind, name: n.name };
    if (p.templateFields?.length) s.fields = p.templateFields;
    if ((kind === 'decision' || kind === 'parallel') && outs.length > 1) {
      s.branches = outs.map((f) => ({
        ...(f.name ? { label: f.name } : {}),
        ...(f.condition ? { condition: f.condition } : {}),
        next: f.target,
        ...(n.defaultFlow === f.id ? { default: true } : {}),
      }));
    } else if (outs.length) s.next = outs[0].target;
    const sends = ir.messageFlows.filter((m) => m.source === n.id && !m.notice).map((m) => m.target);
    if (sends.length) s.sendTo = sends;
    const notices = ir.messageFlows.filter((m) => m.source === n.id && m.notice).map((m) => m.target);
    if (notices.length) s.noticeTo = notices;
    if (p.milestone) s.milestone = p.milestone;
    if (p.notify?.length) s.notify = p.notify;
    if (p.timer?.dateField) s.timerField = p.timer.dateField;
    if (p.timer?.date) s.timerDate = p.timer.date;
    if (p.until?.dateField) s.untilField = p.until.dateField;
    if (p.receiveGuard) s.guard = p.receiveGuard;
    const ops = [...(p.assetOperation ? [p.assetOperation] : []), ...(p.assetOperations ?? [])];
    if (ops.length) s.ops = ops;
    return s;
  });
  const escrow = ir.pools.filter((p) => p.escrow).map((p) => p.name);
  const open = ir.pools.filter((p) => p.open).map((p) => p.name);
  return {
    name: ir.name,
    parties: ir.pools.map((p) => p.name),
    ...(escrow.length ? { escrow } : {}),
    ...(open.length ? { open } : {}),
    assets: ir.assets,
    steps,
  };
}

export function draftToIR(d: WorkflowDraft): WorkflowIR {
  const escrow = new Set(d.escrow ?? []);
  const open = new Set(d.open ?? []);
  const pools = d.parties.map((name) => ({
    id: poolId(name),
    name,
    ...(escrow.has(name) ? { escrow: true } : {}),
    ...(open.has(name) ? { open: true } : {}),
  }));
  const flows: IrFlow[] = [];
  const nodes: IrNode[] = d.steps.map((s) => ({
    id: s.id,
    type: KIND_TO_TYPE[s.kind] ?? 'serviceTask',
    name: s.name,
    pool: poolId(s.party),
    props: {},
    incoming: [],
    outgoing: [],
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const addFlow = (src: string, b: DraftBranch) => {
    const id = `F_${src}_${b.next}`;
    if (flows.some((f) => f.id === id)) return;
    flows.push({
      id,
      source: src,
      target: b.next,
      ...(b.label ? { name: b.label } : {}),
      ...(b.condition ? { condition: b.condition } : {}),
    });
    byId.get(src)?.outgoing.push(id);
    byId.get(b.next)?.incoming.push(id);
    if (b.default) byId.get(src)!.defaultFlow = id;
  };
  for (const s of d.steps) {
    const n = byId.get(s.id)!;
    const ops = s.ops ?? [];
    n.props = {
      ...(s.fields?.length ? { templateFields: s.fields } : {}),
      ...(ops.length === 1 ? { assetOperation: ops[0] } : ops.length > 1 ? { assetOperations: ops } : {}),
      ...(s.timerField ? { timer: { dateField: s.timerField } } : s.timerDate ? { timer: { date: s.timerDate } } : {}),
      ...(s.untilField ? { until: { dateField: s.untilField } } : {}),
      ...(s.guard ? { receiveGuard: s.guard } : {}),
      ...(s.milestone ? { milestone: s.milestone } : {}),
      ...(s.notify?.length ? { notify: s.notify } : {}),
    };
    if (s.branches?.length) {
      for (const b of s.branches) addFlow(s.id, b);
      // A conditioned decision whose unconditioned branch is not marked: that branch is the default.
      if (s.kind === 'decision' && !n.defaultFlow && s.branches.some((b) => b.condition)) {
        const dflt = s.branches.find((b) => !b.condition);
        if (dflt) n.defaultFlow = `F_${s.id}_${dflt.next}`;
      }
    } else if (s.next) addFlow(s.id, { next: s.next });
  }
  const messageFlows = d.steps.flatMap((s) => [
    ...(s.sendTo ?? []).map((t) => ({ id: `M_${s.id}_${t}`, source: s.id, target: t })),
    ...(s.noticeTo ?? []).map((t) => ({ id: `N_${s.id}_${t}`, source: s.id, target: t, notice: true })),
  ]);
  return { name: d.name, pools, nodes, flows, messageFlows, assets: d.assets };
}

export function applyPatch(base: WorkflowDraft, patch: DraftPatch): WorkflowDraft {
  const remove = new Set(patch.remove ?? []);
  const upsert = new Map((patch.upsert ?? []).map((s) => [s.id, s]));
  const steps = base.steps.filter((s) => !remove.has(s.id)).map((s) => upsert.get(s.id) ?? s);
  for (const s of patch.upsert ?? []) if (!base.steps.some((b) => b.id === s.id)) steps.push(s);
  // Links to removed steps would dangle: drop them (the validator then flags any gap).
  const ids = new Set(steps.map((s) => s.id));
  const clean = steps.map((s) => ({
    ...s,
    ...(s.next && !ids.has(s.next) ? { next: undefined } : {}),
    ...(s.branches ? { branches: s.branches.filter((b) => ids.has(b.next)) } : {}),
    ...(s.sendTo ? { sendTo: s.sendTo.filter((t) => ids.has(t)) } : {}),
    ...(s.noticeTo ? { noticeTo: s.noticeTo.filter((t) => ids.has(t)) } : {}),
  }));
  // Escrow parties stay even though no step names them (they hold no steps).
  const parties = [
    ...new Set([
      ...(patch.parties?.length ? patch.parties : base.parties),
      ...(base.escrow ?? []),
      ...clean.map((s) => s.party),
    ]),
  ];
  const assets = patch.assets?.length
    ? [...base.assets.filter((a) => !patch.assets!.some((p) => p.id === a.id)), ...patch.assets]
    : base.assets;
  return {
    name: patch.name || base.name,
    parties,
    ...(base.escrow?.length ? { escrow: base.escrow } : {}),
    ...(base.open?.length ? { open: base.open } : {}),
    assets,
    steps: clean,
  };
}

/**
 * Lay the IR out on a grid and build BPMN: columns by longest path (a message
 * target sits right of its sender), branches drop to new rows.
 */
export function irToBpmn(
  ir: WorkflowIR,
  key = 'WF',
  layout?: Record<string, { col: number; row: number }>,
): { bpmnXml: string } {
  const pos = new Map<string, { col: number; row: number }>();
  const flowById = new Map(ir.flows.map((f) => [f.id, f]));
  const preds = new Map<string, string[]>();
  for (const f of ir.flows) preds.set(f.target, [...(preds.get(f.target) ?? []), f.source]);
  for (const m of ir.messageFlows) preds.set(m.target, [...(preds.get(m.target) ?? []), m.source]);
  const col = new Map<string, number>();
  for (let iter = 0; iter < ir.nodes.length + 2; iter++) {
    let changed = false;
    for (const n of ir.nodes) {
      const c = Math.max(0, ...(preds.get(n.id) ?? []).map((p) => (col.get(p) ?? -1) + 1));
      if (col.get(n.id) !== c && c <= ir.nodes.length) {
        col.set(n.id, c);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Rows: per pool, the first successor keeps its parent's row, later branches take new rows.
  const rowOf = new Map<string, number>();
  const nextRow = new Map<string, number>();
  const byPool = new Map<string, IrNode[]>();
  for (const n of ir.nodes) byPool.set(n.pool, [...(byPool.get(n.pool) ?? []), n]);
  for (const [pool, ns] of byPool) {
    nextRow.set(pool, 1);
    const sorted = [...ns].sort((a, b) => (col.get(a.id) ?? 0) - (col.get(b.id) ?? 0));
    for (const n of sorted) {
      if (!rowOf.has(n.id)) rowOf.set(n.id, 0);
      const outs = n.outgoing.map((f) => flowById.get(f)!.target).filter((t) => ns.some((x) => x.id === t));
      outs.forEach((t, i) => {
        if (rowOf.has(t)) return;
        const isDefault = n.defaultFlow && flowById.get(n.defaultFlow)?.target === t;
        if (i === 0 || (isDefault && outs.length === 1)) rowOf.set(t, rowOf.get(n.id)!);
        else {
          rowOf.set(t, nextRow.get(pool)!);
          nextRow.set(pool, nextRow.get(pool)! + 1);
        }
      });
    }
  }
  // A known layout (an edited product keeps its own); the rest is laid out above, then nudged off taken cells.
  if (layout)
    for (const n of ir.nodes)
      if (layout[n.id]) {
        col.set(n.id, layout[n.id].col);
        rowOf.set(n.id, layout[n.id].row);
      }
  // Two steps on one cell: push the later one down.
  const taken = new Set<string>();
  for (const n of ir.nodes) {
    let r = rowOf.get(n.id) ?? 0;
    while (taken.has(`${n.pool}:${col.get(n.id)}:${r}`)) r++;
    taken.add(`${n.pool}:${col.get(n.id)}:${r}`);
    pos.set(n.id, { col: col.get(n.id) ?? 0, row: r });
  }
  const pools: SpecPool[] = ir.pools.map((p) => ({
    id: p.id,
    name: p.name,
    proc: `Proc_${p.id}`,
    ...(p.escrow ? { escrow: true } : {}),
    ...(p.open ? { open: true } : {}),
    nodes: ir.nodes
      .filter((n) => n.pool === p.id)
      .map((n): SpecNode => ({
        id: n.id,
        type: (n.type === 'task' || n.type === 'sendTask' || n.type === 'intermediateCatchEvent'
          ? 'serviceTask'
          : n.type) as SpecNode['type'],
        name: n.name,
        col: pos.get(n.id)!.col,
        row: pos.get(n.id)!.row,
        ...(Object.keys(n.props).length ? { props: n.props } : {}),
      })),
    flows: ir.flows
      .filter((f) => ir.nodes.find((n) => n.id === f.source)?.pool === p.id)
      .map((f): SpecFlow => {
        const src = ir.nodes.find((n) => n.id === f.source)!;
        return {
          id: f.id,
          src: f.source,
          tgt: f.target,
          ...(f.name ? { name: f.name } : {}),
          ...(f.condition ? { cond: f.condition } : {}),
          ...(src.defaultFlow === f.id ? { isDefault: true } : {}),
        };
      }),
  }));
  return {
    bpmnXml: buildWorkflow({
      key,
      name: ir.name,
      pools,
      messages: ir.messageFlows.map((m) => ({
        id: m.id,
        src: m.source,
        tgt: m.target,
        ...(m.notice ? { notice: true } : {}),
      })),
      assets: ir.assets,
    }).bpmnXml,
  };
}

/**
 * Redraw any on-chain workflow: a decoded definition back to an IR (step
 * kinds, pools, links, message flows, names from the definition's metadata),
 * which irToBpmn lays out. Conditions are shown as labels only.
 */
import type { WorkflowDef } from './def-types';
import type { NotifyDecl } from './notify';
import type { IrNode, NodeType, WorkflowIR } from './types';
import { irToBpmn } from './draft';

const TYPE: Record<number, NodeType> = {
  0: 'startEvent',
  1: 'endEvent',
  2: 'userTask',
  3: 'serviceTask',
  4: 'receiveTask',
  5: 'exclusiveGateway',
  6: 'parallelGateway',
  7: 'intermediateCatchEvent',
};

export function defToIR(def: WorkflowDef): WorkflowIR {
  let names: Record<string, string> = {};
  let notify: Record<string, NotifyDecl[]> = {};
  try {
    const m = JSON.parse(def.meta) as { names?: Record<string, string>; notify?: Record<string, NotifyDecl[]> };
    names = m.names ?? {};
    notify = m.notify ?? {};
  } catch {
    /* ids only */
  }
  const pools = def.roles.map((r, i) => ({ id: `Pool_${i}`, name: r }));
  const nodes: IrNode[] = def.steps.map((s) => ({
    id: s.id,
    type: TYPE[s.kind] ?? 'serviceTask',
    name: names[s.id] ?? s.id,
    pool: `Pool_${s.role}`,
    props: notify[s.id] ? { notify: notify[s.id] } : {},
    incoming: [],
    outgoing: [],
  }));
  const flows = def.steps.flatMap((s, i) =>
    s.next.map((e) => ({
      id: `F_${i}_${e.target}`,
      source: s.id,
      target: def.steps[e.target].id,
      ...(e.cond !== 0xffff ? { name: 'if …' } : {}),
    })),
  );
  for (const f of flows) {
    nodes.find((n) => n.id === f.source)!.outgoing.push(f.id);
    nodes.find((n) => n.id === f.target)!.incoming.push(f.id);
  }
  def.steps.forEach((s, i) => {
    const d = s.next.find((e) => e.isDefault);
    if (d) nodes[i].defaultFlow = `F_${i}_${d.target}`;
  });
  const messageFlows = def.steps.flatMap((s, i) =>
    s.sends.map((t) => ({ id: `M_${i}_${t}`, source: s.id, target: def.steps[t].id })),
  );
  return { name: def.name, pools, nodes, flows, messageFlows, assets: [] };
}

export const defToBpmn = (def: WorkflowDef) => irToBpmn(defToIR(def), 'DEF').bpmnXml;

/**
 * Step properties on the canvas: the <flow:Properties> extension element
 * (packages/flow/src/bpmn.ts reads the same attributes), registered with
 * bpmn-js so edits round-trip through the modeler.
 */
import { FLOW_NS, type NodeProps } from '@sn/core';

export const flowModdle = {
  name: 'Flow',
  uri: FLOW_NS,
  prefix: 'flow',
  xml: { tagAlias: 'lowerCase' },
  types: [
    {
      name: 'Properties',
      superClass: ['Element'],
      properties: ['templateFields', 'assetOperation', 'assetOperations', 'timer', 'until', 'receiveGuard'].map(
        (name) => ({ name, isAttr: true, type: 'String' }),
      ),
    },
  ],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bo = any;

const extOf = (bo: Bo) => (bo?.extensionElements?.values ?? []).find((v: Bo) => v.$type === 'flow:Properties');

export function readProps(bo: Bo): NodeProps {
  const p = extOf(bo);
  if (!p) return {};
  const j = (k: string) => {
    try {
      return p[k] ? JSON.parse(p[k]) : undefined;
    } catch {
      return undefined;
    }
  };
  const out: NodeProps = {};
  const tf = j('templateFields');
  if (tf?.length) out.templateFields = tf;
  const ao = j('assetOperation');
  if (ao) out.assetOperation = ao;
  const aos = j('assetOperations');
  if (aos?.length) out.assetOperations = aos;
  const timer = j('timer');
  if (timer) out.timer = timer;
  const until = j('until');
  if (until) out.until = until;
  if (p.receiveGuard) out.receiveGuard = p.receiveGuard;
  return out;
}

/** Replace an element's step properties (one undoable command). */
export function writeProps(modeler: any, element: any, props: NodeProps) {
  const moddle = modeler.get('moddle');
  const modeling = modeler.get('modeling');
  const bo = element.businessObject;
  const attrs: Record<string, string> = {};
  if (props.templateFields?.length) attrs.templateFields = JSON.stringify(props.templateFields);
  if (props.assetOperation) attrs.assetOperation = JSON.stringify(props.assetOperation);
  if (props.assetOperations?.length) attrs.assetOperations = JSON.stringify(props.assetOperations);
  if (props.timer && (props.timer.date || props.timer.dateField)) attrs.timer = JSON.stringify(props.timer);
  if (props.until?.dateField) attrs.until = JSON.stringify(props.until);
  if (props.receiveGuard) attrs.receiveGuard = props.receiveGuard;
  const others = (bo.extensionElements?.values ?? []).filter((v: Bo) => v.$type !== 'flow:Properties');
  const values = Object.keys(attrs).length ? [...others, moddle.create('flow:Properties', attrs)] : others;
  const ext = values.length ? moddle.create('bpmn:ExtensionElements', { values }) : undefined;
  modeling.updateProperties(element, { extensionElements: ext });
}

/** A sequence flow's condition (exclusive gateways). */
export function writeCondition(modeler: any, flow: any, condition: string) {
  const moddle = modeler.get('moddle');
  modeler.get('modeling').updateProperties(flow, {
    conditionExpression: condition.trim()
      ? moddle.create('bpmn:FormalExpression', { body: condition.trim() })
      : undefined,
  });
}

export function setDefaultFlow(modeler: any, gateway: any, flow: any | null) {
  modeler.get('modeling').updateProperties(gateway, { default: flow ? flow.businessObject : undefined });
}

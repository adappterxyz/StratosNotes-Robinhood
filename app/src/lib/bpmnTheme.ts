/** Tag shapes by BPMN type so the dark canvas CSS can colour starts, ends, gateways and pools. */
const TAGS: Array<[RegExp, string]> = [
  [/^bpmn:StartEvent$/, 't-start'],
  [/^bpmn:EndEvent$/, 't-end'],
  [/Gateway$/, 't-gw'],
  [/^bpmn:(Participant|Lane)$/, 't-pool'],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tagTypes(viewer: any) {
  try {
    const canvas = viewer.get('canvas');
    for (const e of viewer.get('elementRegistry').getAll()) {
      const type: string = e.businessObject?.$type ?? '';
      for (const [re, cls] of TAGS) if (re.test(type)) canvas.addMarker(e.id, cls);
    }
  } catch {
    /* viewer destroyed */
  }
}

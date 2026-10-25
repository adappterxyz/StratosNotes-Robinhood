import { useEffect, useRef } from 'react';
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import { fitReadable } from '../lib/fit';
import { tagTypes } from '../lib/bpmnTheme';

/** The note's workflow, with the steps holding a live token highlighted. */
export default function BpmnView({ xml, active }: { xml: string; active: string[] }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<NavigatedViewer | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const v = new NavigatedViewer({ container: host.current });
    viewer.current = v;
    let alive = true;
    v.importXML(xml)
      .then(() => {
        if (alive) {
          tagTypes(v);
          fitReadable(v.get('canvas'));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      viewer.current = null;
      v.destroy();
    };
  }, [xml]);
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    const t = setTimeout(() => {
      try {
        const canvas = v.get('canvas') as {
          addMarker: (id: string, c: string) => void;
          removeMarker: (id: string, c: string) => void;
        };
        const reg = v.get('elementRegistry') as { getAll: () => Array<{ id: string }> };
        for (const e of reg.getAll()) canvas.removeMarker(e.id, 'active-step');
        for (const id of active) canvas.addMarker(id, 'active-step');
      } catch {
        /* diagram not imported yet */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [active, xml]);
  return <div className="bpmn" ref={host} aria-label="Workflow diagram" />;
}

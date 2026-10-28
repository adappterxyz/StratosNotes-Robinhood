/**
 * Review & issue for a custom workflow: a saved one from the library (?custom=<definition>, also a recent note issued
 * from it) or the AI's draft (?custom=ai). The workflow is the note, so the review leads with its diagram: what each
 * step does and who acts. Then the checks, and the same issue panel the advanced editor uses. The advanced editor
 * opens from here with this workflow loaded.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Workflow } from 'lucide-react';
import {
  check,
  compileTemplate,
  normalizeParams,
  parseBpmn,
  summarize,
  templateBpmn,
  templateOffered,
  type AssetDefinition,
  type ProductParams,
  type TemplateSummary,
} from '@sn/core';
import { api } from '../../lib/api';
import { loadAiDraft, NOTE_ASSETS } from '../../lib/readymade';
import { IssuePanel, type Built, type DocInfo } from '../Stages';
import { FlowPreview } from '../StepPanel';

interface Loaded {
  name: string;
  description: string;
  xml: string;
  assets: AssetDefinition[];
  basis: ProductParams | null;
  template?: TemplateSummary;
}

export function CustomReview({ source }: { source: string }) {
  const ai = source === 'ai';
  // The AI's draft is in this tab's session; a saved workflow comes from the library (below).
  const [doc, setDoc] = useState<Loaded | null>(() => {
    const xml = ai ? loadAiDraft() : null;
    return xml ? { name: 'AI workflow', description: '', xml, assets: NOTE_ASSETS, basis: null } : null;
  });
  const [error, setError] = useState(() =>
    ai
      ? doc
        ? ''
        : "The AI's workflow is no longer here: describe the note again."
      : /^0x[0-9a-f]{64}$/i.test(source)
        ? ''
        : 'That workflow could not be found.',
  );
  useEffect(() => {
    if (ai || !/^0x[0-9a-f]{64}$/i.test(source)) return;
    let live = true;
    api
      .template(source)
      .then((e) => {
        if (!live) return;
        if (!templateOffered(e)) {
          setError(
            'This saved workflow was built for another chain or names tokens notes no longer use. Start from another note.',
          );
          return;
        }
        const { bpmnXml, assets } = templateBpmn(e);
        const p = e.product ?? e.basis;
        setDoc({
          name: e.name,
          description: e.description,
          xml: bpmnXml,
          assets,
          basis: p ? normalizeParams(p) : null,
          template: summarize(e),
        });
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [ai, source]);

  // Checked and compiled exactly as it would be published.
  const checked = useMemo(() => {
    if (!doc) return null;
    try {
      const ir = parseBpmn(doc.xml, doc.assets);
      const r = check(ir);
      if (r.errors.length) return { ...r, built: null };
      const src = { bpmnXml: doc.xml, assets: doc.assets, ...(doc.basis ? { basis: doc.basis } : {}) };
      const built: Built = { ir, c: compileTemplate(src), source: src };
      return { ...r, built };
    } catch (e) {
      return {
        errors: [{ code: 'COMPILE', message: e instanceof Error ? e.message : String(e) }],
        warnings: [],
        built: null,
      };
    }
  }, [doc]);
  const info: DocInfo | null = doc
    ? { name: doc.name, origin: 'custom', basis: doc.basis, edited: false, template: doc.template }
    : null;
  const advanced = ai ? '/issue/advanced?draft=ai' : `/issue/advanced?template=${source}`;

  return (
    <main className="page iw" data-custom-review={ai ? 'ai' : 'template'}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/issue">Issue</Link>
      </nav>
      {error && (
        <div className="notice warn" role="alert">
          {error} <Link to="/issue">Back to Issue</Link>
        </div>
      )}
      {!error && !doc && <p className="muted">Loading the workflow…</p>}
      {doc && checked && info && (
        <>
          <div className="page-head">
            <div>
              <h1>{doc.name}</h1>
              <p>
                {doc.description ? `${doc.description} ` : ''}A custom workflow: its steps are the note. Read the
                diagram, then issue it.
              </p>
            </div>
          </div>
          {ai && (
            <div className="notice info iw-from">
              Drafted by the AI from your description, and checked by the same rules as every note. Pick each step to
              see what it does before you issue it.
            </div>
          )}
          <section className="card" aria-labelledby="cr-flow">
            <h2 id="cr-flow" className="m-0">
              How this note runs
            </h2>
            <FlowPreview xml={doc.xml} params={doc.basis} label="How this note runs" />
          </section>
          {checked.errors.length > 0 && (
            <div className="notice err" role="alert" data-check-errors>
              This workflow can't be issued as it is:
              <ul>
                {checked.errors.map((e) => (
                  <li key={e.code + e.message}>{e.message}</li>
                ))}
              </ul>
              Fix it in the advanced editor.
            </div>
          )}
          {checked.warnings.length > 0 && (
            <details className="adv">
              <summary>Checks: {checked.warnings.length} to look at</summary>
              <ul className="adv-body small">
                {checked.warnings.map((w) => (
                  <li key={w.code + w.message}>{w.message}</li>
                ))}
              </ul>
            </details>
          )}
          {checked.built && (
            <section className="card iw-step">
              <IssuePanel doc={info} built={checked.built} />
            </section>
          )}
          <div className="iw-nav">
            <Link to="/issue" className="btn">
              <ArrowLeft className="i" />
              Back to Issue
            </Link>
            <Link to={advanced} className="btn" data-open-advanced>
              <Workflow className="i" />
              Open in advanced editor
            </Link>
          </div>
        </>
      )}
    </main>
  );
}

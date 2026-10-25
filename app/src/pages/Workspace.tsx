/**
 * The workflow studio (/issue/advanced): Flow's workspace, for structured notes.
 * Canvas only: notes are picked on /issue and opened here by deep link (or a
 * blank workflow, an imported file, the AI); with a workflow open it is the AI
 * assistant, the BPMN canvas and the stages in
 * order: Overview | Properties -> Validate -> Payoff -> Ready-made note -> Issue.
 * Ready-made notes and edited workflows are issued from the same place. Picking a note happens on /issue.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Modeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import {
  BookOpen,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  Download,
  FilePlus2,
  FileUp,
  LayoutList,
  LineChart,
  Rocket,
  Sparkles,
  TrendingUp,
  Workflow,
  X,
} from 'lucide-react';
import {
  buildWorkflow,
  chain,
  check,
  compileTemplate,
  EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF,
  field,
  instantiateProduct,
  irToDraft,
  normalizeParams,
  parseBpmn,
  PRODUCT_LABELS,
  summarize,
  templateBpmn,
  templateOffered,
  toIssuanceTerms,
  underlyingLabel,
  type AssetDefinition,
  type Issue,
  type ProductParams,
  type ProductType,
  type TemplateEntry,
  type TemplateSummary,
} from '@sn/core';
import AiPanel, { type AiResult } from '../components/AiPanel';
import ProductDialog from '../components/ProductDialog';
import PropertiesPanel from '../components/PropertiesPanel';
import {
  IssuePanel,
  OverviewPanel,
  PayoffPanel,
  TemplatePanel,
  ValidatePanel,
  type Built,
  type DocInfo,
  type Stage,
} from '../components/Stages';
import { flowModdle } from '../lib/bpmnProps';
import { fitReadable } from '../lib/fit';
import { tagTypes } from '../lib/bpmnTheme';
import { short } from '../lib/format';
import { AI_DRAFT_KEY } from '../lib/readymade';

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOTE_ASSETS: AssetDefinition[] = [
  { id: 'note', name: 'Note', kind: 'issued' },
  { id: 'cash', name: 'USDG', kind: 'cash', decimals: 6, token: 'USDG' },
];

/** A blank note: an Issuer pool with a pre-trade step, to build on. */
function blankWorkflow() {
  return buildWorkflow({
    key: 'BL',
    name: 'Untitled note',
    pools: [
      {
        id: 'Part_Issuer',
        name: 'Issuer',
        proc: 'Proc_Issuer',
        nodes: [
          { id: 'Start_Issuer', type: 'startEvent', name: 'Offer Drafted', col: 0 },
          {
            id: 'Task_ApproveTerms',
            type: 'userTask',
            name: 'Approve Terms',
            col: 1,
            props: { templateFields: [field('isin', 'Text'), field('notional', 'Decimal')] },
          },
          { id: 'End_Issuer', type: 'endEvent', name: 'Done', col: 2 },
        ],
        flows: chain('I_F', 'Start_Issuer', 'Task_ApproveTerms', 'End_Issuer'),
      },
    ],
    messages: [],
    assets: NOTE_ASSETS,
  });
}

interface Doc extends DocInfo {
  assets: AssetDefinition[];
  pristine: string;
}

export default function Workspace() {
  const [search, setSearch] = useSearchParams();
  const host = useRef<HTMLDivElement>(null);
  const modeler = useRef<any>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [stage, setStage] = useState<Stage>('design');
  const [aiOpen, setAiOpen] = useState(false);
  const [productDialog, setProductDialog] = useState<{ initial: ProductParams | null; hint?: DocInfo['hint'] } | null>(
    null,
  );
  const [selected, setSelected] = useState<any>(null);
  const [version, setVersion] = useState(0);
  const [issues, setIssues] = useState<{ errors: Issue[]; warnings: Issue[] }>({ errors: [], warnings: [] });
  const [info, setInfo] = useState({ fields: [] as string[], dates: [] as string[], pools: [] as string[], steps: 0 });
  const [built, setBuilt] = useState<Built | null>(null);
  const [notice, setNotice] = useState('');

  // ---- canvas ---------------------------------------------------------------
  useEffect(() => {
    if (!host.current) return;
    const m = new Modeler({ container: host.current, moddleExtensions: { flow: flowModdle } });
    modeler.current = m;
    m.on('selection.changed', (e: any) => setSelected(e.newSelection?.[0] ?? null));
    m.on('commandStack.changed', () => {
      tagTypes(m);
      setVersion((v) => v + 1);
    });
    return () => {
      if (modeler.current === m) modeler.current = null;
      m.destroy();
    };
  }, []);

  const xmlNow = async () => (await modeler.current.saveXML({ format: true })).xml as string;
  const fingerprint = (xml: string, assets: AssetDefinition[]) =>
    Array.from(compileTemplate({ bpmnXml: xml, assets }).hash)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  const load = async (
    xml: string,
    next: Omit<Doc, 'pristine' | 'edited'>,
    opts: { highlight?: string[]; keepPristine?: string } = {},
  ) => {
    const m = modeler.current;
    if (!m) return;
    await m.importXML(xml);
    if (m !== modeler.current) return;
    tagTypes(m);
    fitReadable(m.get('canvas'));
    for (const id of opts.highlight ?? []) {
      try {
        m.get('canvas').addMarker(id, 'active-step');
      } catch {
        /* removed */
      }
    }
    let pristine = opts.keepPristine ?? '';
    if (!opts.keepPristine) {
      try {
        pristine = fingerprint(await xmlNow(), next.assets);
      } catch {
        /* invalid: never pristine */
      }
    }
    setDoc({ ...next, pristine, edited: false });
    setSelected(null);
    setVersion((v) => v + 1);
  };

  const openProduct = async (given: ProductParams, extra: Partial<Doc> = {}) => {
    // Notes run on Robinhood Chain only: an old term sheet (another chain, collateral held elsewhere, an underlying with
    // no token to deliver) opens moved there.
    const p = toIssuanceTerms(given);
    if (p !== given)
      setNotice(
        'These terms named another chain, collateral held elsewhere, or a token Robinhood Chain does not have. Notes run on Robinhood Chain only, so they were moved there: such an underlying settles in cash, and the collateral is pledged into the note on Robinhood Chain.',
      );
    const prod = instantiateProduct(p);
    await load(prod.bpmnXml, { name: p.name, origin: 'product', basis: p, assets: prod.assets, ...extra });
    setStage('design');
  };
  const openTemplate = async (t: TemplateSummary) => {
    setNotice('');
    try {
      const r = await fetch(`/api/templates/${t.definition}`);
      if (!r.ok) throw new Error(`Template ${short(t.definition)} could not be read (${r.status}).`);
      const e = (await r.json()) as TemplateEntry;
      // A saved note the library no longer offers (another chain, remote collateral, an undeliverable token): its terms
      // open moved to Robinhood Chain; a custom workflow built for another chain can't be issued at all.
      if (!templateOffered(e)) {
        if (e.product && !e.bpmnXml) {
          await openProduct(normalizeParams(e.product), { name: e.name });
          return;
        }
        throw new Error(
          'This saved workflow was built for another chain or names tokens notes no longer use. Notes run on Robinhood Chain only: start from a ready-made note instead.',
        );
      }
      const { bpmnXml, assets } = templateBpmn(e);
      const basis = e.product ? normalizeParams(e.product) : e.basis ? normalizeParams(e.basis) : null;
      await load(bpmnXml, {
        name: e.name,
        origin: e.product && !e.bpmnXml ? 'product' : 'custom',
        basis,
        assets,
        template: summarize(e),
      });
      setStage('issue');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const openBlank = async () => {
    const b = blankWorkflow();
    await load(b.bpmnXml, { name: 'Untitled note', origin: 'custom', basis: null, assets: b.assets });
    setStage('design');
  };
  const close = () => {
    setDoc(null);
    setBuilt(null);
    setSelected(null);
    setSearch({}, { replace: true });
  };

  // Deep links: ?template=<definition>, ?product=<type>, ?params=<term sheet JSON>, ?draft=ai (from /issue), ?ai=1.
  const linked = useRef(false);
  useEffect(() => {
    if (linked.current || !modeler.current) return;
    // Deferred one tick, and only on the modeler still mounted: React's StrictMode (dev) mounts the canvas twice.
    const m = modeler.current;
    const t = setTimeout(() => {
      if (linked.current || modeler.current !== m) return;
      linked.current = true;
      if (search.get('ai')) setAiOpen(true);
      const tpl = search.get('template');
      const p = search.get('product') as ProductType | 'worst-of' | null;
      const terms = search.get('params');
      let aiXml: string | null = null;
      if (search.get('draft') === 'ai') {
        try {
          aiXml = sessionStorage.getItem(AI_DRAFT_KEY);
        } catch {
          /* storage blocked */
        }
      }
      if (aiXml)
        load(aiXml, { name: 'AI workflow', origin: 'custom', basis: null, assets: NOTE_ASSETS }).then(
          () => setStage('design'),
          (e) => setNotice(`The AI's workflow could not be opened: ${e instanceof Error ? e.message : String(e)}`),
        );
      else if (terms) {
        try {
          openProduct(normalizeParams(JSON.parse(terms) as ProductParams));
        } catch (e) {
          setNotice(`Those terms could not be opened: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (tpl)
        openTemplate({
          definition: tpl,
          name: '',
          description: '',
          author: '',
          createdAt: 0,
          kind: 'custom',
          label: '',
        }).then(() => {});
      else if (p === 'worst-of') openProduct(EXAMPLE_WORST_OF);
      else if (p && EXAMPLE_PRODUCTS[p]) openProduct(EXAMPLE_PRODUCTS[p]);
    }, 0);
    return () => clearTimeout(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- checks: on every change, validate and compile as it would be published ----
  const recheck = useCallback(async () => {
    if (!modeler.current || !doc) return;
    const xml = await xmlNow();
    try {
      const ir = parseBpmn(xml, doc.assets);
      const r = check(ir);
      setIssues(r);
      const tf = ir.nodes.flatMap((n) => n.props.templateFields ?? []);
      setInfo({
        fields: [...new Set(tf.map((f) => f.name))],
        dates: [...new Set(tf.filter((f) => f.type === 'Date').map((f) => f.name))],
        pools: ir.pools.map((p) => p.name),
        steps: ir.nodes.length,
      });
      let edited = true;
      try {
        edited = fingerprint(xml, doc.assets) !== doc.pristine;
      } catch {
        /* does not compile */
      }
      if (edited !== doc.edited) setDoc((d) => (d ? { ...d, edited } : d));
      const source =
        doc.origin === 'product' && !edited && doc.basis
          ? { product: doc.basis }
          : { bpmnXml: xml, assets: doc.assets, ...(doc.basis ? { basis: doc.basis } : {}) };
      if (r.errors.length) {
        setBuilt(null);
        return;
      }
      try {
        setBuilt({ ir, c: compileTemplate(source), source });
      } catch (e) {
        setBuilt(null);
        setIssues({
          errors: [...r.errors, { code: 'COMPILE', message: e instanceof Error ? e.message : String(e) }],
          warnings: r.warnings,
        });
      }
    } catch (e) {
      setIssues({ errors: [{ code: 'PARSE', message: e instanceof Error ? e.message : String(e) }], warnings: [] });
      setBuilt(null);
    }
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(recheck, 300);
    return () => clearTimeout(t);
  }, [version, recheck]);

  const build = async (): Promise<Built> => {
    if (!built) throw new Error('Fix the errors in Validate first.');
    return built;
  };

  // ---- AI ---------------------------------------------------------------------
  const draft = async () => {
    if (!doc) return undefined;
    try {
      return irToDraft(parseBpmn(await xmlNow(), doc.assets));
    } catch {
      return undefined;
    }
  };
  const onAi = async (r: AiResult): Promise<string> => {
    if (r.kind === 'product') {
      setProductDialog({
        initial: r.params,
        hint: r.schedule ? { size: r.schedule.size, every: r.schedule.every, unit: r.schedule.unit } : undefined,
      });
      return `Read it as a ${PRODUCT_LABELS[r.params.productType].toLowerCase()} on ${underlyingLabel(r.params)}. Review the terms in the dialog, then open the workflow.`;
    }
    if (r.kind === 'workflow') {
      const base: Doc = doc ?? {
        name: 'AI workflow',
        origin: 'custom',
        basis: null,
        assets: NOTE_ASSETS,
        pristine: '',
        edited: true,
      };
      await load(
        r.bpmnXml,
        {
          name: base.name,
          origin: base.origin,
          basis: base.basis,
          assets: base.assets,
          template: base.template,
          hint: base.hint,
        },
        { highlight: r.changed, keepPristine: base.pristine || 'none' },
      );
      setStage('design');
      return `Changed ${r.changed.length} step${r.changed.length === 1 ? '' : 's'} (highlighted on the canvas). It passes the validator.`;
    }
    return r.reply ?? r.error ?? 'No answer.';
  };

  // ---- import / export ---------------------------------------------------------
  const importFile = async (f: File) => {
    const xml = await f.text();
    try {
      parseBpmn(xml, NOTE_ASSETS);
    } catch (e) {
      setNotice(`Could not read ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await load(xml, { name: f.name.replace(/\.(bpmn|xml)$/i, ''), origin: 'custom', basis: null, assets: NOTE_ASSETS });
    setStage('validate');
  };
  const exportFile = async () => {
    const url = URL.createObjectURL(new Blob([await xmlNow()], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(doc?.name || 'note').replace(/[^\w.-]+/g, '_')}.bpmn`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const selectNode = (id: string) => {
    const el = modeler.current?.get('elementRegistry').get(id);
    if (el) {
      modeler.current.get('selection').select(el);
      setStage('design');
    }
  };

  const stages: Array<{ id: Stage; label: string; icon: ReactNode }> = [
    {
      id: 'design',
      label: selected ? 'Properties' : 'Overview',
      icon: selected ? <Workflow className="i" /> : <LayoutList className="i" />,
    },
    {
      id: 'validate',
      label: issues.errors.length ? `Check (${issues.errors.length})` : 'Check',
      icon: issues.errors.length ? <AlertCircle className="i text-destructive" /> : <CheckCircle2 className="i" />,
    },
    { id: 'payoff', label: 'Payoff', icon: <LineChart className="i" /> },
    { id: 'template', label: 'Ready-made note', icon: <BookOpen className="i" /> },
    { id: 'issue', label: 'Issue', icon: <Rocket className="i" /> },
  ];

  return (
    <div className="ws">
      {aiOpen && <AiPanel draft={draft} onResult={onAi} onClose={() => setAiOpen(false)} />}
      <div className="ws-main">
        <div className="ws-bar">
          <nav className="crumbs ws-crumbs" aria-label="Breadcrumb">
            <Link to="/issue">Issue</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Advanced studio</span>
          </nav>
          <input
            ref={fileInput}
            type="file"
            accept=".bpmn,.xml"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = '';
            }}
          />
          {doc && (
            <button className="btn" onClick={close} title="Close this workflow">
              <X className="i" />
              Close
            </button>
          )}
          <button className="btn" onClick={() => fileInput.current?.click()}>
            <FileUp className="i" />
            Import
          </button>
          {doc && (
            <button className="btn" onClick={exportFile}>
              <Download className="i" />
              Export BPMN
            </button>
          )}
          {doc && (
            <span className="row gap-4">
              <ChevronRight className="i dim" />
              <span className="name" title={doc.name}>
                {doc.name}
              </span>
            </span>
          )}
          <button className={`btn ${aiOpen ? 'on' : ''}`} onClick={() => setAiOpen((o) => !o)}>
            <Sparkles className="i" />
            AI
          </button>
          {doc && (
            <nav className="seg ml-auto" aria-label="Stages">
              {stages.map((s, i) => (
                <span key={s.id} className="row gap-2 flex-nowrap">
                  {i > 0 && (
                    <span className="arrow" aria-hidden="true">
                      ›
                    </span>
                  )}
                  <button
                    className={stage === s.id ? 'active' : ''}
                    aria-current={stage === s.id ? 'step' : undefined}
                    onClick={() => setStage(s.id)}
                  >
                    {s.icon}
                    {s.label}
                  </button>
                </span>
              ))}
            </nav>
          )}
        </div>
        <div className="ws-body">
          <div className={`ws-canvas ${doc ? '' : 'empty'}`}>
            <div ref={host} className="bpmn" aria-label="Workflow editor" />
            {doc && (
              <p className="phone-note">
                On a phone the workflow is view-only: drag to pan, pinch or scroll to zoom. Edit it on a larger screen.
              </p>
            )}
            {!doc && (
              <div className="ws-start">
                <div className="ws-start-inner">
                  <div>
                    <h1>Workflow studio</h1>
                    <p className="small muted mt-6 maxw-64ch">
                      Edit a note's workflow on the BPMN canvas: add steps, change who does what, connect services.
                      Check the payoff, then issue it, or save it as a ready-made note for others. Import a .bpmn file,
                      or ask the AI for a change.
                    </p>
                  </div>
                  <div className="start-cards">
                    <Link to="/issue" className="start-card primary">
                      <span className="t">
                        <TrendingUp className="i" />
                        Start from a note type or ready-made note
                      </span>
                      <span className="d">
                        The guided issue flow: pick one, then open it here to change the workflow.
                      </span>
                    </Link>
                    <button className="start-card" onClick={openBlank}>
                      <span className="t">
                        <FilePlus2 className="i" />
                        Blank workflow
                      </span>
                      <span className="d">An Issuer pool with a pre-trade step: draw the rest on the canvas.</span>
                    </button>
                  </div>
                  {notice && (
                    <div className="notice err" role="alert">
                      {notice}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {doc && (
            <aside className="ws-panel" aria-label="Stage">
              {stage === 'design' &&
                (selected ? (
                  <div className="section">
                    <PropertiesPanel
                      modeler={modeler.current}
                      element={selected}
                      fieldNames={info.fields}
                      dateFields={info.dates}
                      pools={info.pools}
                      assets={doc.assets.map((a) => a.id)}
                      version={version}
                    />
                  </div>
                ) : (
                  <OverviewPanel
                    doc={doc}
                    info={{ ...info, errors: issues.errors.length, warnings: issues.warnings.length }}
                    onStage={setStage}
                    onEditTerms={() => setProductDialog({ initial: doc.basis })}
                  />
                ))}
              {stage === 'validate' && <ValidatePanel issues={issues} onSelect={selectNode} />}
              {stage === 'payoff' && <PayoffPanel key={doc.pristine + String(doc.edited)} doc={doc} />}
              {stage === 'template' && (
                <TemplatePanel
                  key={doc.pristine}
                  doc={doc}
                  build={build}
                  onSaved={(t) => setDoc((d) => (d ? { ...d, template: t } : d))}
                />
              )}
              {stage === 'issue' && <IssuePanel key={doc.pristine} doc={doc} built={built} />}
            </aside>
          )}
        </div>
      </div>
      {productDialog && (
        <ProductDialog
          initial={productDialog.initial}
          onClose={() => setProductDialog(null)}
          onCreate={(p) => {
            const hint = productDialog.hint;
            setProductDialog(null);
            openProduct(p, hint ? { hint } : {});
          }}
        />
      )}
    </div>
  );
}

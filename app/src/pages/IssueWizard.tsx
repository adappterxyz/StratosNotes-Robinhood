/**
 * Issue, guided. Three ways in, all leading to the same steps (Product → Terms → Schedule → Collateral → Review &
 * issue): start from a ready-made note (its terms filled in, opened at the schedule), build your own from a note
 * type, or describe it to the AI. Each step asks only what it needs, with defaults; the rest sits under "More
 * options". The review spells out what the issuer commits to, then the same issue panel the studio uses publishes
 * the note; it can also be saved as a ready-made note. The BPMN canvas is the studio (/issue/advanced).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Workflow } from 'lucide-react';
import {
  check,
  collateralTokenOf,
  compileTemplate,
  economicsOf,
  EXAMPLE_PRODUCTS,
  instantiateProduct,
  parseBpmn,
  PRODUCT_LABELS,
  toIssuanceTerms,
  validateProductParams,
  type CollateralSymbol,
  type ProductParams,
  type ProductType,
} from '@sn/core';
import PayoffChart from '../components/PayoffChart';
import type { Built, DocInfo, IssuePreset } from '../components/Stages';
import { CollateralStep } from '../components/issue/CollateralStep';
import { IssueChooser } from '../components/issue/IssueChooser';
import { ProductStep } from '../components/issue/ProductStep';
import { ReviewStep } from '../components/issue/ReviewStep';
import { issueSchedule, type Every } from '../components/issue/schedule';
import { ScheduleStep } from '../components/issue/ScheduleStep';
import { TermsStep } from '../components/issue/TermsStep';
import { WizardHeader } from '../components/issue/WizardHeader';
import { DEMO_TSLA, PRODUCTS, STEPS, type Kind } from '../components/issue/wizard-data';
import {
  AI_DRAFT_KEY,
  exampleOf,
  kindOf,
  loadAiReading,
  readyMade,
  saveAiReading,
  type AiReading,
  type ReadyMade,
} from '../lib/readymade';
import { issueChains, PREFERRED_CHAIN, useChains } from '../lib/chains';

const start = exampleOf;

export default function IssueWizard() {
  const [search, setSearch] = useSearchParams();
  const nav = useNavigate();
  const { config } = useChains();
  // Where you are lives in the address (?product=…&step=…, and ?ready=… when started from a ready-made note or the
  // AI), so the browser's Back button walks back through the steps and then to the chooser, and a link reopens the
  // same step.
  const linked = search.get('product') as Kind | null;
  const ready = search.get('ready');
  const kind: Kind | null =
    linked && (linked === 'worst-of' || EXAMPLE_PRODUCTS[linked as ProductType]) ? linked : null;
  const step = kind ? Math.min(4, Math.max(0, Number(search.get('step')) || 0)) : 0;
  const key = kind ? (ready ? `r:${ready}` : `k:${kind}`) : null;
  // ?demo=tsla: the recorded demo's terms, every field filled in (a TSLA reverse convertible on Arbitrum, collateral TSLA
  // locked on Robinhood Chain, a minutes-apart schedule): the presenter only clicks Continue and signs.
  const demoTsla = kind === 'reverse-convertible' && search.get('demo') === 'tsla';
  // What can be filled in at once (a note type, a built-in, the AI's reading); a saved note loads in the effect below.
  const [init] = useState(() => {
    const hit = kind && ready && ready !== 'ai' ? readyMade(ready) : null;
    const ai = kind && ready === 'ai' ? loadAiReading() : null;
    if (hit && !(hit instanceof Promise)) return { p: hit.params, from: hit, ai, shown: key };
    if (ai) return { p: ai.params, from: null, ai, shown: key };
    if (demoTsla) return { p: DEMO_TSLA, from: null, ai: null, shown: key };
    return { p: start(kind ?? 'phoenix'), from: null, ai: null, shown: kind && !ready ? key : null };
  });
  // Every note is issued on Arbitrum: terms opened from elsewhere (an old saved note on Robinhood Chain, a physically
  // settled stock note) are moved there as they load (toIssuanceTerms), and the issuer is told.
  const [p, setPRaw] = useState<ProductParams>(() => toIssuanceTerms(init.p));
  const [moved, setMoved] = useState(() => toIssuanceTerms(init.p) !== init.p);
  const setP = (next: ProductParams | ((prev: ProductParams) => ProductParams)) => {
    if (typeof next === 'function') {
      setPRaw((prev) => toIssuanceTerms(next(prev)));
      return;
    }
    const q = toIssuanceTerms(next); // terms loaded from elsewhere
    setMoved(q !== next);
    setPRaw(q);
  };
  const [from, setFrom] = useState<ReadyMade | null>(init.from); // the ready-made note it started from
  const [aiNotes, setAiNotes] = useState<string[]>(init.ai?.notes ?? []);
  const [shown, setShown] = useState<string | null>(init.shown); // the key whose terms are in p
  const [lost, setLost] = useState('');
  // The network: Arbitrum Sepolia, always (left implicit in the terms so its definitions stay as they were). Robinhood
  // Chain is a collateral chain only: stock collateral is locked there (step 4), no note is issued there.
  const issuable = issueChains(config);
  const chainKey = issuable.find((c) => c.key === PREFERRED_CHAIN)?.key ?? issuable[0]?.key ?? '';
  const [size, setSize] = useState(demoTsla ? 20 : (init.ai?.schedule?.size ?? 10_000));
  const [strikeIn, setStrikeIn] = useState(5);
  const [every, setEvery] = useState<Every>(
    init.ai?.schedule ? { n: init.ai.schedule.every, unit: init.ai.schedule.unit } : { n: 3, unit: 'minutes' },
  );
  const applyAi = (r: AiReading) => {
    setP(r.params);
    setFrom(null);
    setAiNotes(r.notes ?? []);
    if (r.schedule) {
      setEvery({ n: r.schedule.every, unit: r.schedule.unit });
      if (r.schedule.size) setSize(r.schedule.size);
    }
  };
  useEffect(() => {
    // Arriving somewhere else (a link, or Back/Forward to the chooser and out again) loads what that address names:
    // a note type's defaults, a ready-made note's terms, or what the AI read.
    if (!key || key === shown) return;
    let live = true;
    setLost('');
    if (!ready) {
      setP(start(kind!));
      setFrom(null);
      setAiNotes([]);
      setShown(key);
      return;
    }
    if (ready === 'ai') {
      const r = loadAiReading();
      if (r) {
        applyAi(r);
        setShown(key);
      } else setLost('What the AI read is no longer here: describe the note again.');
      return;
    }
    const hit = readyMade(ready);
    const use = (r: ReadyMade | null) => {
      if (!live) return;
      if (!r) {
        setLost('That ready-made note could not be found.');
        return;
      }
      if (r.custom) {
        nav(`/issue/advanced?template=${r.id}`, { replace: true });
        return;
      }
      setP(r.params);
      setFrom(r);
      setAiNotes([]);
      setShown(key);
    };
    if (hit instanceof Promise) hit.then(use);
    else use(hit);
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (k: Kind | null, s = 0) =>
    setSearch(k ? { ...(ready ? { ready } : {}), product: k, step: String(s) } : {});
  const setStep = (s: number) => go(kind, s);
  const [timing, setTiming] = useState<{ lag: number; grace: number } | null>(
    demoTsla ? { lag: 60, grace: 120 } : null,
  );
  const set = (patch: Partial<ProductParams>) => setP((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step, kind]);
  // What the issue panel publishes: the product's workflow, compiled as the engine will run it.
  const built = useMemo<Built | null>(() => {
    if (step !== 4 || validateProductParams(p).length) return null;
    try {
      const prod = instantiateProduct(p);
      const ir = parseBpmn(prod.bpmnXml, prod.assets);
      if (check(ir).errors.length) return null;
      return { ir, c: compileTemplate({ product: p }), source: { product: p } };
    } catch {
      return null;
    }
  }, [step, p]); // eslint-disable-line react-hooks/exhaustive-deps

  // A template link belongs to the studio.
  if (search.get('template')) return <Navigate to={`/issue/advanced?${search.toString()}`} replace />;

  const choose = (k: Kind) => {
    setP(start(k));
    setFrom(null);
    setAiNotes([]);
    setShown(`k:${k}`);
    setSearch({ product: k, step: '0' });
  };
  const pick = (r: ReadyMade) => {
    setP(r.params);
    setFrom(r);
    setAiNotes([]);
    setShown(`r:${r.id}`);
    setSearch({ ready: r.id, product: kindOf(r.params), step: '2' });
  };
  const fromAi = (r: AiReading) => {
    saveAiReading(r);
    applyAi(r);
    setShown('r:ai');
    setSearch({ ready: 'ai', product: kindOf(r.params), step: '1' });
  };
  const aiWorkflow = (xml: string) => {
    try {
      sessionStorage.setItem(AI_DRAFT_KEY, xml);
    } catch {
      /* storage blocked */
    }
    nav('/issue/advanced?draft=ai&ai=1');
  };
  // The studio opens these exact terms (?params=), or the saved note itself when they are unchanged.
  const customise = () =>
    nav(
      from && !from.custom && JSON.stringify(from.params) === JSON.stringify(p) && from.author
        ? `/issue/advanced?template=${from.id}`
        : `/issue/advanced?params=${encodeURIComponent(JSON.stringify(p))}`,
    );
  const eco = economicsOf(p);
  const errors = validateProductParams(p);
  const remote = p.collateralChain === 'robinhood';
  const chainCfg = config.chains.find((c) => c.key === chainKey);
  const colToken = (c: CollateralSymbol) => collateralTokenOf(p, c)?.token ?? null;
  const sym = config.chains.find((c) => c.key === chainKey)?.stablecoin.symbol ?? 'USDG';
  const { demo, t, timingBad, strikeAt, dateOf, fmtT, dur } = issueSchedule(every, strikeIn, timing, eco);

  const doc: DocInfo = {
    name: p.name,
    origin: 'product',
    basis: p,
    edited: false,
    template: from?.summary && JSON.stringify(from.params) === JSON.stringify(p) ? from.summary : undefined,
  };
  const preset: IssuePreset = {
    chainKey,
    size,
    strikeIn,
    every,
    ratioPct: eco.collateralRatioPct,
    haircuts: Object.fromEntries(eco.collateral.map((c) => [c.symbol, c.haircutPct])),
    timing: t,
  };

  // ---- the chooser: three ways in --------------------------------------------------------------------------------
  if (!kind) {
    return <IssueChooser pick={pick} choose={choose} fromAi={fromAi} aiWorkflow={aiWorkflow} />;
  }

  if (key !== shown) {
    return (
      <main className="page iw">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/issue">Issue</Link>
        </nav>
        {lost ? (
          <div className="notice warn" role="alert">
            {lost} <Link to="/issue">Back to Issue</Link>
          </div>
        ) : (
          <p className="muted">Loading the ready-made note…</p>
        )}
      </main>
    );
  }

  const canNext =
    step === 1 || step === 3
      ? errors.length === 0 && (step !== 3 || !timingBad)
      : step === 2
        ? size > 0 && strikeIn >= 2 && every.n > 0
        : true;

  return (
    <main className="page iw">
      <WizardHeader
        title={from ? from.name : (PRODUCTS.find((x) => x.kind === kind)?.title ?? PRODUCT_LABELS[p.productType])}
        step={step}
        setStep={setStep}
      />

      {from && step < 4 && (
        <div className="notice info iw-from">
          Started from the ready-made note <strong>{from.name}</strong>
          {from.author ? '' : ' by notes.markets'}: its terms are filled in. Change anything on the earlier steps.
        </div>
      )}
      {ready === 'ai' && step < 4 && (
        <div className="notice info iw-from">
          Filled in by the AI from your description. Check every term{aiNotes.length ? ':' : '.'}
          {aiNotes.length > 0 && (
            <ul>
              {aiNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className={`iw-body ${step === 1 || step === 4 ? 'with-side' : ''}`}>
        <section className="card iw-step">
          {step === 0 && <ProductStep kind={kind} p={p} set={set} chainCfg={chainCfg} moved={moved} />}

          {step === 1 && <TermsStep p={p} set={set} errors={errors} />}

          {step === 2 && (
            <ScheduleStep
              sym={sym}
              size={size}
              setSize={setSize}
              strikeIn={strikeIn}
              setStrikeIn={setStrikeIn}
              every={every}
              setEvery={setEvery}
              setTiming={setTiming}
              chainCfg={chainCfg}
              chainKey={chainKey}
              observations={p.observations}
              strikeAt={strikeAt}
              dateOf={dateOf}
              fmtT={fmtT}
              demo={demo}
            />
          )}

          {step === 3 && (
            <CollateralStep
              p={p}
              set={set}
              eco={eco}
              remote={remote}
              colToken={colToken}
              chainCfg={chainCfg}
              size={size}
              sym={sym}
              demo={demo}
              t={t}
              setTiming={setTiming}
              timingBad={timingBad}
              errors={errors}
            />
          )}

          {step === 4 && (
            <ReviewStep
              p={p}
              eco={eco}
              size={size}
              sym={sym}
              every={every}
              strikeAt={strikeAt}
              fmtT={fmtT}
              dur={dur}
              t={t}
              remote={remote}
              colToken={colToken}
              built={built}
              doc={doc}
              preset={preset}
            />
          )}

          <div className="iw-nav">
            {step > 0 ? (
              <button className="btn" onClick={() => setStep(step - 1)}>
                <ArrowLeft className="i" />
                Back
              </button>
            ) : (
              <button className="btn" onClick={() => go(null)}>
                <ArrowLeft className="i" />
                Back to Issue
              </button>
            )}
            {step < 4 && (
              <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Continue: {STEPS[step + 1]}
                <ArrowRight className="i" />
              </button>
            )}
            {step === 4 && (
              <button className="btn" onClick={customise}>
                <Workflow className="i" />
                Customise the workflow
              </button>
            )}
          </div>
        </section>

        {(step === 1 || step === 4) && (
          <aside className="card iw-side" aria-label="Payoff">
            <span className="label">Payout per 100 at maturity</span>
            {errors.length ? <p className="xs muted">Fix the terms to see the payoff.</p> : <PayoffChart params={p} />}
          </aside>
        )}
      </div>
    </main>
  );
}

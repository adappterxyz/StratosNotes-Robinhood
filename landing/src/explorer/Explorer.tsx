import { useEffect, useMemo, useRef, useState } from 'react';
import PathChart, { LINE_COLORS } from './PathChart';
import './explorer.css';
import { DEFAULT_START, type ExplorerStart } from './start';
import {
  BLURB,
  calls,
  COLLATERAL,
  CRYPTO,
  defaultTerms,
  explain,
  GOALS,
  MONTHS,
  N,
  outcome,
  PRESETS,
  presetPaths,
  PRODUCT_LABELS,
  PRODUCTS,
  productUses,
  SHORT,
  STOCKS,
  deliveredToken,
  physicalPossible,
  type Preset,
  type Role,
  type Sym,
  type Terms,
} from './model';

/** Amounts in USDG, the dollar notes settle in. */
const money = (v: number) => `${Math.round(v).toLocaleString('en-US')} USDG`;
const pc = (v: number, d = 2) => `${(v * 100).toFixed(d).replace(/\.?0+$/, '')}%`;
const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Slider({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  unit = '%',
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <label className="xs-field" htmlFor={id}>
      <span className="xs-flabel">
        {label}
        <b className="num">{unit === '$' ? money(value) : `${value}${unit}`}</b>
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <span className="xs-hint">{hint}</span>}
    </label>
  );
}

export default function Explorer({ start = DEFAULT_START }: { start?: ExplorerStart }) {
  const [role, setRole] = useState<Role>(start.role);
  const [goalId, setGoalId] = useState(start.goal);
  const [terms, setTerms] = useState<Terms>(() => ({
    ...defaultTerms(start.type, start.syms),
    ...(start.physical && physicalPossible(start.syms) ? { physical: true } : {}),
  }));
  const [preset, setPreset] = useState<Preset | null>(start.preset);
  const [paths, setPaths] = useState<number[][]>(() => presetPaths(start.preset, start.syms.length));
  const [invest, setInvest] = useState(10_000);
  const [notional, setNotional] = useState(1_000_000);
  const [collId, setCollId] = useState('ETH');
  const [haircut, setHaircut] = useState(70);
  const [ratio, setRatio] = useState(50);
  const [grace, setGrace] = useState(3);
  const [miss, setMiss] = useState(false);
  const [missAt, setMissAt] = useState(0);

  const goals = GOALS[role];
  const goal = goals.find((g) => g.id === goalId) ?? goals[0];
  const o = useMemo(() => outcome(terms, paths), [terms, paths]);
  const uses = productUses(terms.type);
  const basket = terms.syms.length > 1;

  // Tween the path when a preset (not a drag) changes it.
  const tween = useRef(0);
  const animateTo = (target: number[][]) => {
    cancelAnimationFrame(tween.current);
    if (reduceMotion() || target.length !== paths.length) {
      setPaths(target);
      return;
    }
    const from = paths.map((r) => [...r]);
    const t0 = performance.now();
    const step = (t: number) => {
      const a = Math.min(1, (t - t0) / 380),
        e = 1 - Math.pow(1 - a, 3);
      setPaths(from.map((r, i) => r.map((v, k) => Math.round(v + (target[i][k] - v) * e))));
      if (a < 1) tween.current = requestAnimationFrame(step);
    };
    tween.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(tween.current), []);

  const pickRole = (r: Role) => {
    setRole(r);
    setGoalId(GOALS[r][0].id);
    setMiss(false);
  };
  const pickProduct = (t: Terms['type']) => {
    const syms = t === 'ppn' && basket ? [terms.syms[0]] : terms.syms;
    setTerms({ ...defaultTerms(t, syms), physical: t !== 'ppn' && terms.physical && physicalPossible(syms) });
    setMiss(false);
  };
  const setSyms = (syms: Sym[]) => {
    setTerms((t) => ({
      ...defaultTerms(t.type, syms),
      coupon: t.coupon,
      couponBarrier: t.couponBarrier,
      autocall: t.autocall,
      knockIn: t.knockIn,
      protection: t.protection,
      participation: t.participation,
      memory: t.memory,
      physical: t.physical && physicalPossible(syms),
    }));
    setPaths(presetPaths(preset ?? 'Flat', syms.length));
  };
  const toggleBasket = (on: boolean) => {
    if (on)
      setSyms([
        terms.syms[0],
        terms.syms[0] === 'ETH'
          ? 'BTC'
          : terms.syms[0] === 'TSLA'
            ? 'NVDA'
            : CRYPTO.includes(terms.syms[0])
              ? 'ETH'
              : 'TSLA',
      ]);
    else setSyms([terms.syms[0]]);
  };
  const toggleSym = (s: Sym) => {
    if (!basket) return setSyms([s]);
    if (terms.syms.includes(s)) {
      if (terms.syms.length > 2) setSyms(terms.syms.filter((x) => x !== s));
      return;
    }
    if (terms.syms.length < 3) setSyms([...terms.syms, s]);
  };
  const applyPreset = (p: Preset) => {
    setPreset(p);
    animateTo(presetPaths(p, terms.syms.length));
  };
  const moveHandle = (p: number, k: number, v: number) => {
    setPreset(null);
    setPaths((prev) => prev.map((r, i) => (i === p ? r.map((x, j) => (j === k ? v : x)) : r)));
  };
  const set = <K extends keyof Terms>(k: K, v: Terms[K]) => {
    setTerms((t) => ({ ...t, [k]: v }));
  };

  // Issuer side.
  const sched = calls(terms, o);
  const raised = notional;
  const paid = o.total * notional;
  const months = o.ran * 3;
  const costRate = (paid / raised - 1) / (months / 12);
  const coll = COLLATERAL.find((c) => c.id === collId)!;
  const required = (ratio / 100) * notional;
  const pledge = required / (haircut / 100);
  const missIdx = Math.min(missAt, sched.length - 1);
  const missed = sched[missIdx];
  const paidBefore = sched.slice(0, missIdx).reduce((a, c) => a + c.amount, 0);
  // The engine's default rule (cap-at-owed): holders are owed the missed payment plus par (a missed redemption
  // already includes par); they take that from the collateral and the issuer gets any excess back.
  const owedPerUnit = missed ? missed.amount + (/redemption/.test(missed.label) ? 0 : 1) : 0;
  const recoveryPerUnit = Math.min(pledge / notional, owedPerUnit);
  const excessBack = Math.max(0, pledge - recoveryPerUnit * notional);

  const physicalToken = basket ? `the worst performer's token` : deliveredToken(terms.syms[0]);
  const ret = o.total - 1;

  return (
    <div className="xs" data-role={role}>
      {/* 1. Who you are and what you want */}
      <div className="xs-top">
        <div className="xs-role" role="tablist" aria-label="View as">
          {(['investor', 'issuer'] as Role[]).map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={role === r}
              className={role === r ? 'on' : ''}
              onClick={() => pickRole(r)}
            >
              {r === 'investor' ? 'I want to invest' : 'I want to issue'}
            </button>
          ))}
        </div>
        <div className="xs-goals" role="radiogroup" aria-label="Goal">
          {goals.map((g) => (
            <button
              key={g.id}
              type="button"
              role="radio"
              aria-checked={g.id === goal.id}
              className={`xs-goal${g.id === goal.id ? ' on' : ''}`}
              onClick={() => setGoalId(g.id)}
            >
              <b>{g.label}</b>
              <span>{g.detail}</span>
            </button>
          ))}
        </div>
        <div className="xs-picks">
          <span className="xs-kicker">Notes that fit</span>
          {goal.picks.map((pk) => (
            <button
              key={pk.t}
              type="button"
              className={`xs-pick${terms.type === pk.t ? ' on' : ''}`}
              onClick={() => pickProduct(pk.t)}
            >
              <b>{PRODUCT_LABELS[pk.t]}</b>
              <span>{pk.why}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="xs-main">
        {/* 2. The note */}
        <div className="xs-terms">
          <div className="xs-block">
            <span className="xs-kicker">The note</span>
            <div className="xs-seg" role="radiogroup" aria-label="Product">
              {PRODUCTS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={terms.type === t}
                  className={terms.type === t ? 'on' : ''}
                  onClick={() => pickProduct(t)}
                >
                  {SHORT[t]}
                </button>
              ))}
            </div>
            <p className="xs-blurb">{BLURB[terms.type]}</p>
          </div>

          <div className="xs-block">
            <div className="xs-row">
              <span className="xs-kicker">Underlying</span>
              {terms.type !== 'ppn' && (
                <label className="xs-check">
                  <input type="checkbox" checked={basket} onChange={(e) => toggleBasket(e.target.checked)} /> Worst-of
                  basket
                </label>
              )}
            </div>
            <div className="xs-chips" aria-label="Underlyings">
              {[...CRYPTO, ...STOCKS].map((s) => {
                const on = terms.syms.includes(s);
                const i = terms.syms.indexOf(s);
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={on}
                    className={`xs-chip${on ? ' on' : ''}${STOCKS.includes(s) ? ' stock' : ''}`}
                    onClick={() => toggleSym(s)}
                  >
                    {on && basket && <i style={{ background: LINE_COLORS[i] }} />}
                    {s}
                  </button>
                );
              })}
            </div>
            <span className="xs-hint">
              {basket
                ? 'Pick two or three. Every barrier looks at the worst performer.'
                : 'Crypto prices from Chainlink on Ethereum; stocks from Chainlink on Robinhood Chain.'}
            </span>
          </div>

          <div className="xs-block xs-sliders">
            <span className="xs-kicker">Terms · quarterly over 12 months</span>
            {uses.coupon && (
              <Slider
                id="xs-coupon"
                label={terms.type === 'snowball' ? 'Coupon accrued per quarter' : 'Coupon per quarter'}
                value={terms.coupon}
                min={0.5}
                max={6}
                step={0.25}
                onChange={(v) => set('coupon', v)}
                hint={`${(terms.coupon * 4).toFixed(2).replace(/\.?0+$/, '')}% a year`}
              />
            )}
            {uses.couponBarrier && (
              <Slider
                id="xs-cb"
                label="Coupon barrier"
                value={terms.couponBarrier}
                min={40}
                max={100}
                onChange={(v) => set('couponBarrier', v)}
              />
            )}
            {uses.autocall && (
              <Slider
                id="xs-ac"
                label="Autocall level"
                value={terms.autocall}
                min={80}
                max={130}
                onChange={(v) => set('autocall', v)}
              />
            )}
            {uses.knockIn && (
              <Slider
                id="xs-ki"
                label="Knock-in barrier"
                value={terms.knockIn}
                min={30}
                max={95}
                onChange={(v) => set('knockIn', v)}
              />
            )}
            {uses.protection && (
              <Slider
                id="xs-prot"
                label="Protection"
                value={terms.protection}
                min={80}
                max={100}
                onChange={(v) => set('protection', v)}
              />
            )}
            {uses.protection && (
              <Slider
                id="xs-part"
                label="Participation in the rise"
                value={terms.participation}
                min={0}
                max={150}
                step={5}
                onChange={(v) => set('participation', v)}
              />
            )}
            <div className="xs-toggles">
              {uses.couponBarrier && (
                <label className="xs-check">
                  <input type="checkbox" checked={terms.memory} onChange={(e) => set('memory', e.target.checked)} />{' '}
                  Memory
                </label>
              )}
              {uses.knockIn && (
                <label
                  className="xs-check"
                  title={
                    physicalPossible(terms.syms) ? undefined : 'No real token to deliver for this underlying: cash only'
                  }
                >
                  <input
                    type="checkbox"
                    checked={terms.physical}
                    disabled={!physicalPossible(terms.syms) && !terms.physical}
                    onChange={(e) => set('physical', e.target.checked)}
                  />{' '}
                  Physical delivery below knock-in
                </label>
              )}
            </div>
          </div>
        </div>

        {/* 3. The market */}
        <div className="xs-market">
          <div className="xs-row">
            <span className="xs-kicker">Shape the market · % of strike</span>
            <div className="xs-presets" role="group" aria-label="Market scenario">
              {(Object.keys(PRESETS) as Preset[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={preset === p}
                  className={preset === p ? 'on' : ''}
                  onClick={() => applyPreset(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <PathChart
            terms={terms}
            paths={paths}
            worstIdx={o.worstIdx}
            calledAt={o.r.calledAt}
            coupons={o.r.coupons}
            onMove={moveHandle}
          />
          <div className="xs-legend">
            {basket &&
              terms.syms.map((s, i) => (
                <span key={s}>
                  <i style={{ background: LINE_COLORS[i] }} />
                  {s}
                </span>
              ))}
            <span className="xs-hint">
              Drag a point, or focus it and use the arrow keys (Shift for 10%). Example scenarios, not live prices.
            </span>
          </div>
        </div>
      </div>

      {/* 4. The outcome */}
      {role === 'investor' ? (
        <div className="xs-out" key={`i-${terms.type}`}>
          <div className="xs-head">
            <div>
              <span className="xs-kicker">What you get</span>
              <Slider
                id="xs-invest"
                label="You invest"
                value={invest}
                min={1000}
                max={100_000}
                step={1000}
                unit="$"
                onChange={setInvest}
              />
            </div>
            <div className={`xs-big ${ret >= 0 ? 'up' : 'down'}`}>
              <span className="num">
                {ret >= 0 ? '+' : ''}
                {pc(ret)}
              </span>
              <small>
                total return · {money(invest * o.total)} back for {money(invest)}
              </small>
            </div>
          </div>
          <div className="xs-flow" aria-label="Payments to you">
            {Array.from({ length: N }, (_, k) => {
              const ran = k < o.ran;
              const c = o.r.coupons[k] ?? 0;
              const end = k === o.ran - 1;
              return (
                <div key={k} className={`xs-period${ran ? '' : ' off'}${end ? ' end' : ''}`}>
                  <span className="xs-pm">
                    Obs {k + 1} · M{MONTHS[k]}
                  </span>
                  <span className="xs-lvl num">
                    {Math.round(o.perfs[k] * 100)}%{basket ? ' worst' : ''}
                  </span>
                  {ran ? (
                    <>
                      <span className="xs-amt num">
                        {c > 0
                          ? `+${money(invest * c)}`
                          : terms.type === 'snowball' || terms.type === 'ppn'
                            ? '—'
                            : 'no coupon'}
                      </span>
                      {end && (
                        <span className="xs-red num">
                          {o.r.calledAt ? 'Called · ' : 'Maturity · '}
                          {money(invest * o.r.redemptionCash)}
                          {o.knockedIn && terms.physical && <em> as {physicalToken}</em>}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="xs-amt muted">not reached</span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="xs-explain">{explain(terms, o)}</p>
          <p className="xs-note">
            Backed by collateral the issuer pledged and cannot withdraw. If the issuer misses a payment, holders take
            what they are owed from that collateral, up to its value: see the issuer view. A simulation of how the terms
            work, not a forecast or a recommendation.
          </p>
        </div>
      ) : (
        <div className="xs-out" key={`s-${terms.type}`}>
          <div className="xs-head">
            <div>
              <span className="xs-kicker">What it costs you</span>
              <Slider
                id="xs-notional"
                label="Note size"
                value={notional}
                min={100_000}
                max={10_000_000}
                step={100_000}
                unit="$"
                onChange={setNotional}
              />
            </div>
            <div className={`xs-big ${costRate <= 0 ? 'up' : 'neutral'}`}>
              <span className="num">
                {costRate >= 0 ? '' : '−'}
                {pc(Math.abs(costRate), 1)}
                <em> a year</em>
              </span>
              <small>
                cost of funds · you raise {money(raised)}, you pay {money(paid)} over {months} months
              </small>
            </div>
          </div>

          <div className="xs-issuer">
            <div className="xs-calls">
              <span className="xs-kicker">Your funding calls</span>
              <ol>
                <li className="raise">
                  <span>Today</span>
                  <span>Investors subscribe: proceeds to you</span>
                  <b className="num pos">+{money(raised)}</b>
                </li>
                {sched.map((c, i) => {
                  const defaulted = miss && i >= missIdx;
                  return (
                    <li key={c.k} className={defaulted ? 'missed' : ''}>
                      <span>Month {c.month}</span>
                      <span>
                        Fund {c.label}
                        <em> · due at payment date, {grace}-day grace</em>
                      </span>
                      <b className="num">
                        {defaulted && i === missIdx ? 'missed' : defaulted ? '—' : `−${money(c.amount * notional)}`}
                      </b>
                    </li>
                  );
                })}
                {!miss && (
                  <li className="release">
                    <span>After</span>
                    <span>Collateral released back to you</span>
                    <b className="num pos">{money(pledge)}</b>
                  </li>
                )}
              </ol>
              <p className="xs-hint">
                Funding calls follow the scenario above. Assumes a 12-month note issued at par, observations evenly
                spaced every 3 months; the rate is simple, not compounded.
                {costRate < 0
                  ? ' Negative: the market fell below the knock-in, so you repay less than you raised.'
                  : ''}
              </p>
            </div>

            <div className="xs-coll">
              <span className="xs-kicker">Collateral you pledge</span>
              <label className="xs-field" htmlFor="xs-asset">
                <span className="xs-flabel">Asset</span>
                <select
                  id="xs-asset"
                  value={collId}
                  onChange={(e) => {
                    const c = COLLATERAL.find((x) => x.id === e.target.value)!;
                    setCollId(c.id);
                    setHaircut(c.haircut);
                  }}
                >
                  {COLLATERAL.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <Slider
                id="xs-haircut"
                label="Counts at (haircut)"
                value={haircut}
                min={30}
                max={100}
                step={5}
                onChange={setHaircut}
                hint={
                  coll.id === 'USDG'
                    ? 'USDG counts in full.'
                    : 'Valued by Chainlink at every observation; a margin call opens if coverage falls short.'
                }
              />
              <Slider
                id="xs-ratio"
                label="Collateral ratio"
                value={ratio}
                min={10}
                max={150}
                step={5}
                onChange={setRatio}
                hint="Set per note, shown to every investor."
              />
              <label className="xs-field" htmlFor="xs-grace">
                <span className="xs-flabel">
                  Grace period
                  <b className="num">
                    {grace} day{grace === 1 ? '' : 's'}
                  </b>
                </span>
                <input
                  id="xs-grace"
                  type="range"
                  min={0}
                  max={7}
                  value={grace}
                  onChange={(e) => setGrace(Number(e.target.value))}
                />
              </label>
              <div className="xs-pledge">
                <div>
                  <span>Required coverage</span>
                  <b className="num">{money(required)}</b>
                </div>
                <div>
                  <span>Pledge at market value</span>
                  <b className="num">{money(pledge)}</b>
                </div>
                <div>
                  <span>Locked until the last payment</span>
                  <b>{coll.label}</b>
                </div>
              </div>
            </div>
          </div>

          <div className={`xs-default${miss ? ' on' : ''}`}>
            <label className="xs-check strong">
              <input type="checkbox" checked={miss} onChange={(e) => setMiss(e.target.checked)} /> What if I miss a
              payment?
            </label>
            {miss && missed && (
              <>
                <label className="xs-field inline" htmlFor="xs-missat">
                  <span className="xs-flabel">Miss</span>
                  <select id="xs-missat" value={missIdx} onChange={(e) => setMissAt(Number(e.target.value))}>
                    {sched.map((c, i) => (
                      <option key={c.k} value={i}>
                        month {c.month}: {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  Month {missed.month} plus {grace} day{grace === 1 ? '' : 's'} of grace pass unfunded, so the note{' '}
                  <b>defaults</b>. The {money(pledge)} of {coll.label} you pledged goes to holders up to what they are
                  owed: <b className="num">{pc(recoveryPerUnit, 1)}</b> of face per unit, against{' '}
                  <b className="num">{pc(owedPerUnit, 1)}</b> owed (the missed payment plus par)
                  {paidBefore > 0 ? `, after ${pc(paidBefore, 1)} already received` : ''}.
                  {excessBack > 0 ? (
                    <>
                      {' '}
                      The remaining <b className="num">{money(excessBack)}</b> goes back to you.
                    </>
                  ) : (
                    ' Nothing is left over for you.'
                  )}{' '}
                  The note is closed and marked defaulted for everyone to see.
                </p>
                <span className="xs-hint">
                  Collateral valued at pledge-time prices; in a real default its value is whatever Chainlink prices it
                  at that day.
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

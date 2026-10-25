import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAddress } from 'viem';
import {
  CHAIN_TOKENS,
  collateralTokenOf,
  dec,
  economicsOf,
  FKIND,
  MAX_GRACE_DAYS,
  isLegacyChainTerms,
  PRODUCT_LABELS,
  type CollateralSymbol,
} from '@sn/core';
import { FIELD_LABEL, fieldLabel, noteTokenMeta, obsIndex, planIssuance, type InputValue } from '@sn/sdk';
import WrapEth from '../WrapEth';
import { issueChains, PREFERRED_CHAIN, useAddress, useChains, useSigner } from '../../lib/chains';
import { Steps } from '../ui';
import { useVerifiedEmail } from '../VerifiedEmail';
import { errText } from '../../lib/format';
import { Head } from './Head';
import { IssueAdvanced } from './issue/IssueAdvanced';
import { IssueCollateral } from './issue/IssueCollateral';
import { IssueDeposits } from './issue/IssueDeposits';
import { IssueOtherTerms } from './issue/IssueOtherTerms';
import { IssueSchedule } from './issue/IssueSchedule';
import { IssueTiming } from './issue/IssueTiming';
import type { Built, DocInfo, IssuePreset } from './types';

const toLocalInput = (t: number) => {
  const d = new Date(t * 1000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** Issue: the terms each issuance sets (size, dates, collateral, payment timing), then publish and open the book. */
export function IssuePanel({
  doc,
  built,
  preset,
  compact = false,
}: {
  doc: DocInfo;
  built: Built | null;
  preset?: IssuePreset;
  compact?: boolean;
}) {
  const nav = useNavigate();
  const me = useAddress();
  const { config, byKey } = useChains();
  const signer = useSigner();
  const plan = useMemo(() => {
    try {
      return built ? planIssuance(built.ir, built.c) : null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [built]);
  // Every note is issued on Arbitrum (the deployment's issuance chain); Robinhood Chain holds collateral only. A term
  // sheet that still names Robinhood Chain (a legacy note) can't be issued.
  const issuable = issueChains(config);
  const chainKey =
    issuable.find((c) => c.key === PREFERRED_CHAIN)?.key ??
    issuable.find((c) => c.key === preset?.chainKey)?.key ??
    issuable[0]?.key ??
    '';
  const legacyTerms = !!doc.basis && isLegacyChainTerms(doc.basis);
  const emailGate = useVerifiedEmail(); // a verified email before issuing
  const [values, setValues] = useState<Record<string, string>>({});
  const [size, setSize] = useState(preset?.size ?? doc.hint?.size ?? 10_000);
  const [strikeIn, setStrikeIn] = useState(preset?.strikeIn ?? 5);
  const [every, setEvery] = useState(preset?.every ?? { n: 3, unit: 'minutes' as 'minutes' | 'days' | 'months' });
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [isin] = useState(() => 'XS' + String(Date.now()).slice(-10));
  const ecoDefaults = economicsOf(
    doc.basis ?? { productType: 'fcn', name: '', issuePricePct: 100, underlyings: [], observations: 1 },
  );
  const [ratioPct, setRatioPct] = useState(preset?.ratioPct ?? ecoDefaults.collateralRatioPct);
  const [haircuts, setHaircuts] = useState<Record<string, number>>(
    () => preset?.haircuts ?? Object.fromEntries(ecoDefaults.collateral.map((c) => [c.symbol, c.haircutPct])),
  );
  const [pledges, setPledges] = useState<Record<string, string>>({});
  const [timing, setTiming] = useState<{ lag: number; grace: number } | null>(preset?.timing ?? null);
  const chain = byKey[chainKey];
  // Collateral locked on Robinhood Chain: the note pledges the CCIP receipts (TSLA.rh…), not the token itself.
  const remote = doc.basis?.collateralChain === 'robinhood';
  const tokOf = (c: string) =>
    collateralTokenOf(doc.basis ?? {}, c as CollateralSymbol)?.token ??
    (c === 'USD' ? (chain?.cfg.stablecoin.symbol ?? 'USDG') : c);

  if (!built)
    return (
      <>
        <Head title="Issue" />
        <div className="section">
          <p className="small muted">Fix the errors in Validate first.</p>
        </div>
      </>
    );
  if (legacyTerms)
    return (
      <>
        <Head title="Issue" />
        <div className="section">
          <div className="notice err" data-robinhood-terms>
            These terms put the note on Robinhood Chain. Notes are issued on Arbitrum only; Robinhood Chain is where
            stock collateral is locked. Edit the terms (the note moves to Arbitrum, stock settles in cash) and issue
            there.
          </div>
        </div>
      </>
    );
  if (typeof plan === 'string' || !plan)
    return (
      <>
        <Head title="Issue" />
        <div className="section">
          <div className="notice err">{plan}</div>
        </div>
      </>
    );

  const all = [plan.start, ...plan.steps];
  const inputs = all.flatMap((s) => s.inputs);
  const hasSchedule = plan.dateFields.includes('strikeDate');
  const strikeAt = Math.floor(Date.now() / 60000) * 60 + strikeIn * 60;
  const dateOf = (name: string) => {
    const k = obsIndex(name);
    if (k === 0) return strikeAt;
    if (every.unit === 'months') {
      const d = new Date(strikeAt * 1000);
      d.setUTCMonth(d.getUTCMonth() + every.n * k);
      return Math.floor(d.getTime() / 1000);
    }
    return strikeAt + k * every.n * (every.unit === 'days' ? 86400 : 60);
  };
  const sym = chain?.cfg.stablecoin.symbol ?? 'USDG';
  // Collateral and payment timing: per issuance. Minutes-apart demo schedules get seconds; real ones, days.
  const names = new Set(inputs.map((f) => f.name));
  const collateralSyms = [...names].filter((n) => n.startsWith('pledge_')).map((n) => n.slice(7));
  const stepSec =
    every.unit === 'minutes' ? every.n * 60 : every.unit === 'days' ? every.n * 86400 : every.n * 30 * 86400;
  const demo = every.unit === 'minutes';
  const t =
    timing ??
    (demo
      ? { lag: Math.min(30, Math.floor(stepSec / 4)), grace: Math.min(60, Math.floor(stepSec / 3)) }
      : { lag: ecoDefaults.settlementLagDays * 86400, grace: ecoDefaults.gracePeriodDays * 86400 });
  const required = (ratioPct / 100) * size;
  const pledgeOf = (c: string) =>
    pledges[c] ??
    (c === 'USD' && collateralSyms.length === 1
      ? String(Math.ceil((required / ((haircuts[c] ?? 100) / 100)) * 100) / 100)
      : '');
  const usdCoverage = collateralSyms.reduce(
    (a, c) => a + (c === 'USD' ? ((Number(pledgeOf(c)) || 0) * (haircuts[c] ?? 100)) / 100 : 0),
    0,
  );
  const timingBad =
    hasSchedule && t.lag + t.grace > stepSec
      ? 'The payment date plus grace must fall before the next observation: shorten the lag or grace, or observe less often.'
      : t.grace > MAX_GRACE_DAYS * 86400
        ? `The grace period is at most ${MAX_GRACE_DAYS} days.`
        : '';
  const auto = (name: string): string | null => {
    if (name === 'notional') return String(size);
    if (name === 'isin') return values.isin ?? isin;
    if (hasSchedule && plan.dateFields.includes(name)) return String(dateOf(name));
    if (name === 'lag') return String(t.lag);
    if (name === 'grace') return String(t.grace);
    if (name === 'collateralRatio') return String(ratioPct / 100);
    if (name.startsWith('haircut_')) return String((haircuts[name.slice(8)] ?? 100) / 100);
    if (name.startsWith('pledge_')) return pledgeOf(name.slice(7));
    return null;
  };
  const kindOf = (name: string) => inputs.find((f) => f.name === name)?.kind;
  const valueOf = (name: string) =>
    auto(name) ?? values[name] ?? (kindOf(name) === FKIND.Date ? toLocalInput(strikeAt) : '');
  const handled = (n: string) =>
    ['notional', 'isin', 'lag', 'grace', 'collateralRatio'].includes(n) ||
    /^(haircut|pledge)_/.test(n) ||
    (hasSchedule && plan.dateFields.includes(n));
  const generic = inputs.filter((f) => !handled(f.name));
  // Cash settles in the network's stablecoin; a delivered underlying (WETH, TSLA…) needs its token on that network.
  const isCash = (token?: string) => !token || /^(t?USD|USDC|USDG)$/i.test(token);
  const tokenOf = (token?: string) => (isCash(token) ? chain?.cfg.stablecoin.address : chain?.cfg.tokens?.[token!]);
  const unsupported = built.ir.assets
    .filter((a) => a.kind === 'cash' && !tokenOf(a.token))
    .map((a) => a.token ?? 'cash');

  const issue = async () => {
    if (!me || !chain) return;
    setBusy(true);
    setError('');
    setProgress([]);
    const step = (s: string) => setProgress((x) => [...x, s]);
    try {
      if (hasSchedule && strikeAt < Date.now() / 1000 + 60)
        throw new Error('The strike date must be at least a minute away.');
      if (unsupported.length)
        throw new Error(
          `${chain.cfg.name} has no token configured for ${unsupported.join(', ')}.${unsupported.some((t) => !!CHAIN_TOKENS['robinhood-testnet'][t]) ? " Robinhood Chain's stock tokens stay on Robinhood Chain: settle in cash, and lock stock collateral there (its .rh receipt is pledged on Arbitrum)." : ''}`,
        );
      if (timingBad) throw new Error(timingBad);
      const value = (f: { name: string; kind: number }): InputValue => {
        const raw = valueOf(f.name).trim();
        if (!raw) throw new Error(`Enter ${fieldLabel(f.name)}.`);
        if (f.kind === FKIND.Text) return { kind: 'text', value: raw };
        if (f.kind === FKIND.Party) {
          if (!isAddress(raw)) throw new Error(`${f.name}: enter an address.`);
          return { kind: 'party', value: raw };
        }
        if (f.kind === FKIND.Date)
          return {
            kind: 'number',
            value: BigInt(/^\d+$/.test(raw) ? raw : Math.floor(new Date(raw).getTime() / 1000)),
          };
        if (f.kind === FKIND.Bool) return { kind: 'number', value: raw === 'true' ? 1n : 0n };
        if (f.kind === FKIND.Int) return { kind: 'number', value: BigInt(raw) };
        return { kind: 'number', value: dec(raw) };
      };
      const byStep = Object.fromEntries(
        all.map((s) => [s.index, Object.fromEntries(s.inputs.map((f) => [f.field, value(f)]))]),
      );
      const { c } = built;
      step(`Workflow compiled: ${c.def.steps.length} steps, ${c.bytes.length.toLocaleString()} bytes.`);
      const cashTokens = Object.fromEntries(plan.cashAssets.map((a) => [a, tokenOf(built.ir.assets[a].token)!]));
      const w = await signer(chainKey);
      // The note's units are an ERC-20: e.g. "notes.markets ETH/BTC Phoenix 26-10" / "nmETHBTC1".
      const basis = doc.basis;
      const lastObs = hasSchedule && basis?.observations ? dateOf(`obsDate${basis.observations}`) : undefined;
      const ref = BigInt(Date.now());
      const token = noteTokenMeta({
        label: basis ? (PRODUCT_LABELS[basis.productType] ?? 'Note') : c.def.name || 'Note',
        underlyings: (basis?.underlyings ?? []).map((u) => u.symbol),
        maturity: lastObs,
        seq: ref,
      });
      const r = await chain.adapter.issue(
        w,
        { definition: c.bytes, def: c.def, plan, ref, cashTokens, inputs: byStep, token },
        step,
      );
      step('Book open.');
      nav(`/note/${encodeURIComponent(r.id)}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const deposits = plan.steps.filter((s) => s.deposits.length);
  return (
    <>
      {!compact && (
        <Head
          title="Issue this note"
          sub="Four steps. Publishing opens the book: investors subscribe until the strike date and their USDG is yours. Chainlink CRE then checks prices on each date, and you fund each payment before it falls due."
        />
      )}
      <div className="section">
        {!compact && (
          <div className="step-h">
            <span className="n">1</span>
            <h3>Network and size</h3>
          </div>
        )}
        {!compact && (
          <div className="field" data-issue-network>
            <span className="lbl">Network</span>
            <strong>
              {byKey[chainKey]?.cfg.name ?? chainKey}
              {byKey[chainKey]?.cfg.cre === false ? ' (fallback keeper)' : ''}
            </strong>
            <span className="hint">
              Every note is issued and paid on Arbitrum. Robinhood Chain holds collateral only (stock tokens locked in
              its vault).
            </span>
          </div>
        )}
        <div className="form-grid" hidden={compact}>
          {inputs.some((f) => f.name === 'notional') && (
            <div className="field">
              <label htmlFor="is-size">{FIELD_LABEL.notional.replace('USDC', sym)}</label>
              <input
                id="is-size"
                type="number"
                min={1}
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
              />
            </div>
          )}
          {inputs.some((f) => f.name === 'isin') && (
            <div className="field">
              <label htmlFor="is-isin">{FIELD_LABEL.isin}</label>
              <input
                id="is-isin"
                maxLength={32}
                value={values.isin ?? isin}
                onChange={(e) => setValues((v) => ({ ...v, isin: e.target.value }))}
              />
            </div>
          )}
        </div>
      </div>
      {hasSchedule && !compact && (
        <IssueSchedule
          strikeIn={strikeIn}
          setStrikeIn={setStrikeIn}
          every={every}
          setEvery={setEvery}
          strikeAt={strikeAt}
          plan={plan}
          dateOf={dateOf}
        />
      )}
      {names.has('collateralRatio') && (
        <IssueCollateral
          compact={compact}
          ratioPct={ratioPct}
          setRatioPct={setRatioPct}
          required={required}
          sym={sym}
          collateralSyms={collateralSyms}
          tokOf={tokOf}
          haircuts={haircuts}
          setHaircuts={setHaircuts}
          pledgeOf={pledgeOf}
          setPledges={setPledges}
          remote={remote}
          chain={chain}
          usdCoverage={usdCoverage}
        />
      )}
      {names.has('grace') && !compact && <IssueTiming demo={demo} t={t} setTiming={setTiming} timingBad={timingBad} />}
      {generic.length > 0 && <IssueOtherTerms generic={generic} sym={sym} valueOf={valueOf} setValues={setValues} />}
      <div className="section">
        {deposits.length > 0 && <IssueDeposits deposits={deposits} built={built} />}
        {deposits.length > 0 && built.ir.assets.some((a) => a.token === 'WETH') && <WrapEth chainKey={chainKey} />}
        {unsupported.length > 0 && (
          <div className="notice warn">
            This note needs {unsupported.join(', ')} on {chain?.cfg.name}, which this deployment does not configure yet.
          </div>
        )}
        <button
          className="btn primary lg"
          disabled={!me || busy || !chain}
          onClick={() => void emailGate.require(chainKey, issue)}
        >
          {me
            ? busy
              ? 'Confirm each step in your wallet…'
              : 'Publish and open the book'
            : 'Connect a wallet to issue'}
        </button>
        {emailGate.dialog}
        {progress.length > 0 && (
          <div data-progress>
            <Steps
              items={progress.map((p, i) => ({
                label: p,
                state: i < progress.length - 1 || p === 'Book open.' ? 'done' : error ? 'err' : 'now',
              }))}
            />
          </div>
        )}
        {error && (
          <div className="notice err" role="alert">
            {error}
          </div>
        )}
        <IssueAdvanced plan={plan} all={all} chain={chain} />
      </div>
    </>
  );
}

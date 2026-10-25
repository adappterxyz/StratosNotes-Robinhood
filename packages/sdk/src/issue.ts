/**
 * How to issue a workflow, read from the workflow itself, so it works for stock products and custom notes
 * alike (ported from the hackathon app):
 *  - roles: an OPEN pool (the investors' book) is anyone's (address 0); an escrow pool is the engine's (address 0
 *    too: the engine assigns its escrow account); every other pool is held by the issuer;
 *  - the issuer starts at the start event of a pool it holds (Issuer first);
 *  - the pre-trade steps are the user tasks that follow that start event in the same pool (a product's Approve
 *    Terms + Pledge Collateral, then Mandate Paying Agent), stepping over automatic steps (Check Terms) and
 *    stopping at the funding windows. Their input fields become the issue form, and a step that deposits
 *    (the collateral pledge) pulls it from the issuer's wallet.
 */
import { evalExpr, FKIND, OP, openPoolIds, SRC, type Compiled, type WorkflowDef, type WorkflowIR } from '@sn/core';

export interface PlanInput {
  field: number;
  name: string;
  kind: number;
}
export interface PlanStep {
  id: string;
  name: string;
  index: number;
  inputs: PlanInput[];
  /** Cash assets this step pulls from the signer (DEPOSIT ops), with each op's amount expression. */
  deposits: Array<{ asset: number; amountExpr: number }>;
}
export interface IssuePlan {
  start: PlanStep;
  /** User tasks run right after the start, in order. */
  steps: PlanStep[];
  openPools: string[];
  heldPools: string[];
  /** Per role: true when anyone may act in it (the investors' book). */
  openRoles: boolean[];
  /** Per role: true for an escrow account the engine holds (startProcess takes address 0 for it). */
  escrowRoles: boolean[];
  cashAssets: number[];
  /** Product-shaped schedule: a strike date and observation dates. */
  dateFields: string[];
}

export function planIssuance(ir: WorkflowIR, c: Compiled): IssuePlan {
  const open = openPoolIds(ir);
  const starts = ir.nodes.filter((n) => n.type === 'startEvent' && !open.has(n.pool));
  const poolName = (id: string) => ir.pools.find((p) => p.id === id)?.name ?? id;
  const start = starts.find((n) => /issuer/i.test(poolName(n.pool))) ?? starts[0];
  if (!start)
    throw new Error('The workflow needs a start event in a pool the issuer holds (one without a subscription window).');
  const step = (id: string): PlanStep => {
    const index = c.stepIndex[id];
    const s = c.def.steps[index];
    const node = ir.nodes.find((n) => n.id === id)!;
    return {
      id,
      name: node.name || id,
      index,
      inputs: s.captures
        .filter((x) => x.source === SRC.INPUT)
        .map((x) => ({ field: x.field, name: c.def.fields[x.field].name, kind: c.def.fields[x.field].kind })),
      deposits: s.ops.filter((o) => o.kind === OP.DEPOSIT).map((o) => ({ asset: o.asset, amountExpr: o.amount })),
    };
  };
  const steps: PlanStep[] = [];
  const flowsFrom = (id: string) => ir.flows.filter((f) => f.source === id);
  let at: string | undefined = flowsFrom(start.id)[0]?.target;
  const seen = new Set<string>();
  while (at && !seen.has(at)) {
    seen.add(at);
    const n = ir.nodes.find((x) => x.id === at);
    if (!n || n.pool !== start.pool) break;
    // Automatic steps (e.g. Check Terms) run in the same transaction as the step before them.
    const automatic = n.type === 'serviceTask' && !(n.props.templateFields ?? []).some((f) => !f.oracle && !f.formula);
    if (!automatic && (n.type !== 'userTask' || n.props.until)) break; // windows (funding, top-ups) open after issuance
    if (!automatic) steps.push(step(n.id));
    const out = flowsFrom(n.id);
    at = out.length === 1 ? out[0].target : undefined;
  }
  const all = [step(start.id), ...steps].flatMap((s) => s.inputs);
  // Roles are the pools, in pool order (compile.ts).
  return {
    start: step(start.id),
    steps,
    openPools: ir.pools.filter((p) => open.has(p.id)).map((p) => p.name),
    heldPools: ir.pools.filter((p) => !open.has(p.id)).map((p) => p.name),
    openRoles: ir.pools.map((p) => open.has(p.id)),
    escrowRoles: ir.pools.map((p) => !!p.escrow),
    cashAssets: ir.assets.map((a, i) => (a.kind === 'cash' ? i : -1)).filter((i) => i >= 0),
    dateFields: all.filter((f) => f.kind === FKIND.Date && /^(strikeDate|obsDate\d+)$/.test(f.name)).map((f) => f.name),
  };
}

/** A typed input value: numbers in engine form (fixed point for decimals, plain for dates/ints), text, a party. */
export type InputValue =
  { kind: 'number'; value: bigint } | { kind: 'text'; value: string } | { kind: 'party'; value: string };

/**
 * The amounts (engine fixed point) a step's deposits will pull, given every field value known by then
 * (`known`, by field index: earlier steps' inputs plus this step's own). Null for an amount that cannot be
 * computed yet (a field it reads is unset).
 */
export function depositAmounts(
  def: WorkflowDef,
  step: PlanStep,
  known: Map<number, bigint>,
): Array<{ asset: number; amount: bigint | null }> {
  const kinds = def.fields.map((f) => f.kind);
  return step.deposits.map((d) => ({
    asset: d.asset,
    amount: evalExpr(def.exprs[d.amountExpr], kinds, (f) => known.get(f) ?? null),
  }));
}

/** "obsDate3" -> 3; strikeDate -> 0. */
export const obsIndex = (name: string) => (name === 'strikeDate' ? 0 : Number(name.replace('obsDate', '')));

export const FIELD_LABEL: Record<string, string> = {
  isin: 'ISIN / reference',
  notional: 'Size (units of 1 USDC)',
  strikeDate: 'Strike date (book closes)',
  units: 'Units',
  lag: 'Settlement lag (seconds after each observation)',
  grace: 'Grace period (seconds, up to 7 days)',
  collateralRatio: 'Collateral ratio (share of the notional, e.g. 1 = 100%)',
  fundAmount: 'Amount (USDC)',
};

/** Labels for the per-asset fields of a collateralised note (haircut_ETH, pledge_ETH, topUp_ETH, fundDelivery_ETH). */
export function fieldLabel(name: string): string {
  if (FIELD_LABEL[name]) return FIELD_LABEL[name];
  const m = /^(haircut|pledge|topUp|fundDelivery)_([A-Z]+)$/.exec(name);
  if (m) {
    const sym = m[2] === 'USD' ? 'USDC' : `t${m[2]}`;
    return {
      haircut: `${sym} collateral haircut (share of value counted, e.g. 0.7)`,
      pledge: `${sym} collateral pledged`,
      topUp: `Top up ${sym} collateral`,
      fundDelivery: `Fund ${sym} delivery`,
    }[m[1]]!;
  }
  if (/^obsDate\d+$/.test(name)) return `Observation ${name.slice(7)} date`;
  return name;
}

/**
 * The ERC-20 name and symbol of a note's units (FlowEngine v4 creates one NoteToken per note): e.g.
 * "notes.markets ETH/BTC Phoenix 26-10" and "nmETHBTC1". `seq` tells apart notes on the same underlyings
 * (the issuer's reference, or the note count); `maturity` (unix seconds) gives the YY-MM suffix.
 */
export function noteTokenMeta(o: { label: string; underlyings: string[]; maturity?: number; seq?: number | bigint }): {
  name: string;
  symbol: string;
} {
  const unds = o.underlyings.map((u) => u.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).filter(Boolean);
  const d = o.maturity ? new Date(o.maturity * 1000) : null;
  const ym = d ? ` ${String(d.getUTCFullYear()).slice(2)}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` : '';
  const label = o.label.replace(/\s+/g, ' ').trim() || 'Note';
  const name = `notes.markets ${unds.length ? `${unds.join('/')} ` : ''}${label}${ym}`.slice(0, 64);
  const seq = o.seq === undefined ? '' : String(BigInt(o.seq) % 1000n);
  const symbol = `nm${unds.join('').slice(0, 8) || 'NOTE'}${seq}`.slice(0, 14);
  return { name, symbol };
}

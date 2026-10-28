/**
 * What one step of a note's workflow means for THIS note, in plain words: what it does, who acts, when, whether it
 * has run, and the values it captured or checked. Read-only, and only from data the note page already has: the
 * decoded definition (steps, roles, fields, asset operations), the note's state and view (strike, observations,
 * the payment schedule, collateral), and the note's event history (each StepRun and the FieldSet values its
 * transaction wrote). Nothing here invents a number: a value that is not on the chain yet reads "not yet".
 */
import { FKIND, KIND, OP, SCALE, type ProductParams, type WorkflowDef } from '@sn/core';
import type { FieldValue, NoteState, NoteView, PeriodStatus } from '@sn/sdk';
import { fmtDate, fmtMoney, fmtPct, fmtPrice } from './format';

/** One element of the diagram, as the viewer read it from the BPMN. */
export interface DiagramElement {
  id: string;
  /** BPMN type, e.g. bpmn:ServiceTask, bpmn:ExclusiveGateway, bpmn:Participant. */
  type: string;
  name: string;
  /** Gateways: the names of the ways out ("Barrier met", "Missed"). */
  branches: string[];
  /** The role (pool) the step sits in. */
  pool?: string;
}

/** One run of a step, from the note's history: when, in which transaction, and the fields it wrote. */
export interface StepRun {
  at: number;
  tx: string;
  values: Record<number, FieldValue>;
}

/** The note's history, as GET /api/notes/:id/history returns it (newest first). */
export interface HistoryLike {
  name: string;
  block: number;
  seq: number;
  tx: string;
  at: number;
  data: Record<string, unknown>;
}

export type StepStatus = 'now' | 'done' | 'later';

export interface Fact {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
  /** The value is an address (rendered short, with a copy/explorer link). */
  addr?: boolean;
}

export interface StepFacts {
  title: string;
  /** What kind of step, in words: "Automatic step", "Someone acts", "Decision", "Start", "End", "Role". */
  kind: string;
  plain: string;
  who: string;
  status: StepStatus | null;
  statusText: string;
  when?: { label: string; t: number };
  /** When the step ran (most recent last), with the transaction. */
  runs: Array<{ at: number; tx: string }>;
  facts: Fact[];
  /** Money and units the step moves, in words. */
  moves: string[];
  /** Gateways: the ways out. */
  branches: string[];
}

export interface FactsContext {
  def: WorkflowDef;
  state: NoteState;
  view: NoteView;
  /** The note's cash symbol (USDG). */
  sym: string;
  /** Runs per step index, from the history (runsOf); empty when it isn't loaded. */
  runs: Map<number, StepRun[]>;
}

const ZERO = /^0x0{40}$/i;

/** Pair each StepRun with the FieldSet events its transaction wrote for that step's captures. */
export function runsOf(events: HistoryLike[], def: WorkflowDef): Map<number, StepRun[]> {
  const out = new Map<number, StepRun[]>();
  const chrono = [...events].sort((a, b) => a.block - b.block || a.seq - b.seq);
  const pending = new Map<string, Array<{ field: number; value: FieldValue }>>();
  for (const e of chrono) {
    if (e.name === 'FieldSet') {
      const field = Number(e.data.field);
      const value = e.data.value as FieldValue | undefined;
      if (!Number.isInteger(field) || !value) continue;
      const list = pending.get(e.tx) ?? [];
      list.push({ field, value });
      pending.set(e.tx, list);
    } else if (e.name === 'StepRun') {
      const step = Number(e.data.step);
      const st = def.steps[step];
      if (!st) continue;
      const mine = new Set(st.captures.map((c) => c.field));
      const values: Record<number, FieldValue> = {};
      const list = pending.get(e.tx) ?? [];
      const rest = list.filter((x) => {
        if (!mine.has(x.field)) return true;
        values[x.field] = x.value;
        return false;
      });
      pending.set(e.tx, rest);
      const runs = out.get(step) ?? [];
      runs.push({ at: e.at, tx: e.tx, values });
      out.set(step, runs);
    }
  }
  return out;
}

const fixed = (v: string) => Number(BigInt(v)) / Number(SCALE);

/** "2 days", "90 seconds". */
export function duration(s: number) {
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400} day${s === 86400 ? '' : 's'}`;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
  if (s >= 60 && s % 60 === 0) return `${s / 60} minute${s === 60 ? '' : 's'}`;
  return `${s} seconds`;
}

/** A field's name in words. */
export function fieldLabel(name: string): string {
  let m: RegExpExecArray | null;
  const fixedNames: Record<string, string> = {
    isin: 'ISIN',
    notional: 'Size',
    strikeDate: 'Strike date',
    lag: 'Time to fund each payment',
    grace: 'Grace period',
    collateralRatio: 'Collateral required',
    initialLevel: 'Strike',
    sold: 'Units sold',
    required: 'Collateral needed',
    coverage: 'Collateral value',
    missed: 'Coupons missed so far',
    cpn: 'Coupon this period',
    due: 'Due per unit',
    dueTotal: 'Due in total',
    owedDue: 'Owed for a missed payment',
    principal: 'Principal owed',
    owed: 'Owed to holders',
    closedAt: 'Closed at',
    units: 'Units bought',
    payDate: 'Payment date',
    fundAmount: 'Amount funded',
  };
  if (fixedNames[name]) return fixedNames[name];
  if ((m = /^obsDate(\d+)$/.exec(name))) return `Observation ${m[1]} date`;
  if ((m = /^fundUntil(\d+)$/.exec(name))) return `Funding window ${m[1]} closes`;
  if ((m = /^initialLevel_(.+)$/.exec(name))) return `${m[1]} strike`;
  if ((m = /^obs(\d+)_(.+)$/.exec(name))) return `${m[2]} level`;
  if (/^obs\d+$/.test(name)) return 'Level observed';
  if (/^perf\d+$/.test(name)) return 'Worst performance';
  if ((m = /^haircut_(.+)$/.exec(name))) return `${m[1]} counted at`;
  if ((m = /^pledge_(.+)$/.exec(name))) return `${m[1]} pledged`;
  if ((m = /^topUp_(.+)$/.exec(name))) return `${m[1]} topped up`;
  if ((m = /^px_(.+)$/.exec(name))) return `${m[1]} price`;
  if ((m = /^take_(.+)$/.exec(name))) return `Holders take (${m[1].replace(/^col_/, '')})`;
  return name;
}

/** A field's value in words. `strikeOf` gives an underlying's strike, to show a level as a share of it. */
export function fieldValue(
  name: string,
  kind: number,
  v: FieldValue | undefined,
  sym: string,
  strikeOf: (sym: string | null) => number | null = () => null,
): string {
  if (!v) return 'not yet';
  if (v.tag !== 1) return v.value;
  if (kind === FKIND.Date) return fmtDate(Number(v.value));
  if (kind === FKIND.Int)
    return /^(lag|grace)$/.test(name) ? duration(Number(v.value)) : Number(v.value).toLocaleString();
  if (kind === FKIND.Bool) return v.value === '0' ? 'no' : 'yes';
  const x = fixed(v.value);
  if (/^(collateralRatio|haircut_.+|perf\d+|cpn)$/.test(name)) return fmtPct(x);
  if (name === 'due') return `${x.toFixed(4)} ${sym}`;
  if (/^(dueTotal|owedDue|principal|owed|required|coverage|notional|fundAmount)$/.test(name))
    return `${fmtMoney(x)} ${sym}`;
  let t: RegExpExecArray | null;
  if ((t = /^(?:pledge|topUp)_(.+)$/.exec(name)))
    return `${x.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${t[1] === 'USD' ? sym : t[1]}`;
  if (/^(sold|units)$/.test(name)) return fmtMoney(x, x % 1 ? 2 : 0);
  let m: RegExpExecArray | null;
  if ((m = /^obs\d+(?:_(.+))?$/.exec(name))) {
    const s = strikeOf(m[1] ?? null);
    return s ? `${fmtPrice(x)} (${fmtPct(x / s)} of strike)` : fmtPrice(x);
  }
  if (/^(initialLevel|initialLevel_.+|px_.+)$/.test(name)) return fmtPrice(x);
  return x.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

const PERIOD_STATUS: Record<PeriodStatus, string> = {
  upcoming: 'not due yet',
  'nothing-due': 'nothing due',
  due: 'due now',
  paid: 'paid',
  grace: 'in its grace period',
  missed: 'missed',
  cancelled: 'cancelled',
};

/** "Collateral TSLA.rh" -> TSLA, "USDG" -> USDG, "d_TSLA" -> TSLA. */
const assetName = (def: WorkflowDef, i: number) =>
  (def.assets[i]?.name ?? `asset ${i}`)
    .replace(/^Collateral /, '')
    .replace(/^d_/, '')
    .replace(/\.[a-z]+$/, '');

function movesOf(def: WorkflowDef, i: number): string[] {
  const role = (r: number) => def.roles[r] ?? `role ${r}`;
  const a = (x: number) => (def.assets[x]?.name === 'Note' ? 'note units' : assetName(def, x));
  return def.steps[i].ops
    .map((o) => {
      switch (o.kind) {
        case OP.MINT:
          return `Creates ${a(o.asset)} for the ${role(o.toRole)}.`;
        case OP.BURN:
          return `Cancels ${a(o.asset)} the ${role(o.fromRole)} still holds.`;
        case OP.TRANSFER:
          return `Moves ${a(o.asset)} from the ${role(o.fromRole)} to the ${role(o.toRole)}.`;
        case OP.DEPOSIT:
          return `The ${role(o.fromRole)} pays in ${a(o.asset)} from their wallet.`;
        case OP.SWAP:
          return `The ${role(o.toRole)} pays ${a(o.asset2)} to the ${role(o.fromRole)} and receives ${a(o.asset)}, in one transaction.`;
        case OP.DISTRIBUTE:
          return `Pays ${a(o.asset)} from the ${role(o.fromRole)} to every holder of ${a(o.asset2)}${o.retire ? ', and retires the units' : ''}.`;
        default:
          return '';
      }
    })
    .filter(Boolean);
}

/** What the step is for, in plain words: the stock products' steps by id, anything else by its kind. */
function plainOf(
  id: string,
  kind: number | null,
  type: string,
  p: Partial<ProductParams>,
  syms: string[],
  sym: string,
): string {
  let m: RegExpExecArray | null;
  const und = syms.length > 1 ? 'the worst of the underlyings' : (syms[0] ?? 'the underlying');
  if (id === 'Start_Issuer') return 'The issuer drafts the offer.';
  if (id === 'Task_ApproveTerms')
    return "The issuer fixes this issuance's size and dates and pledges the collateral into escrow.";
  if (id === 'Task_CheckTerms')
    return 'Checks the terms hold together: dates in order, each payment settled before the next observation.';
  if (id === 'Task_Mandate') return 'The issuer hands the note to the paying agent, which runs it from here.';
  if (id === 'Recv_Mandate') return 'The paying agent takes over the note.';
  if (id === 'Task_IssueNote') return 'Creates the note units. The issuer holds them until investors buy them.';
  if (id === 'Recv_Offer') return 'The note is listed: investors can see it and subscribe.';
  if (id === 'Task_Subscribe')
    return `Investors buy units with ${sym} until the book closes. The ${sym} goes to the issuer, the units to the investor.`;
  if (id === 'End_Investor') return 'The book is closed: no more subscriptions.';
  if (id === 'Task_FixStrike')
    return `On the strike date Chainlink CRE reports the starting price of ${und}: the strike. Units nobody bought are cancelled.`;
  if (id === 'GW_Sold')
    return 'If nobody subscribed, the note is cancelled and the collateral goes back to the issuer.';
  if (/^GW_Margin\d+$/.test(id))
    return 'Checks that the collateral, at its latest price and haircut, still covers what the note needs.';
  if (/^Task_MarginCall\d+$/.test(id)) return 'The collateral fell short: the issuer is asked to top it up.';
  if (/^Recv_MarginCure\d+$/.test(id))
    return 'Waits for the issuer to top up the collateral, until the grace period ends.';
  if (/^GW_MarginCured\d+$/.test(id)) return 'Topped up in time? If not, the note defaults.';
  if (/^Task_MarginCured\d+$/.test(id)) return 'The collateral covers the note again.';
  if ((m = /^Task_Observe(\d+)$/.exec(id)))
    return `On observation date ${m[1]} Chainlink CRE reports the price of ${syms.length > 1 ? 'each underlying' : und}.`;
  if (/^GW_Coupon\d+$/.test(id))
    return `A coupon is due if ${und} is at or above ${p.couponBarrierPct}% of its strike.`;
  if (/^Task_CouponOn\d+$/.test(id))
    return p.memory ? 'This period pays the coupon, plus any coupons missed before.' : 'This period pays the coupon.';
  if (/^Task_CouponOff\d+$/.test(id))
    return p.memory
      ? 'No coupon this period; it is remembered and paid later if the price recovers.'
      : 'No coupon this period.';
  if (/^GW_HasCoupon\d+$/.test(id)) return 'Anything to pay this period?';
  if (/^GW_Autocall\d+$/.test(id))
    return `If ${und} is at or above ${p.autocallLevelPct}% of its strike, the note is repaid early.`;
  if (id === 'GW_FinalAutocall')
    return `At maturity: called if ${und} is at or above ${p.autocallLevelPct}% of its strike.`;
  if (id === 'GW_KnockIn')
    return `At maturity: at or above ${p.knockInBarrierPct}% of the strike, holders get their money back in full; below it they take the loss${p.settlement === 'physical' ? ' in the stock' : ''}.`;
  if (id === 'GW_Worst') return 'Finds the worst performer: that is the stock delivered.';
  if (/^S_Due\d+/.test(id)) return 'Payment date: works out what is owed per unit.';
  if (/^GW_Funded\d+/.test(id)) return 'Has the issuer put the payment in escrow?';
  if (/^Task_Missed\d+/.test(id)) return 'The issuer did not fund the payment in time: a grace period starts.';
  if (/^Recv_Grace\d+/.test(id)) return 'Waits for the issuer to fund the payment, until the grace period ends.';
  if (/^GW_Cured\d+/.test(id)) return 'Funded within the grace period? If not, the note defaults.';
  if (/^Task_Pay\d+/.test(id)) return 'Pays every holder from escrow, in proportion to their units.';
  if (id === 'Task_Default') return 'Default: the collateral in escrow goes to the holders, up to what they are owed.';
  if (id === 'Task_Release') return 'The note is done: what is left in escrow goes back to the issuer.';
  if (/^Task_Fund\d+$/.test(id)) return 'The issuer puts the money for this payment into escrow, before its date.';
  if (/^Task_TopUp_/.test(id)) return 'The issuer can add collateral at any time.';
  if (/^Task_FundDelivery_/.test(id)) return 'The issuer puts the stock to deliver into escrow.';
  if (id === 'GW_Windows') return "Opens the issuer's funding and top-up windows.";
  if (id === 'GW_WindowsClosed') return 'Waits until every funding window has closed.';
  if (type === 'bpmn:Participant') return 'A role in this note: who acts in the steps inside this lane.';
  switch (kind) {
    case KIND.START:
      return 'Where this part of the note starts.';
    case KIND.END:
      return 'Where this path ends.';
    case KIND.USER:
      return 'Someone in this role acts here, by signing a transaction.';
    case KIND.SERVICE:
      return 'Runs on its own once it is due.';
    case KIND.RECEIVE:
      return 'Waits for a message from another step, or for its condition to hold.';
    case KIND.XOR:
      return 'Chooses one way out, by the rules on each branch.';
    case KIND.AND:
      return 'Splits into steps that run side by side, or waits for all of them.';
    case KIND.CATCH:
      return 'Waits until its date.';
    default:
      return '';
  }
}

function kindLabel(kind: number | null, type: string) {
  if (type === 'bpmn:Participant') return 'Role';
  switch (kind) {
    case KIND.START:
      return 'Start';
    case KIND.END:
      return 'End';
    case KIND.USER:
      return 'Someone acts';
    case KIND.XOR:
    case KIND.AND:
      return 'Decision';
    case KIND.RECEIVE:
    case KIND.CATCH:
      return 'Wait';
    default:
      return 'Automatic step';
  }
}

/** The facts for one diagram element, for this note. */
export function stepFacts(el: DiagramElement, ctx: FactsContext): StepFacts {
  const { def, state: s, view: v, sym } = ctx;
  const title = el.name || el.id;
  const done = s.status === 1;

  // A pool: the role, and who holds it on this note.
  if (el.type === 'bpmn:Participant' || el.type === 'bpmn:Lane') {
    const r = def.roles.indexOf(el.name);
    const holder = r >= 0 ? s.roles[r] : undefined;
    const escrow = r >= 0 && ((def.roleFlags?.[r] ?? 0) & 1) === 1;
    const facts: Fact[] = [];
    if (escrow) facts.push({ label: 'Held by', value: 'the note itself: nobody signs for it' });
    else if (holder && ZERO.test(holder)) facts.push({ label: 'Held by', value: 'anyone: any wallet can act here' });
    else if (holder) facts.push({ label: 'Held by', value: holder, addr: true });
    return {
      title,
      kind: 'Role',
      plain: escrow
        ? 'The escrow: an account the note holds. Collateral and payments wait here until a step moves them.'
        : 'A role in this note: who acts in the steps in this lane.',
      who: el.name,
      status: null,
      statusText: '',
      runs: [],
      facts,
      moves: [],
      branches: [],
    };
  }

  const i = def.steps.findIndex((x) => x.id === el.id);
  const st = i >= 0 ? def.steps[i] : null;
  const kind = st ? st.kind : null;
  const runs = (i >= 0 ? ctx.runs.get(i) : undefined) ?? [];
  const facts: Fact[] = [];
  const add = (label: string, value: string, tone?: Fact['tone']) => facts.push({ label, value, tone });

  // Who acts.
  const roleName = st ? (def.roles[st.role] ?? '') : '';
  const roleHolder = st ? s.roles[st.role] : undefined;
  let who: string;
  if (!st) who = '—';
  else if (kind === KIND.USER)
    who =
      roleHolder && ZERO.test(roleHolder)
        ? `Any ${roleName.toLowerCase() || 'wallet'}, by signing a transaction`
        : `The ${roleName}, by signing a transaction`;
  else if (kind === KIND.START || kind === KIND.END) who = `The ${roleName}'s part of the note`;
  else if (st.captures.some((c) => c.source === 1))
    who = 'Automatic: Chainlink CRE reports the prices and the engine runs it';
  else who = `Automatic: the engine runs it for the ${roleName}`;

  // Status: here now, done (it ran: from the history, a milestone, or a value only it writes), or not yet.
  const active = v.activeSteps.includes(el.id);
  const captureOwners = new Map<number, number>();
  def.steps.forEach((x) =>
    x.captures.forEach((c) => captureOwners.set(c.field, (captureOwners.get(c.field) ?? 0) + 1)),
  );
  const uniqueSet = !!st && st.captures.some((c) => captureOwners.get(c.field) === 1 && s.values[c.field]);
  const milestone = (s.milestones ?? []).filter((m) => m.step === i);
  const ran = runs.length > 0 || milestone.length > 0 || uniqueSet;
  const status: StepStatus | null = !st ? null : active ? 'now' : ran ? 'done' : 'later';
  const statusText =
    status === 'now'
      ? kind === KIND.USER
        ? 'Here now: waiting for someone to act'
        : st?.until
          ? 'Here now: open'
          : 'Here now: waiting for its time or condition'
      : status === 'done'
        ? runs.length > 1
          ? `Done (${runs.length} times)`
          : 'Done'
        : status === 'later'
          ? done
            ? 'Not run: the note took another path'
            : 'Not reached yet'
          : '';

  // When.
  const dateOfDue = (d: { kind: number; at: bigint; field: number } | null) => {
    if (!d) return 0;
    if (d.kind === 0) return Number(d.at);
    const val = s.values[d.field];
    return val && val.tag === 1 ? Number(val.value) : 0;
  };
  let when: StepFacts['when'];
  if (st?.timer) when = { label: 'Due', t: dateOfDue(st.timer) };
  if (st?.until) when = { label: 'Open until', t: dateOfDue(st.until) };

  // Values: what the step captured, per run when the history has it (else the field's value now).
  const strikeOf = (u: string | null) => (u ? v.unds.find((x) => x.symbol === u)?.strike : v.unds[0]?.strike) ?? null;
  const last = runs[runs.length - 1];
  let m: RegExpExecArray | null = /^(?:S_Due|GW_Funded|Task_Missed|Recv_Grace|GW_Cured|Task_Pay|Task_Fund)(\d+)/.exec(
    el.id,
  );
  const period = m ? Number(m[1]) : null;
  const p = v.params;
  if (st)
    for (const c of st.captures) {
      const f = def.fields[c.field];
      if (!f) continue;
      const shared = (captureOwners.get(c.field) ?? 0) > 1;
      // A value several steps write (each period's "due") is only this step's when this step's run wrote it.
      const val = last?.values[c.field] ?? (shared ? undefined : s.values[c.field]);
      if (shared && !val && period !== null) continue; // the payment schedule below says it for this period
      add(fieldLabel(f.name), fieldValue(f.name, f.kind, val, sym, strikeOf));
    }

  // Stock products: the checks and payments behind the step, from the note's view.
  const barrier = (k: number, level: number | undefined, what: string) => {
    if (level === undefined) return;
    const perf = v.perfs[k - 1];
    const label = v.unds.length > 1 ? `Worst performance at observation ${k}` : `Level at observation ${k}`;
    if (perf === undefined) add(`${what}`, `${level}% of strike · observed level not yet reported`);
    else {
      const met = perf * 100 >= level;
      add(label, fmtPct(perf));
      add(what, `${level}% of strike: ${met ? 'met' : 'not met'}`, met ? 'good' : 'bad');
    }
  };
  if ((m = /^GW_Coupon(\d+)$/.exec(el.id))) barrier(Number(m[1]), p.couponBarrierPct, 'Coupon barrier');
  if ((m = /^GW_Autocall(\d+)$/.exec(el.id))) barrier(Number(m[1]), p.autocallLevelPct, 'Autocall level');
  if (el.id === 'GW_FinalAutocall') barrier(p.observations, p.autocallLevelPct, 'Autocall level');
  if (el.id === 'GW_KnockIn') barrier(p.observations, p.knockInBarrierPct, 'Knock-in barrier');
  if (/^Task_Coupon(On|Off)\d+$/.test(el.id) && p.couponRatePct) add('Coupon rate', `${p.couponRatePct}% per period`);
  if (el.id === 'Task_Subscribe') {
    add('Subscribed so far', `${fmtMoney(v.sold, 0)} of ${fmtMoney(v.notional, 0)} units`);
    add('Price per unit', `${p.issuePricePct}% of face (1 unit = 1 ${sym} of face)`);
  }
  if ((m = /^Task_Observe(\d+)$/.exec(el.id))) {
    const k = Number(m[1]);
    if (v.obsDates[k - 1]) when = { label: 'Observed on', t: v.obsDates[k - 1] };
    for (const u of v.unds) if (u.strike !== null) add(`${u.symbol} strike`, fmtPrice(u.strike));
  }
  const eco = v.economics;
  if (period !== null && eco) {
    const pp = eco.periods[period - 1];
    if (pp) {
      if (!/^Task_Fund/.test(el.id) || !when) when = { label: 'Payment date', t: pp.payDate };
      add(
        `Payment ${period}`,
        PERIOD_STATUS[pp.status],
        pp.status === 'paid' ? 'good' : pp.status === 'missed' ? 'bad' : undefined,
      );
      if (pp.perUnit !== null) add('Per unit', `${pp.perUnit.toFixed(4)} ${sym}`);
      if (pp.total !== null) add('In total', `${fmtMoney(pp.total)} ${sym}`);
      if (pp.deliver) add('Delivered per unit', `${pp.deliver.perUnit.toFixed(6)} ${pp.deliver.symbol}`);
      add('Grace ends', fmtDate(pp.graceEnd));
    }
  }
  if (
    eco &&
    /^(Task_ApproveTerms|GW_Margin\d+|Task_MarginCall\d+|Recv_MarginCure\d+|GW_MarginCured\d+|Task_MarginCured\d+|Task_TopUp_.+|Task_Release|Task_Default|Part_Escrow)$/.test(
      el.id,
    )
  ) {
    for (const c of eco.collateral)
      add(
        `${c.symbol} in escrow`,
        `${c.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}${c.value !== null ? ` · worth ${fmtMoney(c.value)} ${sym} after haircut` : ''}`,
      );
    if (eco.required !== null && eco.coverage !== null) {
      const ok = eco.coverage >= eco.required;
      add(
        'Coverage',
        `${fmtMoney(eco.coverage)} of ${fmtMoney(eco.required)} ${sym} needed`,
        /^GW_Margin\d+$/.test(el.id) ? (ok ? 'good' : 'bad') : undefined,
      );
    }
  }
  // Dedupe (a capture and the view can say the same thing).
  const seen = new Set<string>();
  const uniq = facts.filter((f) => {
    const k = `${f.label}|${f.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    title,
    kind: kindLabel(kind, el.type),
    plain: plainOf(
      el.id,
      kind,
      el.type,
      v.params,
      v.unds.map((u) => u.symbol),
      sym,
    ),
    who,
    status,
    statusText,
    when: when && when.t ? when : undefined,
    runs: runs.map((r) => ({ at: r.at, tx: r.tx })),
    facts: uniq,
    moves: i >= 0 ? [...new Set(movesOf(def, i))] : [],
    branches: el.branches,
  };
}

/** Every step that has run, by id: to mark the path taken on the diagram. */
export function ranSteps(def: WorkflowDef, s: NoteState, runs: Map<number, StepRun[]>): string[] {
  const ids = new Set<string>();
  for (const i of runs.keys()) if (def.steps[i]) ids.add(def.steps[i].id);
  for (const m of s.milestones ?? []) if (def.steps[m.step]) ids.add(def.steps[m.step].id);
  return [...ids];
}

const KIND_OF_TYPE: Record<string, number> = {
  'bpmn:StartEvent': KIND.START,
  'bpmn:EndEvent': KIND.END,
  'bpmn:UserTask': KIND.USER,
  'bpmn:ServiceTask': KIND.SERVICE,
  'bpmn:Task': KIND.SERVICE,
  'bpmn:SendTask': KIND.SERVICE,
  'bpmn:ReceiveTask': KIND.RECEIVE,
  'bpmn:ExclusiveGateway': KIND.XOR,
  'bpmn:ParallelGateway': KIND.AND,
  'bpmn:IntermediateCatchEvent': KIND.CATCH,
};

/**
 * A step of a workflow that is not issued yet (the review step, an AI draft, a saved custom workflow): what it does
 * and who acts, from the diagram and the term sheet. No values: nothing has run.
 */
export function previewFacts(el: DiagramElement, p: ProductParams | null, sym = 'USDG'): StepFacts {
  const kind = KIND_OF_TYPE[el.type] ?? null;
  const pool = el.pool ?? '';
  const who =
    el.type === 'bpmn:Participant'
      ? el.name
      : kind === KIND.USER
        ? `The ${pool || 'role'} in this lane, by signing a transaction`
        : kind === KIND.START || kind === KIND.END
          ? `The ${pool || 'role'}'s part of the note`
          : `Automatic: the engine runs it${pool ? ` for the ${pool}` : ''}`;
  return {
    title: el.name || el.id,
    kind: kindLabel(kind, el.type),
    plain: plainOf(
      el.id,
      kind,
      el.type,
      p ?? {},
      (p?.underlyings ?? []).map((u) => u.symbol),
      sym,
    ),
    who,
    status: null,
    statusText: '',
    runs: [],
    facts: [],
    moves: [],
    branches: el.branches,
  };
}

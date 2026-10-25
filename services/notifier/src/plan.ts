/**
 * What to email about one note, now: pure planning from the note's definition, state, view and events.
 *
 * Sources of notifications:
 *  - the BPMN's declarations (core notify.ts, compiled into the definition's META): a step that starts WAITING
 *    (with reminders before its deadline), a step DONE, a gateway or end event ENTERED;
 *  - for definitions that declare none (notes issued before notifications existed): core's
 *    productNotifications, keyed by step id, so the payment cycle is still covered;
 *  - two built-ins: the issuer's "your note is live" (once, while the book is open) and every subscriber's
 *    "you subscribed to N units".
 *
 * Every planned email has a dedupe key (note, step, trigger, occurrence, recipient), so planning again (every
 * tick, after a restart, on a replayed event) never queues the same email twice. No I/O here: the caller loads
 * the inputs and stores the result (tick.ts), so this runs the same in Node and in a Worker cron.
 */
import { productNotifications, type NotifyCategory, type NotifyDecl, type WorkflowDef } from '@sn/core';
import { TAG, type NoteState, type NoteView } from '@sn/sdk';
import type { Vars } from './templates';

export interface NoteEvent {
  seq: number;
  tx: string;
  ts: number;
  name: string;
  data: Record<string, unknown>;
}

export interface PlanInput {
  noteId: string;
  /** Chain name for people, e.g. "Robinhood Chain testnet". */
  chainLabel: string;
  /** The note's page in the app. */
  link: string;
  def: WorkflowDef;
  state: NoteState;
  view: NoteView;
  /** The note's events in order. */
  events: NoteEvent[];
  now: number;
  /** Ignore events older than this (seconds): a newly verified email is not sent a note's whole history. */
  maxEventAge?: number;
}

export interface Planned {
  dedupe: string;
  address: string;
  /** A preference category, or 'account' for receipts of the person's own actions (issue, subscribe). */
  category: NotifyCategory | 'account';
  template?: string;
  subject?: string;
  body?: string;
  vars: Vars;
  sendAfter: number;
  expiresAt: number | null;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const SCALE = 1e10;
const DAY = 86_400;

/** The definition's declarations by step id, or the product defaults when it declares none. */
export function declarations(def: WorkflowDef): (stepId: string) => NotifyDecl[] {
  let declared: Record<string, NotifyDecl[]> | null = null;
  try {
    declared = (JSON.parse(def.meta) as { notify?: Record<string, NotifyDecl[]> }).notify ?? null;
  } catch {
    /* none */
  }
  return declared ? (id: string) => declared![id] ?? [] : (id: string) => productNotifications(id) ?? [];
}

/** "Sat 25 Oct 2026, 13:29 UTC" */
export function when(unix: number): string {
  if (!unix) return 'soon';
  const d = new Date(unix * 1000);
  const wd = d.toLocaleString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const day = d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const hm = d.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${wd} ${day}, ${hm} UTC`;
}

const duration = (s: number) =>
  s >= DAY
    ? `${+(s / DAY).toFixed(1)} day${s === DAY ? '' : 's'}`
    : s >= 3600
      ? `${+(s / 3600).toFixed(1)} hours`
      : `${Math.round(s / 60)} minutes`;

/** A ledger asset's symbol for people: the stablecoin is USD; tokens drop the "Collateral"/"Deliver" prefix. */
export function assetLabel(name: string): string {
  if (/^(USDG|USDC|cash)$/i.test(name)) return 'USD';
  const m = /t?([A-Z]{2,6})$/.exec(name);
  return m ? `t${m[1]}` : name;
}

export function money(amount: number, label: string): string {
  if (label === 'USD')
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${label}`;
}

/**
 * Balance changes per owner and asset made by one transaction (engine fixed point): HoldingChanged, plus the
 * payouts a DistributionRecorded credits every holder (FlowEngine v4 pays holders through an accumulator, so a
 * coupon logs one event, not one balance per holder; pushes and withdrawals then log the balances).
 */
export function txDeltas(events: NoteEvent[], tx: string): Map<string, Map<number, number>> {
  const bal = new Map<string, number>();
  const before = new Map<string, number>();
  const out = new Map<string, Map<number, number>>();
  const set = (inTx: boolean, owner: string, asset: number, v: number) => {
    const key = `${owner}|${asset}`;
    if (inTx && !before.has(key)) before.set(key, bal.get(key) ?? 0);
    if (inTx) {
      const m = out.get(owner) ?? new Map<number, number>();
      m.set(asset, v - (before.get(key) ?? 0));
      out.set(owner, m);
    }
    bal.set(key, v);
  };
  for (const e of events) {
    const inTx = e.tx === tx;
    if (e.name === 'HoldingChanged') {
      set(
        inTx,
        String(e.data.owner).toLowerCase(),
        Number(e.data.asset),
        Number(BigInt(String(e.data.balance))) / SCALE,
      );
    } else if (e.name === 'DistributionRecorded' && BigInt(String(e.data.supply ?? '0')) > 0n) {
      const holding = Number(e.data.holding),
        asset = Number(e.data.asset),
        payer = String(e.data.payer).toLowerCase();
      const perUnit = Number(BigInt(String(e.data.perUnit))) / SCALE;
      for (const [key, units] of [...bal]) {
        const [owner, a] = key.split('|');
        if (Number(a) !== holding || owner === payer || units <= 0) continue;
        set(inTx, owner, asset, (bal.get(`${owner}|${asset}`) ?? 0) + units * perUnit);
      }
      if (e.data.retire)
        for (const key of [...bal.keys()]) if (key.endsWith(`|${holding}`)) set(inTx, key.split('|')[0], holding, 0);
    }
  }
  return out;
}

function roleAddress(def: WorkflowDef, s: NoteState, name: string): string | null {
  const i = def.roles.indexOf(name);
  const a = i >= 0 ? s.roles[i]?.toLowerCase() : null;
  return a && a !== ZERO ? a : null;
}

export function planNote(p: PlanInput): Planned[] {
  const { def, state: s, view: v, now } = p;
  const out: Planned[] = [];
  const decls = declarations(def);
  const issuer = (roleAddress(def, s, 'Issuer') ?? v.issuer ?? s.creator).toLowerCase();
  const escrowIdx = def.roleFlags?.findIndex((f) => (f & 1) === 1) ?? -1;
  const escrow = escrowIdx >= 0 ? s.roles[escrowIdx]?.toLowerCase() : undefined;
  const noteAsset = 0;
  const base: Vars = { note: v.name || def.name, link: p.link, chain: p.chainLabel };
  const econ = v.economics;
  // Only events from the last few hours: emails go out within a minute or two of an event, and an old event that
  // reappears (an indexer that rewound and re-inserted it) must not send again.
  const minTs = now - (p.maxEventAge ?? 3 * 3600);

  const everHeld = new Set<string>();
  for (const e of p.events)
    if (e.name === 'HoldingChanged' && Number(e.data.asset) === noteAsset && BigInt(String(e.data.balance)) > 0n)
      everHeld.add(String(e.data.owner).toLowerCase());
  const currentHolders = s.holdings
    .filter((h) => h.asset === noteAsset && BigInt(h.balance) > 0n)
    .map((h) => h.owner.toLowerCase())
    .filter((a) => a !== escrow);
  const subscribers = [...everHeld].filter((a) => a !== escrow && a !== issuer);

  const field = (name: string): number | null => {
    const i = def.fields.findIndex((f) => f.name === name);
    const val = i >= 0 ? s.values[i] : undefined;
    return val && val.tag === TAG.NUMBER ? Number(BigInt(val.value)) : null;
  };
  const periodOf = (stepId: string) => {
    const m = /(\d+)/.exec(stepId);
    return m ? Number(m[1]) : null;
  };
  const schedule = () =>
    (econ?.periods ?? v.obsDates.map((d, i) => ({ k: i + 1, obsDate: d, payDate: 0, graceEnd: 0 })))
      .map(
        (x) =>
          `  ${x.k}. Observation ${when(x.obsDate)}${x.payDate ? ` · payment date ${when(x.payDate)} · grace until ${when(x.graceEnd)}` : ''}`,
      )
      .join('\n');
  const collateralText = () => {
    if (!econ) return 'none';
    const lines = econ.collateral
      .map((c) => `${c.symbol === 'USD' ? 'USD' : `t${c.symbol}`} (${Math.round(c.haircut * 100)}% counted)`)
      .join(', ');
    return `${econ.ratio !== null ? `${Math.round(econ.ratio * 100)}% of units sold` : 'as pledged'}${lines ? `, in ${lines}` : ''}; grace period ${duration(econ.grace)}`;
  };
  const amountsFor = (deltas: Map<number, number> | undefined) => {
    const parts: string[] = [];
    for (const [asset, d] of deltas ?? [])
      if (asset !== noteAsset && d > 1e-9) parts.push(money(d, assetLabel(def.assets[asset]?.name ?? '')));
    return parts.join(' + ');
  };
  const push = (pl: Planned) => out.push(pl);

  // ---- Built-in: the issuer's "your note is live", while the book is open.
  if (v.phase === 'book' && issuer) {
    push({
      dedupe: `${p.noteId}|issued|${issuer}`,
      address: issuer,
      category: 'account',
      template: 'issued',
      vars: { ...base, schedule: schedule(), collateral: collateralText() },
      sendAfter: now,
      expiresAt: v.strikeDate || null,
    });
  }

  for (const e of p.events) {
    if (e.name !== 'StepRun' || e.ts < minTs) continue;
    const idx = Number(e.data.step);
    const st = def.steps[idx];
    if (!st) continue;
    const actor = String(e.data.actor ?? ZERO).toLowerCase();

    // ---- Built-in: a subscriber's receipt (a person acting in an OPEN role and receiving note units).
    const open = (s.roles[st.role] ?? ZERO).toLowerCase() === ZERO;
    if (open && actor !== ZERO) {
      const got = txDeltas(p.events, e.tx).get(actor)?.get(noteAsset) ?? 0;
      if (got > 0) {
        push({
          dedupe: `${p.noteId}|subscribed|${e.tx}|${actor}`,
          address: actor,
          category: 'account',
          template: 'subscribed',
          vars: {
            ...base,
            units: got.toLocaleString('en-US', { maximumFractionDigits: 4 }),
            schedule: schedule(),
            protection: econ
              ? `the issuer pledged collateral of ${collateralText()}. If they miss a payment past its grace period, holders take ${econ.defaultRule === 'cap-at-owed' ? 'what they are owed (the missed payment plus par)' : 'all of it, pro rata'} from the collateral.`
              : 'none declared',
          },
          sendAfter: now,
          expiresAt: now + 3 * DAY,
        });
      }
    }

    // ---- Declared: done (any step) and enter (gateways and end events).
    decls(st.id).forEach((d, di) => {
      if (d.on === 'waiting') return;
      const deltas = txDeltas(p.events, e.tx);
      const k = periodOf(st.id);
      const targets: Array<{ address: string; vars: Vars }> = [];
      if (d.audience === 'issuer') targets.push({ address: issuer, vars: { amount: amountsFor(deltas.get(issuer)) } });
      else if (d.audience === 'holders') {
        const paid = [...deltas.keys()].filter((a) => a !== escrow && a !== issuer && amountsFor(deltas.get(a)));
        for (const a of paid.length ? paid : currentHolders.filter((x) => x !== issuer))
          targets.push({ address: a, vars: { amount: amountsFor(deltas.get(a)) } });
      } else if (d.audience === 'subscribers') for (const a of subscribers) targets.push({ address: a, vars: {} });
      else if (d.audience.startsWith('role:')) {
        const a = roleAddress(def, s, d.audience.slice(5));
        if (a) targets.push({ address: a, vars: {} });
      }
      for (const t of targets) {
        if (!t.address || t.address === ZERO) continue;
        push({
          dedupe: `${p.noteId}|${st.id}|${d.on}|${e.tx}|${di}|${t.address}`,
          address: t.address,
          category: d.category,
          template: d.template,
          subject: d.subject,
          body: d.body,
          vars: { ...base, period: k ? String(k) : '', ...t.vars },
          sendAfter: now,
          expiresAt: now + 3 * DAY,
        });
      }
    });
  }

  // ---- Declared: waiting (a step holding a token now), with reminders before its deadline.
  for (const i of s.tokens) {
    const st = def.steps[i];
    if (!st) continue;
    const ds = decls(st.id).filter((d) => d.on === 'waiting');
    if (!ds.length) continue;
    const k = periodOf(st.id);
    const period = k && econ ? econ.periods[k - 1] : undefined;
    let deadline: number | null = null,
      graceEnds: number | null = null,
      amount = '',
      coverage = '';
    if (/^Task_Fund\d+$/.test(st.id)) {
      // A funding window is open from issuance; it only becomes a call once the observation fixes an amount.
      if (!period || period.status !== 'due' || !period.total) continue;
      if (econ?.nextCall?.period === k && econ.nextCall.funded) continue;
      deadline = period.payDate;
      graceEnds = period.graceEnd;
      amount = money(period.total, 'USD');
    } else if (/^Recv_Grace\d+/.test(st.id)) {
      deadline = period?.graceEnd ?? null;
      graceEnds = deadline;
      amount = period?.total ? money(period.total, 'USD') : '';
    } else if (/^Recv_MarginCure\d+$/.test(st.id)) {
      deadline = econ?.marginCall?.deadline ?? null;
      coverage =
        econ?.coveragePct !== null && econ?.coveragePct !== undefined
          ? `${Math.round(econ.coveragePct * 100)}%`
          : 'less than required';
    } else if (st.until) {
      deadline = st.until.kind === 0 ? Number(st.until.at) : field(def.fields[st.until.field]?.name ?? '');
    }
    // Too late to act on: for a payment, only once its grace period ends (the issuer can still fund in grace, and a
    // short schedule can pass the payment date before the observation is even indexed).
    const cutoff = /^Task_Fund\d+$/.test(st.id) && graceEnds !== null ? graceEnds : deadline;
    if (cutoff !== null && now >= cutoff) continue;
    ds.forEach((d, di) => {
      const addrs =
        d.audience === 'issuer'
          ? [issuer]
          : d.audience === 'holders'
            ? currentHolders
            : d.audience === 'subscribers'
              ? subscribers
              : d.audience.startsWith('role:')
                ? [roleAddress(def, s, d.audience.slice(5))].filter((x): x is string => !!x)
                : [];
      const vars: Vars = {
        ...base,
        period: k ? String(k) : '',
        amount,
        coverage,
        deadline: deadline ? when(deadline) : '',
        graceEnds: graceEnds ? when(graceEnds) : '',
      };
      for (const a of addrs) {
        if (!a || a === ZERO) continue;
        const key = `${p.noteId}|${st.id}|waiting|${di}|${a}`;
        const late = deadline !== null && now >= deadline && d.template === 'payment-due';
        // Past the payment date but still in grace: the missed-payment wording ("you can still fund it until …").
        if (late)
          push({
            dedupe: `${key}|grace`,
            address: a,
            category: d.category,
            template: 'payment-missed',
            vars,
            sendAfter: now,
            expiresAt: cutoff,
          });
        else
          push({
            dedupe: key,
            address: a,
            category: d.category,
            template: d.template,
            subject: d.subject,
            body: d.body,
            vars,
            sendAfter: now,
            expiresAt: deadline,
          });
        for (const off of d.remind ?? []) {
          if (deadline === null) break;
          const at = deadline - off;
          if (at <= now + 60) continue; // already that close: the waiting email itself covers it
          push({
            dedupe: `${key}|remind-${off}`,
            address: a,
            category: d.category,
            template: d.template,
            subject: d.subject ?? undefined,
            body: d.body,
            vars: { ...vars, reminder: '1' },
            sendAfter: at,
            expiresAt: deadline,
          });
        }
      }
    });
  }
  return out;
}

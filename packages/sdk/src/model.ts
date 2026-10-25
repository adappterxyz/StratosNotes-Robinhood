/**
 * The chain-neutral read model: what a note is, whatever chain runs it. The indexer stores it, the API serves
 * it, the app renders it, and every chain adapter produces it.
 *
 * A note's id is `<chain>:<engine>:<pid>`:
 *  - chain: a chain key from CHAINS (e.g. `arbitrum-sepolia`);
 *  - engine: the contract (EVM, lower-case 0x address) or package/party that runs it;
 *  - pid: the process id inside that engine.
 *
 * `noteView` turns a definition plus a note's state into what people read: terms, book, strikes, observations,
 * phase, the payoff so far. It is pure and runs in the indexer (for filter columns), the API (per request,
 * since the phase depends on the time) and the app.
 */
import {
  CASH_TOKENS,
  collateralSymbolOfAsset,
  MILESTONE_NAMES,
  MILESTONES,
  normalizeParams,
  PRODUCT_LABELS,
  SCALE,
  simulateNote,
  simulatePerf,
  totalPerUnit,
  underlyingLabel,
  type Milestone,
  type ProductParams,
  type WorkflowDef,
} from '@sn/core';

export type ChainFamily = 'evm';

export interface ChainInfo {
  key: string;
  family: ChainFamily;
  name: string;
  chainId?: number;
  testnet: boolean;
  explorer?: string;
  /** The stablecoin notes settle in on this chain (EVM: an ERC-20 address), when known. */
  stablecoin?: { symbol: string; address?: string; decimals: number };
  /** Whether Chainlink CRE can write reports here (else a note's reports come from the fallback keeper). */
  cre: boolean;
}

/** Known chains. RPCs and engine addresses come from deployment config, not from here. */
export const CHAINS: Record<string, ChainInfo> = {
  'arbitrum-sepolia': {
    key: 'arbitrum-sepolia',
    family: 'evm',
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    testnet: true,
    explorer: 'https://sepolia.arbiscan.io',
    cre: true,
    stablecoin: { symbol: 'USDG', address: CASH_TOKENS['arbitrum-sepolia'], decimals: 6 },
  },
  'robinhood-testnet': {
    key: 'robinhood-testnet',
    family: 'evm',
    name: 'Robinhood Chain testnet',
    chainId: 46630,
    testnet: true,
    explorer: 'https://explorer.testnet.chain.robinhood.com',
    cre: true,
    stablecoin: { symbol: 'USDG', address: CASH_TOKENS['robinhood-testnet'], decimals: 6 },
  },
  // Config only (no deployment yet): mainnet settlement in real stablecoins.
  'arbitrum-one': {
    key: 'arbitrum-one',
    family: 'evm',
    name: 'Arbitrum One',
    chainId: 42161,
    testnet: false,
    explorer: 'https://arbiscan.io',
    cre: true,
    stablecoin: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  },
  'robinhood-mainnet': {
    key: 'robinhood-mainnet',
    family: 'evm',
    name: 'Robinhood Chain',
    chainId: 4663,
    testnet: false,
    explorer: 'https://robinhoodchain.blockscout.com',
    cre: false,
    stablecoin: { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
  },
  // Local anvil fork of Arbitrum Sepolia (scripts/dev-local.sh): same chain id, local RPC.
  local: {
    key: 'local',
    family: 'evm',
    name: 'Local fork (Arbitrum Sepolia)',
    chainId: 421614,
    testnet: true,
    cre: true,
    stablecoin: { symbol: 'tUSD', decimals: 6 },
  },
};

export type NoteId = string;

export const noteId = (chain: string, engine: string, pid: string | bigint): NoteId =>
  `${chain}:${engine.toLowerCase()}:${pid.toString()}`;

export function parseNoteId(id: string): { chain: string; engine: string; pid: string } | null {
  const m = /^([a-z0-9-]{1,40}):(0x[0-9a-f]{40}|[A-Za-z0-9_.:-]{1,200}):(\d{1,78})$/.exec(id);
  return m ? { chain: m[1], engine: m[2], pid: m[3] } : null;
}

/** Field value tags, as the engine stores them: number (fixed point or integer), text, party. */
export const TAG = { NUMBER: 1, TEXT: 2, PARTY: 3 } as const;

/** A captured field, JSON-safe: numbers as decimal strings (engine fixed point for decimals, plain for dates). */
export type FieldValue = { tag: 1; value: string } | { tag: 2; value: string } | { tag: 3; value: string };

/** One account's balance of one asset in a note, engine fixed point (10 decimals) as a decimal string. */
export interface Holding {
  asset: number;
  owner: string;
  balance: string;
}

export interface ReportStats {
  cre: number;
  fallback: number;
  last: 'cre' | 'fallback' | null;
}

/** A note's state, as the chain holds it (JSON-safe). */
export interface NoteState {
  id: NoteId;
  chain: string;
  engine: string;
  pid: string;
  definition: string;
  creator: string;
  ref: string;
  roles: string[];
  /** EVM: the ERC-20 behind each cash asset (zero address for issued assets). */
  assetTokens: string[];
  status: number;
  tokens: number[];
  stepsRun: number;
  values: Record<number, FieldValue>;
  holdings: Holding[];
  createdAt: number;
  updatedAt: number;
  reports: ReportStats;
  /** Business events in order (FlowEngine Milestone): code (core MILESTONES), the step, the block time. */
  milestones?: Array<{ code: number; step: number; at: number }>;
}

export const NOTE_ASSET = 0;
export const CASH_ASSET = 1;
export const STATUS_COMPLETED = 1;

export type Phase = 'book' | 'fixing' | 'live' | 'redeemed' | 'defaulted';
export const PHASES: Phase[] = ['book', 'fixing', 'live', 'redeemed', 'defaulted'];
export const PHASE_LABEL: Record<Phase, string> = {
  book: 'Book open',
  fixing: 'Fixing strike',
  live: 'Live',
  redeemed: 'Redeemed',
  defaulted: 'Defaulted',
};

export interface UnderlyingState {
  symbol: string;
  feed: string;
  feedChain: string;
  strike: number | null;
  /** Level at each observation so far. */
  observed: number[];
}

/** What people read about a note. */
export interface NoteView {
  id: NoteId;
  chain: string;
  name: string;
  /** The term sheet when the workflow is (or started from) a stock product. */
  params: ProductParams;
  hasTerms: boolean;
  /** Edited in the studio: the payoff is defined by the workflow, not a reference engine. */
  custom: boolean;
  label: string;
  underlyingText: string;
  issuer: string;
  isin: string;
  notional: number;
  sold: number;
  strikeDate: number;
  obsDates: number[];
  unds: UnderlyingState[];
  strikeFixed: boolean;
  /** Worst performance (level / strike) at each completed observation. */
  perfs: number[];
  phase: Phase;
  activeSteps: string[];
  /** Payoff so far along the observed path (null before the strike, or for custom workflows). */
  outcome: { calledAt?: number; finished: boolean; perUnit: number } | null;
  /** Paid out so far per unit (cash distributed to holders, from the ledger). */
  reports: ReportStats;
  /** Collateral, coverage, the issuer's payment schedule and default state (null for workflows without escrow). */
  economics: NoteEconomics | null;
  /** The note's own cash token (asset 1), e.g. USDG, or tUSD for older demo notes. */
  cashToken?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CollateralLine {
  symbol: string;
  asset: number;
  /** In escrow now (token units). */
  amount: number;
  /** Share of value counted (0..1). */
  haircut: number;
  /** Latest price CRE reported (USD: 1); null before the strike. */
  price: number | null;
  /** amount x price x haircut. */
  value: number | null;
}

export type PeriodStatus = 'upcoming' | 'nothing-due' | 'due' | 'paid' | 'grace' | 'missed' | 'cancelled';

/** One period's payment, as the issuer must fund it and holders see it. */
export interface PaymentPeriod {
  k: number;
  obsDate: number;
  /** Payment date: observation + settlement lag. */
  payDate: number;
  /** End of grace: the payment's last moment before default. */
  graceEnd: number;
  /** Cash per unit expected (reference payoff along the observed path; exact once the payment ran). */
  perUnit: number | null;
  /** What the issuer must fund: per unit x units sold (+ fees in custom workflows). */
  total: number | null;
  deliver?: { symbol: string; perUnit: number };
  status: PeriodStatus;
}

export type EconomicState = 'pending' | 'active' | 'margin-call' | 'grace' | 'defaulted' | 'released' | 'cancelled';

export interface NoteEconomics {
  state: EconomicState;
  /** Required coverage as a share of the outstanding notional. */
  ratio: number | null;
  /** Required collateral value: ratio x units sold (stablecoin). */
  required: number | null;
  /** Collateral value now: escrowed amounts x latest prices x haircuts. */
  coverage: number | null;
  /** coverage / required. */
  coveragePct: number | null;
  collateral: CollateralLine[];
  /** Stablecoin the issuer has funded into escrow and not yet paid out. */
  escrowCash: number;
  /** Seconds. */
  lag: number;
  grace: number;
  marginCall: { period: number; deadline: number } | null;
  inGrace: { period: number; deadline: number } | null;
  periods: PaymentPeriod[];
  /** The next funding call: what the issuer must put in escrow, and by when. */
  nextCall: { period: number; total: number; payDate: number; graceEnd: number; funded: boolean } | null;
  milestones: Array<{ name: Milestone; stepId: string; at: number }>;
  /** What a default pays the holders: what they are owed (the rest back to the issuer), or the whole escrow. */
  defaultRule: 'cap-at-owed' | 'all-to-holders';
}

const fixed = (s: string | undefined) => (s === undefined ? NaN : Number(BigInt(s)) / Number(SCALE));

/** A field's value by name: numbers come back as bigint (raw), text and parties as strings; null when unset. */
export function fieldOf(def: WorkflowDef, s: Pick<NoteState, 'values'>, name: string): bigint | string | null {
  const i = def.fields.findIndex((f) => f.name === name);
  const v = i < 0 ? undefined : s.values[i];
  if (!v) return null;
  return v.tag === TAG.NUMBER ? BigInt(v.value) : v.value;
}

export function termsOf(def: WorkflowDef): { params: ProductParams; hasTerms: boolean; custom: boolean } {
  let meta: { product?: ProductParams; custom?: boolean } = {};
  try {
    meta = JSON.parse(def.meta);
  } catch {
    /* a workflow without metadata */
  }
  const hasTerms = !!meta.product;
  const params: ProductParams = meta.product
    ? normalizeParams(meta.product)
    : {
        productType: 'fcn',
        name: def.name || 'Custom workflow',
        issuePricePct: 100,
        underlyings: [],
        observations: def.fields.filter((f) => /^obsDate\d+$/.test(f.name)).length,
      };
  return { params, hasTerms, custom: !!meta.custom || !hasTerms };
}

/**
 * The book: a window (a step with `until`) of an open role (anyone may act: its holder is the zero address),
 * holding a token. The issuer's funding and top-up windows are windows too, but of a held role.
 */
export const isBookStep = (def: WorkflowDef, s: Pick<NoteState, 'tokens' | 'roles'>, i: number) => {
  const st = def.steps[i];
  return !!st?.until && s.tokens.includes(i) && /^0x0{40}$/i.test(s.roles[st.role] ?? '');
};
/** Is the book (subscription window) open? */
export const windowOpen = (def: WorkflowDef, s: Pick<NoteState, 'tokens' | 'roles'>) =>
  def.steps.some((_, i) => isBookStep(def, s, i));

export function noteView(def: WorkflowDef, s: NoteState, now = Date.now() / 1000): NoteView {
  const { params, hasTerms, custom } = termsOf(def);
  const num = (name: string) => {
    const v = fieldOf(def, s, name);
    return typeof v === 'bigint' ? Number(v) / Number(SCALE) : NaN;
  };
  const int = (name: string) => {
    const v = fieldOf(def, s, name);
    return typeof v === 'bigint' ? Number(v) : 0;
  };
  const notional = num('notional');
  const strikeDate = int('strikeDate');
  const obsDates = Array.from({ length: params.observations }, (_, k) => int(`obsDate${k + 1}`));

  // One underlying: initialLevel / obsK. A worst-of basket: initialLevel_SYM / obsK_SYM.
  const basket = params.underlyings.length > 1;
  const unds: UnderlyingState[] = params.underlyings.map((u) => {
    const strike = fieldOf(def, s, basket ? `initialLevel_${u.symbol}` : 'initialLevel');
    const observed: number[] = [];
    for (let k = 1; k <= params.observations; k++) {
      const v = fieldOf(def, s, basket ? `obs${k}_${u.symbol}` : `obs${k}`);
      if (typeof v !== 'bigint') break;
      observed.push(Number(v) / Number(SCALE));
    }
    return {
      symbol: u.symbol,
      feed: u.feed,
      feedChain: u.feedChain,
      strike: typeof strike === 'bigint' ? Number(strike) / Number(SCALE) : null,
      observed,
    };
  });
  const strikeFixed = unds.length > 0 && unds.every((u) => u.strike !== null);
  const nObs = unds.length ? Math.min(...unds.map((u) => u.observed.length)) : 0;
  const perfs = strikeFixed
    ? Array.from({ length: nObs }, (_, k) => Math.min(...unds.map((u) => u.observed[k] / u.strike!)))
    : [];

  const issuer = s.roles[0] ?? s.creator;
  const units = (owner: string) =>
    fixed(s.holdings.find((h) => h.asset === NOTE_ASSET && h.owner.toLowerCase() === owner.toLowerCase())?.balance);
  const issued = notional > 0 && s.holdings.some((h) => h.asset === NOTE_ASSET);
  const issuerUnits = units(issuer);
  const sold = issued ? notional - (Number.isFinite(issuerUnits) ? issuerUnits : 0) : 0;
  const activeSteps = [...new Set(s.tokens.map((t) => def.steps[t]?.id).filter(Boolean))] as string[];
  const phase: Phase =
    s.status === STATUS_COMPLETED
      ? 'redeemed'
      : windowOpen(def, s) && (strikeDate ? now < strikeDate : true)
        ? 'book'
        : unds.length && !strikeFixed
          ? 'fixing'
          : 'live';

  let outcome: NoteView['outcome'] = null;
  if (!custom && strikeFixed && perfs.length) {
    const path = [...perfs, ...new Array(params.observations - perfs.length).fill(perfs[perfs.length - 1])];
    const r = simulatePerf(params, path);
    outcome = {
      calledAt: r.calledAt && r.calledAt <= perfs.length ? r.calledAt : undefined,
      finished: s.status === STATUS_COMPLETED,
      perUnit: totalPerUnit(r),
    };
  }
  const label = hasTerms
    ? custom
      ? `Custom ${PRODUCT_LABELS[params.productType]}`
      : PRODUCT_LABELS[params.productType]
    : 'Custom workflow';
  const isin = fieldOf(def, s, 'isin');
  const economics = economicsView(def, s, params, hasTerms && !custom, perfs, unds, now);
  // With an issuer in the loop, "paid so far" is what the paid periods paid, not the payoff projected forward.
  if (outcome && economics)
    outcome.perUnit = economics.periods.reduce((a, p) => a + (p.status === 'paid' ? (p.perUnit ?? 0) : 0), 0);
  const sold2 = num('sold');
  const soldNow = Number.isFinite(sold2) ? sold2 : sold;
  const finalPhase: Phase = economics?.state === 'defaulted' ? 'defaulted' : phase;
  return {
    id: s.id,
    chain: s.chain,
    name: params.name || def.name,
    params,
    hasTerms,
    custom,
    label,
    underlyingText: hasTerms ? underlyingLabel(params) : '—',
    issuer,
    isin: typeof isin === 'string' ? isin : '',
    notional: Number.isFinite(notional) ? notional : 0,
    sold: soldNow,
    strikeDate,
    obsDates,
    unds,
    strikeFixed,
    perfs,
    phase: finalPhase,
    activeSteps,
    outcome,
    reports: s.reports,
    economics,
    cashToken: s.assetTokens?.[CASH_ASSET],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** "Collateral WETH" -> ETH, "Collateral TSLA.rh" -> TSLA, "Collateral USDG" / "Collateral tUSD" -> USD (older notes' "Collateral tETH" -> ETH). */
const collateralSymbol = collateralSymbolOfAsset;
/** The cash asset's name: USDG for new notes, USDC for notes issued before USDG. */
const isCashName = (name: string) => name === 'USDG' || name === 'USDC';

/**
 * The note's economics from its state: collateral in escrow and its coverage, the payment schedule with each
 * period's status, and whether the note is in a margin call, a grace period, defaulted or released.
 */
export function economicsView(
  def: WorkflowDef,
  s: NoteState,
  params: ProductParams,
  reference: boolean,
  perfs: number[],
  unds: UnderlyingState[],
  _now: number,
): NoteEconomics | null {
  const escrowRole = def.roleFlags?.findIndex((f) => (f & 1) === 1) ?? -1;
  if (escrowRole < 0) return null;
  const escrow = s.roles[escrowRole]?.toLowerCase();
  const bal = (asset: number) => fixed(s.holdings.find((h) => h.asset === asset && h.owner === escrow)?.balance ?? '0');
  const num = (name: string) => {
    const v = fieldOf(def, s, name);
    return typeof v === 'bigint' ? Number(v) / Number(SCALE) : null;
  };
  const int = (name: string) => {
    const v = fieldOf(def, s, name);
    return typeof v === 'bigint' ? Number(v) : null;
  };
  const stepId = (i: number) => def.steps[i]?.id ?? '';
  const at = (prefix: string) => s.tokens.map(stepId).find((id) => id.startsWith(prefix));
  const milestones = (s.milestones ?? []).map((m) => ({
    name: MILESTONE_NAMES[m.code],
    stepId: stepId(m.step),
    at: m.at,
  }));
  const has = (name: Milestone) => milestones.some((m) => m.name === name);

  const collateral: CollateralLine[] = def.assets.flatMap((a, i) => {
    const symbol = collateralSymbol(a.name);
    if (!symbol) return [];
    const haircut = num(`haircut_${symbol}`) ?? 0;
    const price = symbol === 'USD' ? 1 : num(`px_${symbol}`);
    const amount = bal(i);
    return [{ symbol, asset: i, amount, haircut, price, value: price === null ? null : amount * price * haircut }];
  });
  const ratio = num('collateralRatio');
  const sold = num('sold');
  const required = num('required') ?? (ratio !== null && sold !== null ? ratio * sold : null);
  const coverage = collateral.every((c) => c.value !== null)
    ? collateral.reduce((a, c) => a + (c.value ?? 0), 0)
    : null;
  const lag = int('lag') ?? 0,
    grace = int('grace') ?? 0;
  const cashAsset = def.assets.findIndex((a) => isCashName(a.name));
  const escrowCash = cashAsset >= 0 ? bal(cashAsset) : 0;

  // What each period owes: the reference payoff along the observed path (the engine's own numbers once paid).
  const n = params.observations;
  let calls: ReturnType<typeof simulateNote>['calls'] = [];
  if (reference && perfs.length && sold) {
    const path = [...perfs, ...new Array(Math.max(0, n - perfs.length)).fill(perfs[perfs.length - 1])];
    const worst = unds.length
      ? unds.reduce(
          (w, u, i) =>
            (u.observed[n - 1] ?? Infinity) / (u.strike ?? 1) <
            (unds[w].observed[n - 1] ?? Infinity) / (unds[w].strike ?? 1)
              ? i
              : w,
          0,
        )
      : 0;
    calls = simulateNote(params, {
      perfs: path,
      sold,
      ratio: 0,
      collateral: [], // the schedule only: collateral is read from the chain
      worstAtMaturity:
        params.settlement === 'physical' && unds[worst]?.strike
          ? { symbol: unds[worst].symbol, strike: unds[worst].strike! }
          : undefined,
    }).calls;
  }
  const defaulted = has('defaulted');
  const released = has('collateral-released');
  const periods: PaymentPeriod[] = Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    const obsDate = int(`obsDate${k}`) ?? 0;
    const payDate = obsDate + lag,
      graceEnd = payDate + grace;
    const observed = !!unds.length && unds.every((u) => u.observed.length >= k);
    const call = calls.find((c) => c.period === k);
    const paid = milestones.some((m) => m.name === 'payment-made' && new RegExp(`^Task_Pay${k}(\\D|$)`).test(m.stepId));
    const missed = milestones.some(
      (m) => m.name === 'payment-missed' && new RegExp(`^Task_Missed${k}(\\D|$)`).test(m.stepId),
    );
    let status: PeriodStatus;
    if (paid) status = 'paid';
    else if (at(`Recv_Grace${k}`)) status = 'grace';
    else if (missed && defaulted) status = 'missed';
    else if (defaulted || (released && !observed)) status = 'cancelled';
    else if (!observed) status = 'upcoming';
    else if (at(`S_Due${k}`) || (call && !paid)) status = 'due';
    else status = 'nothing-due';
    return {
      k,
      obsDate,
      payDate,
      graceEnd,
      perUnit: call ? call.perUnit : observed ? 0 : null,
      total: call ? call.total : observed ? 0 : null,
      ...(call?.deliver ? { deliver: call.deliver } : {}),
      status,
    };
  });
  const marginAt = at('Recv_MarginCure');
  const marginPeriod = marginAt ? Number(marginAt.replace('Recv_MarginCure', '')) : null;
  const graceAt = at('Recv_Grace');
  const gracePeriod = graceAt ? Number(/^Recv_Grace(\d+)/.exec(graceAt)![1]) : null;
  const next = periods.find((p) => p.status === 'due' || p.status === 'grace');
  const state: EconomicState = defaulted
    ? 'defaulted'
    : released
      ? sold
        ? 'released'
        : 'cancelled'
      : marginPeriod !== null
        ? 'margin-call'
        : gracePeriod !== null
          ? 'grace'
          : sold === null
            ? 'pending'
            : 'active';
  return {
    state,
    ratio,
    required,
    coverage,
    coveragePct: coverage !== null && required ? coverage / required : null,
    collateral,
    escrowCash,
    lag,
    grace,
    marginCall:
      marginPeriod !== null
        ? {
            period: marginPeriod,
            deadline: (marginPeriod === 0 ? (int('strikeDate') ?? 0) : (int(`obsDate${marginPeriod}`) ?? 0)) + grace,
          }
        : null,
    inGrace: gracePeriod !== null ? { period: gracePeriod, deadline: periods[gracePeriod - 1]?.graceEnd ?? 0 } : null,
    periods,
    nextCall:
      next && next.total !== null
        ? {
            period: next.k,
            total: next.total,
            payDate: next.payDate,
            graceEnd: next.graceEnd,
            funded: escrowCash + 1e-9 >= next.total,
          }
        : null,
    milestones,
    defaultRule: def.fields.some((f) => f.name === 'owed') ? 'cap-at-owed' : 'all-to-holders',
  };
}

/** Steps an issuer acts on during the note's life, by kind (from the workflow's own step ids). */
export function issuerActions(
  def: WorkflowDef,
  s: Pick<NoteState, 'tokens'> & Partial<Pick<NoteState, 'values'>>,
  nowSec?: number,
) {
  // A window whose closing date has passed takes nothing more (the engine refuses it): not an action.
  const closes = (i: number) => {
    const u = def.steps[i].until;
    if (!u) return Infinity;
    if (u.kind === 0) return Number(u.at);
    const v = s.values?.[u.field];
    return v && v.tag === TAG.NUMBER ? Number(BigInt(v.value)) : Infinity;
  };
  const open = (prefix: string) =>
    def.steps
      .map((st, i) => ({ st, i }))
      .filter(
        ({ st, i }) => st.id.startsWith(prefix) && s.tokens.includes(i) && (nowSec === undefined || nowSec < closes(i)),
      );
  return {
    fund: open('Task_Fund')
      .filter(({ st }) => /^Task_Fund\d+$/.test(st.id))
      .map(({ st, i }) => ({ step: i, period: Number(st.id.slice(9)) })),
    topUp: open('Task_TopUp_').map(({ st, i }) => ({ step: i, symbol: st.id.slice(11) })),
    delivery: open('Task_FundDelivery_').map(({ st, i }) => ({ step: i, symbol: st.id.slice(18) })),
  };
}

export { MILESTONES };

/**
 * A holder's position in one note: units held, cash it can withdraw, and every other asset it can withdraw
 * (delivered tokens; collateral received on a default), as numbers for display.
 */
export function positionOf(s: NoteState, owner: string, def?: WorkflowDef) {
  const mine = s.holdings.filter((h) => h.owner.toLowerCase() === owner.toLowerCase());
  const bal = (asset: number) => mine.find((h) => h.asset === asset)?.balance ?? '0';
  const other = mine
    .filter((h) => h.asset > CASH_ASSET && BigInt(h.balance) > 0n)
    .map((h) => ({
      asset: h.asset,
      name: def?.assets[h.asset]?.name ?? `asset ${h.asset}`,
      amount: fixed(h.balance),
      raw: BigInt(h.balance),
    }));
  return { units: fixed(bal(NOTE_ASSET)), cash: fixed(bal(CASH_ASSET)), cashRaw: BigInt(bal(CASH_ASSET)), other };
}

/** One line describing the payoff, from the term sheet. */
export function headline(o: ProductParams) {
  const parts: string[] = [];
  if (o.couponRatePct)
    parts.push(`${o.couponRatePct}% ${o.productType === 'snowball' ? 'accrued' : 'coupon'} / period`);
  if (o.couponBarrierPct) parts.push(`coupon barrier ${o.couponBarrierPct}%${o.memory ? ' (memory)' : ''}`);
  if (o.autocallLevelPct) parts.push(`autocall ${o.autocallLevelPct}%`);
  if (o.knockInBarrierPct) parts.push(`knock-in ${o.knockInBarrierPct}%`);
  if (o.protectionPct) parts.push(`${o.protectionPct}% protected, ${o.participationPct}% participation`);
  if (o.settlement === 'physical') parts.push('physical delivery');
  return parts.join(' · ');
}

/** History: one line per event, chain-neutral. */
export interface HistoryItem {
  seq: number;
  kind:
    'started' | 'step' | 'field' | 'holding' | 'deposit' | 'withdraw' | 'transfer' | 'report' | 'completed' | 'tokens';
  block: number;
  tx: string;
  at: number;
  data: Record<string, unknown>;
}

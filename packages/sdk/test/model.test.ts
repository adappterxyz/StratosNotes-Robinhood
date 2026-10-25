import { describe, expect, it } from 'vitest';
import { compile, dec, EXAMPLE_PRODUCTS, instantiateProduct, MILESTONES, parseBpmn } from '@sn/core';
import {
  applyEvent,
  depositAmounts,
  EvmAdapter,
  issuerActions,
  noteId,
  noteView,
  parseNoteId,
  planIssuance,
  windowOpen,
  type NoteEvent,
  type NoteState,
} from '../src';

const p = EXAMPLE_PRODUCTS.phoenix;
const prod = instantiateProduct(p);
const ir = parseBpmn(prod.bpmnXml, prod.assets);
const c = compile(ir, { product: prod.params });
const field = (n: string) => c.def.fields.findIndex((f) => f.name === n);

describe('note ids', () => {
  it('round-trip and reject junk', () => {
    const id = noteId('robinhood-testnet', '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD', 7n);
    expect(id).toBe('robinhood-testnet:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:7');
    expect(parseNoteId(id)).toEqual({
      chain: 'robinhood-testnet',
      engine: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      pid: '7',
    });
    expect(parseNoteId('x:y')).toBeNull();
    expect(parseNoteId("evm:0x00'; drop table notes;--:1")).toBeNull();
  });
});

describe('issuance plan', () => {
  it('reads the pre-trade steps, open and escrow roles and the collateral pledge from the workflow', () => {
    const plan = planIssuance(ir, c);
    // Check Terms runs by itself after Approve Terms; the funding windows open after issuance.
    expect(plan.steps.map((s) => s.id)).toEqual(['Task_ApproveTerms', 'Task_Mandate']);
    expect(plan.openRoles).toEqual(c.def.roles.map((r) => r === 'Investor'));
    expect(plan.escrowRoles).toEqual(c.def.roles.map((r) => r === 'Escrow'));
    expect(plan.dateFields).toEqual(['strikeDate', 'obsDate1', 'obsDate2', 'obsDate3', 'obsDate4']);
    const terms = plan.steps[0];
    expect(terms.inputs.map((i) => i.name)).toContain('pledge_USD');
    const known = new Map<number, bigint>([
      [field('notional'), dec(1000)],
      [field('pledge_USD'), dec(1000)],
    ]);
    const [d] = depositAmounts(c.def, terms, known);
    expect(d.asset).toBe(c.assetIndex.col_USD);
    expect(d.amount).toBe(dec(1000)); // the pledge, locked in escrow
  });
});

describe('events -> note state', () => {
  const ctx = { chain: 'local', engine: '0x00000000000000000000000000000000000000e1', at: 100 };
  const investor = '0x00000000000000000000000000000000000000a1';
  const events: NoteEvent[] = [
    {
      name: 'ProcessStarted',
      pid: '1',
      definition: '0xd1',
      creator: '0x00000000000000000000000000000000000000b1',
      ref: '1',
      roles: [
        '0x00000000000000000000000000000000000000b1',
        '0x00000000000000000000000000000000000000b1',
        '0x0000000000000000000000000000000000000000',
      ],
      assetTokens: ['0x0000000000000000000000000000000000000000', '0x00000000000000000000000000000000000000c1'],
    },
    { name: 'FieldSet', pid: '1', field: field('notional'), value: { tag: 1, value: dec(1000).toString() } },
    { name: 'FieldSet', pid: '1', field: field('isin'), value: { tag: 2, value: 'XS123' } },
    {
      name: 'HoldingChanged',
      pid: '1',
      asset: 0,
      owner: '0x00000000000000000000000000000000000000b1',
      balance: dec(1000).toString(),
    },
    {
      name: 'HoldingChanged',
      pid: '1',
      asset: 0,
      owner: '0x00000000000000000000000000000000000000b1',
      balance: dec(400).toString(),
    },
    { name: 'HoldingChanged', pid: '1', asset: 0, owner: investor, balance: dec(600).toString() },
    { name: 'TokensUpdated', pid: '1', status: 0, stepsRun: 4, tokens: [c.stepIndex.Task_Subscribe] },
    { name: 'ReportProcessed', pid: '1', step: 3, values: ['1'], reporter: '0xf0', via: 'cre' },
  ];
  it('folds events into the read model, and replaying from scratch gives the same state', () => {
    let s: NoteState | null = null;
    for (const e of events) s = applyEvent(s, e, ctx);
    let again: NoteState | null = null;
    for (const e of events) again = applyEvent(again, e, ctx);
    expect(again).toEqual(s);
    const v = noteView(c.def, s!, 50);
    expect(v.isin).toBe('XS123');
    expect(v.notional).toBe(1000);
    expect(v.sold).toBe(600);
    expect(v.phase).toBe('book');
    expect(v.reports).toEqual({ cre: 1, fallback: 0, last: 'cre' });
    expect(s!.holdings.find((h) => h.owner === investor)?.balance).toBe(dec(600).toString());
  });

  it('reads the economics: collateral in escrow, coverage, the payment schedule and a default', () => {
    const escrow = '0x00000000000000000000000000000000000000e5';
    const roles = [
      '0x00000000000000000000000000000000000000b1',
      '0x00000000000000000000000000000000000000b1',
      '0x0000000000000000000000000000000000000000',
      escrow,
    ];
    const E = (x: number) => dec(x).toString();
    const set = (name: string, value: bigint | number) => ({
      name: 'FieldSet' as const,
      pid: '1',
      field: field(name),
      value: { tag: 1 as const, value: (typeof value === 'bigint' ? value : BigInt(value)).toString() },
    });
    const live: NoteEvent[] = [
      { name: 'ProcessStarted', pid: '1', definition: '0xd1', creator: roles[0], ref: '1', roles, assetTokens: [] },
      set('notional', dec(1000)),
      set('strikeDate', 100),
      set('obsDate1', 200),
      set('obsDate2', 300),
      set('obsDate3', 400),
      set('obsDate4', 500),
      set('lag', 10),
      set('grace', 20),
      set('collateralRatio', dec(1)),
      set('haircut_USD', dec(1)),
      { name: 'HoldingChanged', pid: '1', asset: c.assetIndex.col_USD, owner: escrow, balance: E(1000) },
      set('initialLevel', dec(2000)),
      set('sold', dec(1000)),
      set('required', dec(1000)),
      set('obs1', dec(1600)), // 80%: a 2.5% coupon is due at 1
      { name: 'TokensUpdated', pid: '1', status: 0, stepsRun: 20, tokens: [c.stepIndex.S_Due1] },
    ];
    let s: NoteState | null = null;
    for (const e of live) s = applyEvent(s, e, ctx);
    let v = noteView(c.def, s!, 205);
    expect(v.economics).toMatchObject({
      state: 'active',
      ratio: 1,
      required: 1000,
      coverage: 1000,
      coveragePct: 1,
      escrowCash: 0,
    });
    expect(v.economics!.periods[0]).toMatchObject({
      k: 1,
      payDate: 210,
      graceEnd: 230,
      status: 'due',
      perUnit: 0.025,
      total: 25,
    });
    expect(v.economics!.nextCall).toMatchObject({ period: 1, total: 25, funded: false });
    expect(issuerActions(c.def, { tokens: [c.stepIndex.Task_Fund1, c.stepIndex.Task_TopUp_USD] })).toEqual({
      fund: [{ step: c.stepIndex.Task_Fund1, period: 1 }],
      topUp: [{ step: c.stepIndex.Task_TopUp_USD, symbol: 'USD' }],
      delivery: [],
    });
    // A funding window closed by its date is no longer an action.
    const until = { [field('fundUntil1')]: { tag: 1, value: '230' } } as NoteState['values'];
    expect(issuerActions(c.def, { tokens: [c.stepIndex.Task_Fund1], values: until }, 229).fund).toHaveLength(1);
    expect(issuerActions(c.def, { tokens: [c.stepIndex.Task_Fund1], values: until }, 230).fund).toEqual([]);
    // Missed, grace runs out: the default distributes the escrow.
    for (const e of [
      {
        name: 'Milestone' as const,
        pid: '1',
        code: MILESTONES['payment-missed'],
        step: c.stepIndex.Task_Missed1,
        actor: '0x0',
      },
      {
        name: 'Milestone' as const,
        pid: '1',
        code: MILESTONES.defaulted,
        step: c.stepIndex.Task_Default,
        actor: '0x0',
      },
      { name: 'TokensUpdated' as const, pid: '1', status: 1, stepsRun: 30, tokens: [] },
    ])
      s = applyEvent(s, e, { ...ctx, at: 240 });
    v = noteView(c.def, s!, 250);
    expect(v.phase).toBe('defaulted');
    expect(v.economics!.state).toBe('defaulted');
    expect(v.economics!.periods.map((p) => p.status)).toEqual(['missed', 'cancelled', 'cancelled', 'cancelled']);
    expect(v.economics!.milestones.map((m) => m.name)).toEqual(['payment-missed', 'defaulted']);
  });
});

describe("the book is the open role's window, not the issuer's funding windows", () => {
  it('subscribe finds Task_Subscribe while Fund Payment windows also hold tokens', () => {
    const zero = '0x0000000000000000000000000000000000000000';
    const roles = c.def.roles.map((r) =>
      r === 'Investor'
        ? zero
        : r === 'Escrow'
          ? '0x80f1000000000000000000000000000000000000'
          : '0x7099000000000000000000000000000000000000',
    );
    const book = { tokens: [c.stepIndex.Task_Fund1, c.stepIndex.Task_TopUp_USD, c.stepIndex.Task_Subscribe], roles };
    expect(EvmAdapter.subscribeStep(c.def, book)).toBe(c.stepIndex.Task_Subscribe);
    expect(windowOpen(c.def, book)).toBe(true);
    expect(windowOpen(c.def, { tokens: [c.stepIndex.Task_Fund1, c.stepIndex.Task_TopUp_USD], roles })).toBe(false);
  });
});

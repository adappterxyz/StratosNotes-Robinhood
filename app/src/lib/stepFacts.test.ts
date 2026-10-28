import { describe, expect, it } from 'vitest';
import { compileTemplate, EXAMPLE_PRODUCTS, SCALE } from '@sn/core';
import { noteView, type NoteState } from '@sn/sdk';
import { fieldLabel, fieldValue, previewFacts, ranSteps, runsOf, stepFacts, type HistoryLike } from './stepFacts';

const p = EXAMPLE_PRODUCTS.phoenix;
const { def } = compileTemplate({ product: p });
const fx = (x: number) => (BigInt(Math.round(x * 1e6)) * SCALE) / 1_000_000n;
const idx = (name: string) => def.fields.findIndex((f) => f.name === name);
const step = (id: string) => def.steps.findIndex((s) => s.id === id);
const num = (x: number) => ({ tag: 1 as const, value: fx(x).toString() });

// A phoenix after its strike (100) and observation 1 (95): live, waiting for observation 2.
const state: NoteState = {
  id: 'robinhood-testnet:0x00000000000000000000000000000000000e0004:1',
  chain: 'robinhood-testnet',
  engine: '0x00000000000000000000000000000000000e0004',
  pid: '1',
  definition: '0x' + '1'.repeat(64),
  creator: '0x' + 'a'.repeat(40),
  ref: '',
  roles: def.roles.map((_, i) => (i === 2 ? '0x' + '0'.repeat(40) : '0x' + String(i + 1).repeat(40))),
  assetTokens: [],
  status: 0,
  tokens: [step('Task_Observe2')],
  stepsRun: 20,
  values: {
    [idx('notional')]: num(1000),
    [idx('strikeDate')]: { tag: 1, value: '1800000000' },
    [idx('obsDate1')]: { tag: 1, value: '1800100000' },
    [idx('obsDate2')]: { tag: 1, value: '1800200000' },
    [idx('initialLevel')]: num(100),
    [idx('obs1')]: num(95),
    [idx('sold')]: num(400),
  },
  holdings: [],
  createdAt: 1_799_000_000,
  updatedAt: 1_800_100_000,
  reports: { cre: 2, fallback: 0, last: 'cre' },
};
const view = noteView(def, state, 1_800_150_000);

describe('runsOf: each StepRun with the values its transaction wrote', () => {
  it('pairs FieldSet events with the step that captures those fields, by transaction', () => {
    const due = idx('due');
    const events: HistoryLike[] = [
      { name: 'StepRun', block: 2, seq: 3, tx: '0xb', at: 20, data: { step: step('S_Due1') } },
      { name: 'FieldSet', block: 2, seq: 2, tx: '0xb', at: 20, data: { field: due, value: num(0.025) } },
      { name: 'StepRun', block: 1, seq: 1, tx: '0xa', at: 10, data: { step: step('Task_Observe1') } },
    ];
    const runs = runsOf(events, def);
    expect(runs.get(step('S_Due1'))).toEqual([{ at: 20, tx: '0xb', values: { [due]: num(0.025) } }]);
    expect(runs.get(step('Task_Observe1'))?.[0].at).toBe(10);
    expect(ranSteps(def, state, runs).sort()).toEqual(['S_Due1', 'Task_Observe1']);
  });
});

describe('stepFacts: what a step means for this note', () => {
  const ctx = { def, state, view, sym: 'USDG', runs: new Map() };
  it('an observation: done, its level as a share of the strike', () => {
    const f = stepFacts({ id: 'Task_Observe1', type: 'bpmn:ServiceTask', name: 'Observe 1', branches: [] }, ctx);
    expect(f.status).toBe('done');
    expect(f.who).toMatch(/Chainlink CRE/);
    expect(f.facts.find((x) => x.label === 'Level observed')?.value).toMatch(/95 \(95\.0% of strike\)/);
  });
  it('the step the note is at: here now, with its date', () => {
    const f = stepFacts({ id: 'Task_Observe2', type: 'bpmn:ServiceTask', name: 'Observe 2', branches: [] }, ctx);
    expect(f.status).toBe('now');
    expect(f.when?.t).toBe(1800200000);
    expect(f.facts.find((x) => x.label === 'Level observed')?.value).toBe('not yet');
  });
  it('a barrier check: the observed performance against the barrier', () => {
    const f = stepFacts(
      { id: 'GW_Coupon1', type: 'bpmn:ExclusiveGateway', name: 'Coupon 1 barrier met?', branches: ['Barrier met'] },
      ctx,
    );
    expect(f.kind).toBe('Decision');
    expect(f.facts).toContainEqual({
      label: 'Coupon barrier',
      value: `${p.couponBarrierPct}% of strike: met`,
      tone: 'good',
    });
    expect(f.branches).toEqual(['Barrier met']);
  });
  it('the book: anyone subscribes, and how much is sold', () => {
    const f = stepFacts({ id: 'Task_Subscribe', type: 'bpmn:UserTask', name: 'Subscribe', branches: [] }, ctx);
    expect(f.who).toMatch(/^Any investor/);
    expect(f.facts.find((x) => x.label === 'Subscribed so far')?.value).toBe('400 of 1,000 units');
    expect(f.moves.some((m) => /pays USDG/.test(m))).toBe(true);
  });
  it('a role: who holds it', () => {
    const f = stepFacts({ id: 'Part_Issuer', type: 'bpmn:Participant', name: 'Issuer', branches: [] }, ctx);
    expect(f.facts[0]).toMatchObject({ label: 'Held by', addr: true });
  });
});

describe('labels and values', () => {
  it('names fields in words', () => {
    expect(fieldLabel('obsDate3')).toBe('Observation 3 date');
    expect(fieldLabel('initialLevel_TSLA')).toBe('TSLA strike');
    expect(fieldLabel('haircut_ETH')).toBe('ETH counted at');
  });
  it('formats by field', () => {
    expect(fieldValue('grace', 1, { tag: 1, value: '172800' }, 'USDG')).toBe('2 days');
    expect(fieldValue('collateralRatio', 0, num(1.2), 'USDG')).toBe('120.0%');
    expect(fieldValue('due', 0, num(0.025), 'USDG')).toBe('0.0250 USDG');
    expect(fieldValue('due', 0, undefined, 'USDG')).toBe('not yet');
  });
  it('previews a step before issue: what it does, who acts, no values', () => {
    const f = previewFacts(
      { id: 'Task_Observe2', type: 'bpmn:ServiceTask', name: 'Observe 2', branches: [], pool: 'Paying Agent' },
      p,
    );
    expect(f.plain).toMatch(/observation date 2/);
    expect(f.who).toMatch(/Paying Agent/);
    expect(f.facts).toEqual([]);
  });
});

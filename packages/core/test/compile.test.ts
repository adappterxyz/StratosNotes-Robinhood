import { describe, it, expect } from 'vitest';
import {
  compile,
  decodeDef,
  encodeDef,
  parseBpmn,
  instantiateProduct,
  EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF,
  KIND,
  OP,
  SRC,
  NO_EXPR,
  parseExpr,
  parsePred,
  dec,
  mul,
  div,
  simulatePayoff,
  simulateWorstOf,
  totalPerUnit,
  normalizeParams,
  FEEDS,
  type ProductType,
} from '../src';

const types = Object.keys(EXAMPLE_PRODUCTS) as ProductType[];

describe('decimal', () => {
  it('truncates like the program', () => {
    expect(mul(dec('1.5'), dec('0.3333333333'))).toBe(dec('0.49999999995'.slice(0, 12)));
    expect(div(dec(1), dec(3))).toBe(dec('0.3333333333'));
    expect(div(dec(-1), dec(3))).toBe(-dec('0.3333333333'));
  });
});

describe('worst-of baskets', () => {
  it('parses min/max with two or more values', () => {
    const r = parseExpr('min(a / b, c / d, 1)');
    expect(r.ok && r.refs).toEqual(['a', 'b', 'c', 'd']);
    expect(parseExpr('min(a)').ok).toBe(false);
    expect(parsePred('max(a, b) >= 1').ok).toBe(true);
  });
  it('observes every underlying in one step and tests the worst performer', () => {
    const prod = instantiateProduct(EXAMPLE_WORST_OF);
    const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
    const s = (id: string) => c.def.steps[c.stepIndex[id]];
    expect(
      s('Task_FixStrike')
        .captures.filter((x) => x.source === SRC.ORACLE)
        .map((x) => c.def.fields[x.field].name),
    ).toEqual(['initialLevel_ETH', 'initialLevel_BTC', 'initialLevel_SOL']);
    expect(s('Task_Observe1').captures.map((x) => [c.def.fields[x.field].name, x.source])).toEqual([
      ['obs1_ETH', SRC.ORACLE],
      ['obs1_BTC', SRC.ORACLE],
      ['obs1_SOL', SRC.ORACLE],
      ['perf1', SRC.EXPR],
      ['coverage', SRC.EXPR],
      ['payDate', SRC.EXPR],
    ]);
    // min(...) compiles to the engine's MIN opcode (16), twice for three values.
    const perf = c.def.exprs[s('Task_Observe1').captures[3].expr];
    expect(perf.filter((o) => o.code === 16)).toHaveLength(2);
    const meta = JSON.parse(c.def.meta);
    expect(Object.keys(meta.oracles)).toContain('obs4_SOL');
    expect(prod.bpmnXml).toContain('perf1 &gt;= 70 / 100');
  });
  it('pays on the worst performer; one underlying matches the single-asset payoff', () => {
    const p = EXAMPLE_WORST_OF;
    const r = simulateWorstOf(
      p,
      [2000, 60000, 150],
      [
        [2200, 72000, 90],
        [2100, 61200, 151.5],
        [1, 1, 1],
        [1, 1, 1],
      ],
    );
    expect(r.calledAt).toBe(2);
    expect(totalPerUnit(r)).toBeCloseTo(1.06, 10); // two coupons of 3% (memory) and par
    const single = { ...EXAMPLE_PRODUCTS.phoenix };
    const path = [1300, 1500, 1800, 1700];
    expect(
      simulateWorstOf(
        single,
        [2000],
        path.map((x) => [x]),
      ),
    ).toEqual(simulatePayoff(single, 2000, path));
  });
  it('reads term sheets stored with a single underlying', () => {
    const { underlyings, ...old } = EXAMPLE_PRODUCTS.fcn;
    void underlyings;
    expect(normalizeParams({ ...old, underlying: FEEDS.BTC } as never).underlyings).toEqual([FEEDS.BTC]);
  });
});

describe('products compile to engine definitions', () => {
  for (const t of types) {
    it(`${t}: BPMN round-trips and compiles`, () => {
      const prod = instantiateProduct(EXAMPLE_PRODUCTS[t]);
      const ir = parseBpmn(prod.bpmnXml, prod.assets);
      expect(ir.pools.map((p) => p.name)).toEqual(['Issuer', 'Paying Agent', 'Investor', 'Escrow']);
      expect(ir.pools.map((p) => [!!p.escrow, !!p.open])).toEqual([
        [false, false],
        [false, false],
        [false, true],
        [true, false],
      ]);
      const c = compile(ir, { product: prod.params });
      expect(decodeDef(c.bytes)).toEqual(c.def);
      expect(encodeDef(decodeDef(c.bytes))).toEqual(c.bytes);
      const s = (id: string) => c.def.steps[c.stepIndex[id]];
      // Pre-trade: collateral deposited and moved into escrow; the open subscription window; oracle steps on their dates.
      expect(s('Task_ApproveTerms').ops.map((o) => o.kind)).toEqual([OP.DEPOSIT, OP.TRANSFER]);
      expect(c.def.roleFlags).toEqual([0, 0, 0, 1]);
      expect(s('Task_Subscribe').until).toEqual({ kind: 1, at: 0n, field: c.fieldIndex.strikeDate });
      expect(s('Task_Subscribe').ops.map((o) => o.kind)).toEqual([OP.DEPOSIT, OP.SWAP]);
      expect(s('Task_FixStrike').captures[0].source).toBe(SRC.ORACLE);
      expect(s('Task_Observe1').timer).toEqual({ kind: 1, at: 0n, field: c.fieldIndex.obsDate1 });
      expect(s('Task_Mandate').sends).toEqual([c.stepIndex.Recv_Mandate]);
      expect(s('Recv_Mandate').guard).not.toBe(NO_EXPR);
      expect(c.def.steps.filter((x) => x.kind === KIND.XOR).every((x) => x.next.some((e) => e.isDefault))).toBe(true);
      expect(c.bytes.length).toBeLessThan(40_000);
      // Same workflow, same bytes, same address.
      expect(compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params }).hash).toEqual(c.hash);
    });
  }
  it('rejects unknown fields and pools with clear messages', () => {
    const prod = instantiateProduct(EXAMPLE_PRODUCTS.fcn);
    const ir = parseBpmn(prod.bpmnXml.replace('notional &gt; 0', 'nope &gt; 0'), prod.assets);
    expect(() => compile(ir)).toThrow(/'nope' is not a workflow field/);
  });
  it('parses predicates with and/or', () => {
    const r = parsePred('obs1 >= initialLevel * 70 / 100 and obs1 < initialLevel or 1 == 1');
    expect(r.ok && r.refs).toEqual(['initialLevel', 'obs1']);
  });
});

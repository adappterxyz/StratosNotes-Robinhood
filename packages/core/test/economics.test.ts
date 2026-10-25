import { describe, expect, it } from 'vitest';
import {
  check,
  compile,
  compileTemplate,
  decodeDef,
  dueReports,
  evalExpr,
  EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF,
  FEEDS,
  guardHolds,
  instantiateProduct,
  MILESTONES,
  OP,
  OP_BALANCE,
  OP_NOW,
  parseBpmn,
  parseExpr,
  parsePred,
  SEED_TEMPLATES,
  simulateNote,
  simulatePerf,
  totalPerUnit,
  validateProductParams,
  validateTermSheet,
  type ProcessState,
  type ProductParams,
  type ProductType,
} from '../src';

const compiled = (p: ProductParams) => {
  const prod = instantiateProduct(p);
  return {
    prod,
    ir: parseBpmn(prod.bpmnXml, prod.assets),
    c: compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params }),
  };
};

describe('expressions read accounts and the time', () => {
  it('parses balance(pool, asset) and now, and compiles them to the engine operands', () => {
    const r = parsePred('balance(Escrow, cash) >= dueTotal or now >= payDate + grace');
    expect(r.ok && r.refs).toEqual(['dueTotal', 'grace', 'payDate']);
    expect(r.ok && r.balances).toEqual(['Escrow.cash']);
    expect(parseExpr('balance(Escrow)').ok).toBe(false);
    const { c } = compiled(EXAMPLE_PRODUCTS.fcn);
    const ops = c.def.exprs.flat();
    expect(ops.some((o) => o.code === OP_BALANCE && o.field === ((3 << 8) | c.assetIndex.cash))).toBe(true); // role 3 = Escrow
    expect(ops.some((o) => o.code === OP_NOW)).toBe(true);
  });
  it('evaluates them like the engine', () => {
    const ops = [
      { code: OP_BALANCE, field: (3 << 8) | 1, value: 0n },
      { code: 1, field: 0, value: 0n },
      { code: 10, field: 0, value: 0n },
    ];
    const kinds = [0];
    const env = (bal: bigint) => ({
      balance: (r: number, a: number) => (r === 3 && a === 1 ? bal : 0n),
      now: () => 100,
    });
    expect(evalExpr(ops, kinds, () => 25n * 10n ** 10n, env(25n * 10n ** 10n))).toBe(10n ** 10n);
    expect(evalExpr(ops, kinds, () => 25n * 10n ** 10n, env(24n * 10n ** 10n))).toBe(0n);
    expect(evalExpr(ops, kinds, () => 1n, {})).toBe(null); // balances unknown: the expression waits
    expect(evalExpr([{ code: OP_NOW, field: 0, value: 0n }], [], () => null, { now: () => 7 })).toBe(7n * 10n ** 10n);
  });
});

describe('the payment cycle is drawn in every workflow', () => {
  const all: Array<[string, ReturnType<typeof compiled>['ir']]> = [
    ...(Object.keys(EXAMPLE_PRODUCTS) as ProductType[]).map(
      (t) => [t, compiled(EXAMPLE_PRODUCTS[t]).ir] as [string, ReturnType<typeof compiled>['ir']],
    ),
    ['worst-of', compiled(EXAMPLE_WORST_OF).ir],
    ['physical', compiled({ ...EXAMPLE_PRODUCTS.fcn, settlement: 'physical', name: 'phys' }).ir],
    ...SEED_TEMPLATES.map((t) => {
      const src = t.source.bpmnXml ? t.source : instantiateProduct(t.source.product!);
      return [t.name, parseBpmn(src.bpmnXml!, src.assets!)] as [string, ReturnType<typeof compiled>['ir']];
    }),
  ];
  for (const [name, ir] of all) {
    it(`${name}: collateral, funding windows, Funded? checks, default and release`, () => {
      const node = (id: string) => ir.nodes.find((n) => n.id === id);
      const issuer = ir.pools.find((p) => p.name === 'Issuer')!.id;
      // Issuance: the collateral is pledged at Approve Terms, and can be topped up at any time.
      expect(node('Task_ApproveTerms')?.props.milestone).toBe('collateral-pledged');
      expect(ir.nodes.some((n) => n.id.startsWith('Task_TopUp_') && n.pool === issuer && n.props.until)).toBe(true);
      // Every payment: a payment date, a Funded? check with a default branch, grace, a cure or a default.
      const pays = ir.nodes.filter((n) => n.props.milestone === 'payment-made');
      expect(pays.length).toBeGreaterThan(0);
      for (const pay of pays) {
        const k = /^Task_Pay(\d+)/.exec(pay.id)![1];
        const fund = node(`Task_Fund${k}`)!;
        expect(fund.pool).toBe(issuer);
        expect(fund.type).toBe('userTask');
        expect(fund.props.until).toEqual({ dateField: `fundUntil${k}` });
        expect(fund.props.milestone).toBe('funding-deposited');
        const gw = node(pay.id.replace('Task_Pay', 'GW_Funded'))!;
        expect(gw.type).toBe('exclusiveGateway');
        expect(gw.defaultFlow).toBeTruthy();
        expect(ir.flows.find((f) => f.id === gw.defaultFlow)!.target).toBe(pay.id.replace('Task_Pay', 'Task_Missed'));
        expect(node(pay.id.replace('Task_Pay', 'S_Due'))!.props.timer).toEqual({ dateField: 'payDate' });
        // The funding window notifies the paying agent's check for its period (a notice, not a token).
        expect(ir.messageFlows.some((m) => m.source === fund.id && m.notice && m.target.startsWith(`S_Due${k}`))).toBe(
          true,
        );
      }
      expect(node('Task_Default')?.props.milestone).toBe('defaulted');
      expect(ir.flows.some((f) => f.source === 'Task_Default' && f.target === 'End_Defaulted')).toBe(true);
      expect(node('Task_Release')?.props.milestone).toBe('collateral-released');
      expect(ir.flows.some((f) => f.source === 'Task_Release' && f.target === 'End_Closed')).toBe(true);
      // Margin: a coverage check at the strike, with the call, the wait and the cure.
      expect(['GW_Margin0', 'Task_MarginCall0', 'Recv_MarginCure0', 'Task_MarginCured0'].every((id) => node(id))).toBe(
        true,
      );
      const r = check(ir);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    });
  }

  it('notice flows are not token handoffs; milestones and escrow round-trip through the bytes', () => {
    const { ir, c } = compiled(EXAMPLE_PRODUCTS.phoenix);
    expect(c.def.steps[c.stepIndex.Task_Fund1].sends).toEqual([]);
    expect(ir.messageFlows.filter((m) => m.notice)).toHaveLength(4);
    expect(c.def.steps[c.stepIndex.Task_Default].milestone).toBe(MILESTONES.defaulted);
    // Default rule 'cap-at-owed': distribute what is owed (cash, col_USD), then the rest back to the issuer.
    expect(c.def.steps[c.stepIndex.Task_Default].ops.map((o) => o.kind)).toEqual([
      OP.DISTRIBUTE,
      OP.DISTRIBUTE,
      OP.TRANSFER,
      OP.TRANSFER,
    ]);
    expect(decodeDef(c.bytes)).toEqual(c.def);
    const all = compiled({ ...EXAMPLE_PRODUCTS.phoenix, defaultRule: 'all-to-holders' });
    expect(all.c.def.steps[all.c.stepIndex.Task_Default].ops.map((o) => o.kind)).toEqual([
      OP.DISTRIBUTE,
      OP.DISTRIBUTE,
    ]);
    expect(all.c.def.fields.some((f) => f.name === 'owed')).toBe(false);
    expect(check(all.ir).errors).toEqual([]);
  });

  it('the servicing-fee template funds the fee with each coupon and pays it from escrow', () => {
    const t = SEED_TEMPLATES.find((x) => x.name.includes('servicing fee'))!;
    const c = compileTemplate(t.source);
    const ir = parseBpmn(t.source.bpmnXml!, t.source.assets!);
    for (const due of ir.nodes.filter((n) => n.id.startsWith('S_Due'))) {
      expect(due.props.templateFields!.find((f) => f.name === 'dueTotal')!.formula).toBe('due * sold + fee');
    }
    for (const pay of ir.nodes.filter((n) => n.props.milestone === 'payment-made')) {
      expect(
        pay.props.assetOperations!.some(
          (o) => o.operation === 'transfer' && o.params.from === 'Escrow' && o.params.to === 'Paying Agent',
        ),
      ).toBe(true);
    }
    expect(
      c.def.steps.some((s) =>
        s.ops.some(
          (o) =>
            o.kind === OP.TRANSFER && c.def.roles[o.fromRole] === 'Issuer' && c.def.roles[o.toRole] === 'Paying Agent',
        ),
      ),
    ).toBe(false);
  });
});

describe('term sheet economics', () => {
  it('validates collateral, ratio, lag and grace', () => {
    const p = EXAMPLE_PRODUCTS.fcn;
    expect(validateProductParams({ ...p, gracePeriodDays: 8 }).join(' ')).toMatch(
      /grace period must be between 0 and 7/,
    );
    expect(validateProductParams({ ...p, collateral: [{ symbol: 'ETH', haircutPct: 120 }] }).join(' ')).toMatch(
      /haircut must be between 0 and 100/,
    );
    expect(
      validateProductParams({ ...p, collateral: [{ symbol: 'DOGE' as never, haircutPct: 50 }] }).join(' '),
    ).toMatch(/cannot be pledged/);
    // Assets: note + stablecoin + 3 deliverables + 3 collateral = 8 is the engine's limit; one more is refused.
    const basket: ProductParams = {
      ...p,
      chain: 'robinhood-testnet',
      settlement: 'physical',
      underlyings: [FEEDS.ETH, FEEDS.AMZN, FEEDS.TSLA],
      collateral: [
        { symbol: 'USD', haircutPct: 100 },
        { symbol: 'ETH', haircutPct: 70 },
        { symbol: 'TSLA', haircutPct: 60 },
      ],
    };
    // A legacy Robinhood Chain term sheet: its terms hold together (it still rebuilds for display) but it can't be issued.
    expect(validateTermSheet(basket)).toEqual([]);
    expect(validateProductParams(basket).join(' ')).toMatch(/issued on Arbitrum Sepolia only/);
  });
  it('checks the terms on-chain: grace above 7 days or a deadline after the next observation is refused', () => {
    const { ir } = compiled(EXAMPLE_PRODUCTS.fcn);
    const guard = ir.nodes.find((n) => n.id === 'Task_CheckTerms')!.props.receiveGuard!;
    expect(guard).toMatch(/grace <= 604800/);
    expect(guard).toMatch(/fundUntil1 <= obsDate2/);
  });
});

describe('the reference model with the issuer in the loop', () => {
  const p = EXAMPLE_PRODUCTS.phoenix;
  const perfs = [0.6, 0.65, 0.8, 0.75];
  const base = {
    perfs,
    sold: 1000,
    ratio: 1,
    collateral: [{ symbol: 'USD', amount: 1000, haircut: 1, prices: [1, 1, 1, 1, 1] }],
  };
  it('funding every payment pays exactly the payoff, then releases the collateral', () => {
    const o = simulateNote(p, base);
    expect(o.defaulted).toBeUndefined();
    expect(o.perUnit.cash).toBeCloseTo(totalPerUnit(simulatePerf(p, perfs)), 12);
    expect(o.released).toEqual({ USD: 1000 });
    expect(o.calls.map((c) => c.period)).toEqual([3, 4]); // coupons missed at 1 and 2 cost nothing to fund
    expect(o.calls[0].total).toBeCloseTo(75, 9); // 2.5% x 3 (memory) x 1,000 units
  });
  it('a missed payment defaults: holders share the escrow, nothing is released', () => {
    const o = simulateNote(p, { ...base, behaviour: { missPayment: 3 } });
    expect(o.defaulted).toEqual({ period: 3, reason: 'payment' });
    expect(o.perUnit).toEqual({ cash: 0, deliver: {}, collateral: { USD: 1 } });
    expect(o.released).toEqual({});
  });
  it('a partial payment is not paid as a coupon: it joins the collateral, pro rata', () => {
    const o = simulateNote(p, { ...base, behaviour: { partialPayment: { period: 3, fraction: 0.4 } } });
    expect(o.perUnit.cash).toBeCloseTo(0.03, 12); // 40% of 75, over 1,000 units
    expect(o.perUnit.collateral.USD).toBe(1);
  });
  it('the default rule: capped at what the holders are owed (the rest to the issuer), or everything to them', () => {
    // Over-collateralised: 3,000 USDC + 1 ETH at 1,500 behind 1,000 units; coupon 3 (75) missed.
    const rich = {
      ...base,
      collateral: [
        { symbol: 'USD', amount: 3000, haircut: 1, prices: [1, 1, 1, 1, 1] },
        { symbol: 'ETH', amount: 1, haircut: 0.7, prices: [2000, 1800, 1600, 1500, 1500] },
      ],
    };
    const capped = simulateNote(p, { ...rich, behaviour: { missPayment: 3 } });
    expect(capped.perUnit.collateral.USD).toBeCloseTo(1.075, 12); // owed: 75 + par 1,000
    expect(capped.perUnit.collateral.ETH).toBe(0);
    expect(capped.released).toEqual({ USD: 1925, ETH: 1 });
    // The stablecoin goes first, then collateral at its price then (1,500 at observation 3; no haircut).
    const thin = {
      ...base,
      collateral: [
        { symbol: 'USD', amount: 500, haircut: 1, prices: [1, 1, 1, 1, 1] },
        { symbol: 'ETH', amount: 1, haircut: 0.7, prices: [2000, 1800, 1600, 1500, 1500] },
      ],
    };
    const t = simulateNote(p, { ...thin, behaviour: { missPayment: 3 } });
    expect(t.perUnit.collateral.ETH).toBeCloseTo(575 / 1500 / 1000, 12);
    expect(t.released.ETH).toBeCloseTo(1 - 575 / 1500, 12);
    const all = simulateNote({ ...p, defaultRule: 'all-to-holders' }, { ...rich, behaviour: { missPayment: 3 } });
    expect(all.perUnit.collateral).toEqual({ USD: 3, ETH: 0.001 });
    expect(all.released).toEqual({});
  });
  it('a margin call is cured by a top-up, or defaults', () => {
    const eth = {
      ...base,
      ratio: 0.5,
      collateral: [{ symbol: 'ETH', amount: 0.4, haircut: 0.7, prices: [2000, 1900, 1200, 1200, 1200] }],
    };
    const cured = simulateNote(p, { ...eth, behaviour: { marginCall: { period: 2, topUp: { ETH: 0.2 } } } });
    expect(cured.coverage.find((c) => c.period === 2)).toMatchObject({ met: false, cured: true });
    expect(cured.defaulted).toBeUndefined();
    expect(cured.released.ETH).toBeCloseTo(0.6, 12);
    const failed = simulateNote(p, { ...eth, behaviour: { marginCall: { period: 2 } } });
    expect(failed.defaulted).toEqual({ period: 2, reason: 'margin' });
    expect(failed.perUnit.collateral.ETH).toBeCloseTo(0.0004, 12);
  });
});

describe('keeper: deadlines move the note', () => {
  const { c } = compiled(EXAMPLE_PRODUCTS.fcn);
  const field = (name: string) => c.def.fields.findIndex((f) => f.name === name);
  const st = (steps: string[], values: Record<string, bigint>, escrowCash?: bigint): ProcessState => {
    const numbers: Array<bigint | undefined> = [];
    for (const [k, v] of Object.entries(values)) numbers[field(k)] = v;
    const balances =
      escrowCash === undefined
        ? undefined
        : Array.from({ length: 4 * c.def.assets.length }, (_, i) =>
            i === 3 * c.def.assets.length + 1 ? escrowCash : 0n,
          );
    return { id: '1', definition: '0x1', status: 0, tokens: steps.map((s) => c.stepIndex[s]), numbers, balances };
  };
  const E = 10n ** 10n;
  it('advances on the payment date', () => {
    expect(dueReports(st(['S_Due1'], { payDate: 1000n }), c.def, 999)).toEqual([]);
    expect(dueReports(st(['S_Due1'], { payDate: 1000n }), c.def, 1000).map((d) => d.stepId)).toEqual(['advance']);
  });
  it('advances at the end of grace, or as soon as the escrow holds the amount due', () => {
    const vals = { payDate: 1000n, grace: 20n, dueTotal: 25n * E };
    const grace = c.stepIndex.Recv_Grace1;
    expect(guardHolds(st(['Recv_Grace1'], vals, 0n), c.def, grace, 1010)).toBe(false);
    expect(dueReports(st(['Recv_Grace1'], vals, 0n), c.def, 1010)).toEqual([]);
    expect(dueReports(st(['Recv_Grace1'], vals, 0n), c.def, 1020).map((d) => d.stepId)).toEqual(['advance']);
    expect(guardHolds(st(['Recv_Grace1'], vals, 25n * E), c.def, grace, 1010)).toBe(true);
    // Without balances the keeper cannot tell, so it waits for the deadline.
    expect(guardHolds(st(['Recv_Grace1'], vals), c.def, grace, 1010)).toBe(null);
  });
});

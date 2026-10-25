import { describe, it, expect } from 'vitest';
import {
  applyPatch,
  check,
  compile,
  draftToIR,
  EXAMPLE_PRODUCTS,
  instantiateProduct,
  irToBpmn,
  irToDraft,
  parseBpmn,
  validateProductParams,
  type ProductType,
} from '../src';
import { runAi } from '../src/ai/pipeline';
import type { AiRunner, DecisionAnswers } from '../src/ai/runner';

/** A scripted runner: decisions by question key, JSON replies in order. */
function fake(
  decisions: Record<string, Partial<DecisionAnswers[string]>>,
  json: unknown[] = [],
  text = 'ok',
): AiRunner & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async decide(_state, questions) {
      return Object.fromEntries(
        Object.keys(questions).map((k) => [k, { type: 'x', ...(decisions[k] ?? { noul: 1 }) }]),
      ) as DecisionAnswers;
    },
    async json<T>(messages: Array<{ content: string }>) {
      prompts.push(messages[messages.length - 1].content);
      const r = json.shift();
      if (r === undefined) throw new Error('no reply');
      return r as T;
    },
    async text() {
      return text;
    },
  };
}

const productDraft = (t: ProductType) => {
  const prod = instantiateProduct(EXAMPLE_PRODUCTS[t]);
  return irToDraft(parseBpmn(prod.bpmnXml, prod.assets));
};

describe('drafts', () => {
  for (const t of Object.keys(EXAMPLE_PRODUCTS) as ProductType[]) {
    it(`${t}: BPMN -> draft -> BPMN keeps the compiled workflow`, () => {
      const prod = instantiateProduct(EXAMPLE_PRODUCTS[t]);
      const ir = parseBpmn(prod.bpmnXml, prod.assets);
      const back = parseBpmn(irToBpmn(draftToIR(irToDraft(ir))).bpmnXml, prod.assets);
      expect(check(back).errors).toEqual([]);
      const a = compile(ir).def,
        b = compile(back).def;
      const shape = (d: typeof a) =>
        d.steps
          .map((s) => [
            s.id,
            s.kind,
            d.roles[s.role],
            s.captures.length,
            s.ops.map((o) => o.kind),
            s.next.length,
            s.sends.length,
            !!s.timer,
            !!s.until,
          ])
          .sort();
      expect(shape(b)).toEqual(shape(a));
    });
  }
  it('patches insert, replace and remove steps; dangling links are dropped', () => {
    const d = productDraft('fcn');
    const p = applyPatch(d, {
      upsert: [{ id: 'Task_Notify', party: 'Paying Agent', kind: 'auto', name: 'Notify', next: 'End_Closed' }],
      remove: ['S_Due4Par'],
    });
    expect(p.steps.find((s) => s.id === 'Task_Notify')).toBeDefined();
    expect(p.steps.some((s) => s.id === 'S_Due4Par')).toBe(false);
    expect(p.steps.find((s) => s.id === 'GW_KnockIn')!.branches!.map((b) => b.next)).not.toContain('S_Due4Par');
    expect(p.escrow).toEqual(['Escrow']);
    expect(p.open).toEqual(['Investor']);
  });
  it('the validator catches a broken edit', () => {
    const d = productDraft('fcn');
    const broken = applyPatch(d, { remove: ['End_Closed'] });
    expect(check(draftToIR(broken)).errors.map((e) => e.code)).toContain('DEAD_END');
  });
  it('the validator refuses a payment with no funding check', () => {
    const d = productDraft('fcn');
    // Skip the "Funded?" check: the payment date leads straight to the payment.
    const due = d.steps.find((s) => s.id === 'S_Due1')!;
    const skipped = applyPatch(d, { upsert: [{ ...due, next: 'Task_Pay1' }] });
    const errs = check(draftToIR(skipped)).errors;
    expect(errs.map((e) => e.code)).toContain('UNFUNDED_PAYMENT');
    expect(errs.find((e) => e.code === 'UNFUNDED_PAYMENT')!.message).toMatch(/no funding check/);
    // Pay holders from the issuer's own account: refused whatever precedes it.
    const pay = d.steps.find((s) => s.id === 'Task_Pay1')!;
    const fromIssuer = applyPatch(d, {
      upsert: [{ ...pay, ops: pay.ops!.map((o) => ({ ...o, params: { ...o.params, payer: 'Issuer' } })) }],
    });
    expect(check(draftToIR(fromIssuer)).errors.find((e) => e.code === 'UNFUNDED_PAYMENT')!.message).toMatch(
      /straight from 'Issuer'/,
    );
    // A fee paid automatically from the issuer to the paying agent: refused too (the old servicing-fee shape).
    const fee = applyPatch(d, {
      upsert: [
        {
          ...pay,
          ops: [
            ...pay.ops!,
            {
              assetId: 'cash',
              operation: 'transfer',
              params: { from: 'Issuer', to: 'Paying Agent', amountSource: 'expr', amountExpr: 'notional / 1000' },
            },
          ],
        },
      ],
    });
    expect(check(draftToIR(fee)).errors.map((e) => e.code)).toContain('UNFUNDED_PAYMENT');
  });
});

describe('AI pipeline (scripted models)', () => {
  it('asks for missing terms instead of inventing them', async () => {
    const ai = fake({
      intent: { choice: 'product', confidence: 0.9 },
      product: { choice: 'phoenix', confidence: 0.9 },
      couponBarrier: { noul: 0.1 },
      knockIn: { noul: 0.2 },
    });
    const r = await runAi(ai, {
      prompt: 'A phoenix on ETH, 10% p.a. quarterly, autocall 100%, one year',
      today: '2026-10-06',
    });
    expect(r.kind).toBe('clarify');
    if (r.kind === 'clarify') expect(r.missing).toEqual(['the coupon barrier', 'the knock-in barrier']);
  });
  it('asks for the collateral when the request does not say', async () => {
    const ai = fake({
      intent: { choice: 'product', confidence: 0.9 },
      product: { choice: 'fcn', confidence: 0.9 },
      collateral: { noul: 0.1 },
    });
    const r = await runAi(ai, { prompt: 'FCN on ETH, 2% quarterly, autocall 100, KI 60, 1y', today: '2026-10-06' });
    expect(r.kind).toBe('clarify');
    if (r.kind === 'clarify') expect(r.missing[0]).toMatch(/collateral/);
  });
  it('extracts a product, converting an annual coupon from the quoted words', async () => {
    const prompt =
      'Phoenix on ETH, 10% p.a. paid quarterly, coupon barrier 70%, memory, autocall 100% from the 2nd quarter, knock-in 60%, one year, 50,000 USDC, secured 50% by ETH collateral';
    const ai = fake(
      { intent: { choice: 'product', confidence: 0.9 }, product: { choice: 'phoenix', confidence: 0.9 } },
      [
        {
          productType: 'phoenix',
          name: '12M Phoenix on ETH',
          size: 50000,
          issuePricePct: null,
          underlyingSymbols: ['ETH'],
          observationEveryMonths: 3,
          observationCount: 4,
          couponRatePct: 2.5,
          couponAsStated: '10% p.a. paid quarterly',
          couponRateBasis: 'per-annum',
          couponBarrierPct: 70,
          memory: true,
          autocallLevelPct: 100,
          autocallFromPeriod: 2,
          knockInBarrierPct: 60,
          protectionPct: null,
          participationPct: null,
          collateralSymbols: ['ETH'],
          collateralRatioPct: 50,
          haircutPcts: null,
          settlementLagDays: null,
          gracePeriodDays: null,
        },
      ],
    );
    const r = await runAi(ai, { prompt, today: '2026-10-06' });
    expect(r.kind).toBe('product');
    if (r.kind !== 'product') return;
    expect(r.params).toMatchObject({
      productType: 'phoenix',
      couponRatePct: 2.5,
      couponBarrierPct: 70,
      memory: true,
      autocallLevelPct: 100,
      autocallFromPeriod: 2,
      knockInBarrierPct: 60,
      observations: 4,
    });
    expect(r.params.underlyings.map((u) => u.symbol)).toEqual(['ETH']);
    expect(r.schedule).toEqual({ every: 3, unit: 'months', count: 4, size: 50000 });
    expect(r.notes.join(' ')).toMatch(/10% p\.a\..*2\.5% per period/);
    // Collateral as stated; the haircut, lag and grace defaults are said out loud.
    expect(r.params).toMatchObject({
      collateral: [{ symbol: 'ETH', haircutPct: 70 }],
      collateralRatioPct: 50,
      settlementLagDays: 2,
      gracePeriodDays: 2,
    });
    expect(r.notes.join(' ')).toMatch(/ETH collateral haircut not stated: 70%/);
  });
  it('puts a stock note on Robinhood Chain, with its stock collateral pledged into the note there', async () => {
    const prompt =
      'Reverse convertible on TSLA, 2.5% a quarter, knock-in 70%, one year, secured by TSLA and USDG at 100%, on Robinhood Chain';
    const ai = fake(
      { intent: { choice: 'product', confidence: 0.9 }, product: { choice: 'reverse-convertible', confidence: 0.9 } },
      [
        {
          productType: 'reverse-convertible',
          name: '12M Reverse Convertible on TSLA',
          size: null,
          issuePricePct: null,
          underlyingSymbols: ['TSLA'],
          observationEveryMonths: 3,
          observationCount: 4,
          couponRatePct: 2.5,
          couponAsStated: '2.5% a quarter',
          couponRateBasis: 'per-period',
          couponBarrierPct: null,
          memory: null,
          autocallLevelPct: null,
          autocallFromPeriod: null,
          knockInBarrierPct: 70,
          protectionPct: null,
          participationPct: null,
          collateralSymbols: ['TSLA', 'USDG', 'ETH'],
          collateralRatioPct: 100,
          haircutPcts: null,
          settlementLagDays: null,
          gracePeriodDays: null,
          chain: 'robinhood-testnet',
          settlement: 'physical',
        },
      ],
    );
    const r = await runAi(ai, { prompt, today: '2026-10-06' });
    expect(r.kind).toBe('product');
    if (r.kind !== 'product') return;
    expect(r.params.chain).toBeUndefined();
    expect(r.params.collateralChain).toBeUndefined();
    expect(r.params.collateral?.map((c) => c.symbol)).toEqual(['TSLA', 'USD', 'ETH']);
    expect(validateProductParams(r.params)).toEqual([]);
  });
  it('refuses an underlying with no Chainlink feed here', async () => {
    const ai = fake({ intent: { choice: 'product', confidence: 0.9 }, product: { choice: 'fcn', confidence: 0.9 } }, [
      {
        productType: 'fcn',
        name: 'FCN on DOGE',
        size: null,
        issuePricePct: null,
        underlyingSymbols: ['DOGE'],
        observationEveryMonths: 3,
        observationCount: 4,
        couponRatePct: 2,
        couponAsStated: null,
        couponRateBasis: 'per-period',
        couponBarrierPct: null,
        memory: null,
        autocallLevelPct: 100,
        autocallFromPeriod: null,
        knockInBarrierPct: 60,
        protectionPct: null,
        participationPct: null,
        collateralSymbols: ['USD'],
        collateralRatioPct: 100,
        haircutPcts: null,
        settlementLagDays: null,
        gracePeriodDays: null,
      },
    ]);
    const r = await runAi(ai, { prompt: 'FCN on DOGE, 2% quarterly, autocall 100, KI 60, 1y', today: '2026-10-06' });
    expect(r.kind).toBe('clarify');
    if (r.kind === 'clarify') expect(r.reply).toMatch(/no Chainlink price feed for DOGE.*ETH, BTC, SOL, TSLA/);
  });
  it('edits the open workflow with a patch, repairing what the validator rejects', async () => {
    const draft = productDraft('fcn');
    const pay = draft.steps.find((s) => s.id === 'Task_Pay1')!;
    const due = draft.steps.find((s) => s.id === 'S_Due1')!;
    const bonusFromIssuer = {
      assetId: 'cash',
      operation: 'distribute',
      params: { holdingAssetId: 'note', payer: 'Issuer', amountSource: 'expr', amountExpr: '1 / 100' },
    };
    const bonusFromEscrow = { ...bonusFromIssuer, params: { ...bonusFromIssuer.params, payer: 'Escrow' } };
    const ai = fake({ intent: { choice: 'edit', confidence: 0.9 } }, [
      // First try: a loyalty bonus paid straight from the issuer -> unfunded payment.
      { upsert: [{ ...pay, ops: [...pay.ops!, bonusFromIssuer] }] },
      // Second try: drops the "Payment Missed" step -> an economic step removed.
      { upsert: [{ ...pay, ops: [...pay.ops!, bonusFromEscrow] }], remove: ['Task_Missed1'] },
      // Repaired: paid from escrow, and the bonus is part of what the issuer funds for period 1.
      {
        upsert: [
          { ...pay, ops: [...pay.ops!, bonusFromEscrow] },
          {
            ...due,
            fields: due.fields!.map((f) => (f.name === 'dueTotal' ? { ...f, formula: 'due * sold + sold / 100' } : f)),
          },
        ],
      },
    ]);
    const r = await runAi(ai, { prompt: 'Pay a 1% loyalty bonus with the first coupon', today: '2026-10-06', draft });
    expect(r.kind).toBe('workflow');
    if (r.kind !== 'workflow') return;
    expect(ai.prompts[1]).toMatch(/straight from 'Issuer'/);
    expect(ai.prompts[2]).toMatch(/Task_Missed1.*payment-missed\) was removed: keep it/);
    expect(r.changed).toEqual(['Task_Pay1', 'S_Due1']);
    const ir = parseBpmn(r.bpmnXml, draft.assets);
    expect(check(ir).errors).toEqual([]);
    expect(ir.nodes.find((n) => n.id === 'Task_Pay1')?.props.assetOperations?.map((o) => o.params.payer)).toEqual([
      'Escrow',
      'Escrow',
    ]);
    // The funding, default and release steps all survive the edit.
    for (const id of ['Task_Fund1', 'GW_Funded1', 'Recv_Grace1', 'Task_Default', 'Task_Release'])
      expect(ir.nodes.some((n) => n.id === id)).toBe(true);
  });
});

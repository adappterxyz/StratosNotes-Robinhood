/**
 * The seed template library: four equity notes, four crypto products and two custom workflows. Every note is
 * issued on Robinhood Chain testnet, where its whole lifecycle runs and its collateral is pledged. Stock notes on
 * Robinhood's own stock tokens (TSLA, AMZN) deliver the token below the knock-in barrier and take TSLA itself as
 * collateral; stocks with no token there (NVDA, AAPL) and the crypto notes settle in cash. Every token they deliver
 * or pledge is a real one on Robinhood Chain (USDG, Robinhood's TSLA and AMZN). Custom ones are product workflows
 * edited through the draft format the AI edits, then checked by the validator. scripts/seed-templates.ts publishes them;
 * test/products.e2e.test.ts runs the custom ones on a local validator.
 */
import { check } from '../validate';
import { draftToIR, irToBpmn, irToDraft, type WorkflowDraft } from '../draft';
import { parseBpmn } from '../bpmn';
import type { TemplateSource } from '../templates';
import { instantiateProduct } from './instantiate';
import { EXAMPLE_PRODUCTS, EXAMPLE_WORST_OF, FEEDS, type ProductParams } from './params';

/** A product workflow, edited as a draft, back to BPMN (validated). */
function custom(basis: ProductParams, name: string, edit: (d: WorkflowDraft) => void): TemplateSource {
  const prod = instantiateProduct(basis);
  const d = irToDraft(parseBpmn(prod.bpmnXml, prod.assets));
  d.name = name;
  edit(d);
  const ir = draftToIR(d);
  const { bpmnXml } = irToBpmn(ir, 'WF', prod.layout); // keep the product's own layout
  const issues = check(parseBpmn(bpmnXml, prod.assets));
  if (issues.errors.length) throw new Error(`${name}: ${issues.errors.map((e) => e.message).join('; ')}`);
  return { bpmnXml, assets: prod.assets, basis };
}

const step = (d: WorkflowDraft, id: string) => {
  const s = d.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const worstOfFcn: ProductParams = {
  ...EXAMPLE_PRODUCTS.fcn,
  name: '12M Worst-of FCN on ETH, BTC',
  underlyings: [FEEDS.ETH, FEEDS.BTC],
  couponRatePct: 2.5,
};
const btcSnowball: ProductParams = {
  ...EXAMPLE_PRODUCTS.snowball,
  name: '12M Snowball on BTC',
  underlyings: [FEEDS.BTC],
  couponRatePct: 2.5,
};
const solPpn: ProductParams = {
  ...EXAMPLE_PRODUCTS.ppn,
  name: '6M 90% Protected Note on SOL',
  underlyings: [FEEDS.SOL],
  protectionPct: 90,
  participationPct: 100,
};
const ethPhoenix: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, name: '12M Step-down Phoenix on ETH' };
// Equity notes: prices from Robinhood Chain mainnet's Chainlink stock feeds (market hours); issued, settled and
// collateralised on Robinhood Chain testnet. Stock collateral is Robinhood's TSLA token, pledged into the note.
const TSLA_PLEDGED = {
  collateral: [
    { symbol: 'TSLA' as const, haircutPct: 60 },
    { symbol: 'USD' as const, haircutPct: 100 },
  ],
};
const equityPhoenix: ProductParams = {
  ...EXAMPLE_WORST_OF,
  name: '12M Worst-of Phoenix on TSLA, NVDA',
  underlyings: [FEEDS.TSLA, FEEDS.NVDA],
  couponRatePct: 3,
  ...TSLA_PLEDGED,
};
// No Apple token exists on Robinhood Chain: this one settles in cash.
const aaplRc: ProductParams = {
  ...EXAMPLE_PRODUCTS['reverse-convertible'],
  name: '12M Reverse Convertible on AAPL',
  underlyings: [FEEDS.AAPL],
  couponRatePct: 2.5,
  knockInBarrierPct: 70,
};
const tslaAmznPhoenix: ProductParams = {
  ...EXAMPLE_WORST_OF,
  name: '12M Worst-of Phoenix on TSLA, AMZN',
  underlyings: [FEEDS.TSLA, FEEDS.AMZN],
  couponRatePct: 3,
  settlement: 'physical',
  ...TSLA_PLEDGED,
};
const tslaRc: ProductParams = {
  ...EXAMPLE_PRODUCTS['reverse-convertible'],
  name: '12M Reverse Convertible on TSLA',
  underlyings: [FEEDS.TSLA],
  couponRatePct: 2.5,
  knockInBarrierPct: 70,
  settlement: 'physical',
  ...TSLA_PLEDGED,
};
const btcPhoenix: ProductParams = {
  ...EXAMPLE_PRODUCTS.phoenix,
  name: '12M Phoenix on BTC with servicing fee',
  underlyings: [FEEDS.BTC],
  couponRatePct: 2.5,
};

export const SEED_TEMPLATES: Array<{ name: string; description: string; source: TemplateSource }> = [
  {
    name: '12M Worst-of Phoenix on TSLA, AMZN',
    description:
      '3% quarterly while the worst of Tesla and Amazon holds 70% of strike, with memory; autocalls at 100% from Q2; below the 60% knock-in, holders receive the worst performer\'s token (Robinhood\'s TSLA or AMZN). Secured by TSLA (60% haircut) and USDG pledged on Robinhood Chain. Prices: Chainlink on Robinhood Chain.',
    source: { product: tslaAmznPhoenix },
  },
  {
    name: '12M Reverse Convertible on TSLA',
    description:
      '2.5% quarterly coupon; if Tesla ends below 70% of its strike, holders receive Robinhood\'s TSLA token (1 ÷ strike per unit) instead of par. Secured by TSLA (60% haircut) and USDG pledged on Robinhood Chain. Prices: Chainlink TSLA/USD on Robinhood Chain.',
    source: { product: tslaRc },
  },
  {
    name: '12M Worst-of Phoenix on TSLA, NVDA',
    description:
      '3% quarterly while the worst of Tesla and NVIDIA holds 70% of strike, with memory; autocalls at 100% from Q2; 60% knock-in, cash-settled in USDG (no NVIDIA token on Robinhood Chain). Secured by TSLA (60% haircut) and USDG pledged on Robinhood Chain. Prices: Chainlink on Robinhood Chain.',
    source: { product: equityPhoenix },
  },
  {
    name: '12M Reverse Convertible on AAPL',
    description:
      '2.5% quarterly coupon; if Apple ends below 70% of its strike, holders are repaid final ÷ strike in USDG. Prices: Chainlink AAPL/USD on Robinhood Chain.',
    source: { product: aaplRc },
  },
  {
    name: '12M Worst-of Phoenix on ETH, BTC, SOL',
    description:
      '3% quarterly coupon while the worst of ETH, BTC and SOL holds 70% of its strike, with memory; autocalls at 100% from Q2; 60% knock-in on the worst performer.',
    source: { product: EXAMPLE_WORST_OF },
  },
  {
    name: '12M Worst-of FCN on ETH, BTC',
    description:
      'Fixed 2.5% quarterly coupon; autocalls when both ETH and BTC are at or above their strikes; capital at risk below 60% of the worst performer.',
    source: { product: worstOfFcn },
  },
  {
    name: '12M Snowball on BTC',
    description:
      'Accrues 2.5% a quarter, paid in full on autocall at 100% of the BTC strike or at maturity if above it; 65% knock-in.',
    source: { product: btcSnowball },
  },
  {
    name: '6M 90% Protected Note on SOL',
    description:
      '90% of face back at maturity whatever SOL does, plus 100% of any rise above the strike. One observation at maturity.',
    source: { product: solPpn },
  },
  {
    name: '12M Step-down Phoenix on ETH',
    description:
      'Custom: the autocall level steps down, 100% of the ETH strike at Q2 and 95% at Q3, so the note is likelier to call early. 2.5% memory coupon above 70%; 60% knock-in at maturity.',
    source: custom(ethPhoenix, '12M Step-down Phoenix on ETH', (d) => {
      // Autocall at Q2 at 100%, at Q3 at 95% (each gateway's "Autocall" branch condition); maturity is unchanged.
      const levels: Record<number, number> = { 2: 100, 3: 95 };
      for (const [k, lvl] of Object.entries(levels)) {
        const gw = step(d, `GW_Autocall${k}`);
        const b = gw.branches?.find((x) => !x.default);
        if (!b) throw new Error(`GW_Autocall${k} has no autocall branch`);
        b.condition = `obs${k} >= initialLevel * ${lvl} / 100`;
        b.label = `Autocall (${lvl}%)`;
      }
    }),
  },
  {
    name: '12M Phoenix on BTC with servicing fee',
    description:
      'Custom: a BTC phoenix (2.5% memory coupon above 70%, autocall 100% from Q2, 60% knock-in) where the issuer also pays the paying agent 0.1% of the issue size with each coupon. The fee is part of each payment the issuer funds: unfunded, the note defaults like any missed coupon.',
    source: custom(btcPhoenix, '12M Phoenix on BTC with servicing fee', (d) => {
      // Every payment block: its amount due grows by the fee whenever a coupon is paid (cpn > 0), so the
      // issuer funds coupon and fee together and the "Funded?" check covers both; the payment pays the
      // fee to the paying agent from escrow alongside the holders.
      const FEE = 'notional * 1 / 1000 * min(cpn * 1000000, 1)';
      for (const s of d.steps.filter((x) => /^S_Due\d+/.test(x.id))) {
        s.fields = [
          ...(s.fields ?? []).filter((f) => f.name !== 'dueTotal'),
          { name: 'fee', type: 'Decimal', formula: FEE },
          { name: 'dueTotal', type: 'Decimal', formula: 'due * sold + fee' },
        ];
      }
      for (const s of d.steps.filter((x) => /^Task_Pay\d+/.test(x.id))) {
        s.ops = [
          ...(s.ops ?? []),
          {
            assetId: 'cash',
            operation: 'transfer',
            params: { from: 'Escrow', to: 'Paying Agent', amountSource: 'field', amountField: 'fee' },
          },
        ];
        s.name = `${s.name} + Servicing Fee`;
      }
    }),
  },
];

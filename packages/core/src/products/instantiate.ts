/**
 * Instantiate a structured product into a BPMN workflow. The economics are drawn in the workflow itself
 * (docs/NOTE-ECONOMICS.md), so the canvas, the validator and the engine all see the same thing:
 *
 *  Issuer
 *    "Approve Terms" (pre-trade): this issuance's size, dates, settlement lag, grace period, collateral ratio and
 *      haircuts, and the collateral it PLEDGES: deposited and moved into the Escrow account in one step.
 *    "Check Terms": the engine refuses the issuance unless the terms are in range (grace 0-7 days, haircuts
 *      0-100%, every payment deadline before the next observation).
 *    "Mandate Paying Agent", then repeatable windows that stay open for the note's life:
 *      "Fund Payment k" (until payment date k + grace): stablecoin into escrow for period k;
 *      "Top Up Collateral X": more collateral into escrow (e.g. to cure a margin call);
 *      "Fund Delivery tX" (physical notes): the deliverable token into escrow before maturity.
 *    Each funding window sends a notice to the paying agent's "Funded?" check for its period.
 *  Escrow: an account the engine holds for the note (FlowEngine.ESCROW). Nobody signs for it, so nobody can
 *    withdraw from it: only the workflow moves its balances (payments, default, release).
 *  Investor (OPEN: anyone): "Subscribe" until the strike date. The stablecoin goes to the ISSUER (the funds the
 *    note raises, withdrawable at once) and the investor receives units, in one atomic swap.
 *  Paying Agent (calculation agent; its oracle steps are Chainlink CRE reports):
 *    Fix Strike: strikes, collateral prices, units sold (the issuer's unsold units are cancelled), the required
 *      coverage (ratio x units sold) and the coverage now (sum of escrowed collateral x price x haircut).
 *    Margin check at the strike and at every observation: coverage below the requirement opens a margin call;
 *      the issuer tops up within the grace period or the note defaults.
 *    Observation k fixes what period k owes; the payment block then waits for payment date k
 *      (observation + lag), checks the escrow ("Funded?"): funded -> pay holders from escrow; not funded ->
 *      "Payment Missed", the grace period runs, cured -> pay; not cured -> DEFAULT.
 *    Default: everything in escrow (collateral in kind and any partial funding) is distributed to the holders
 *      pro rata to their units, and the note ends Defaulted.
 *    After the final payment (autocall or maturity): "Release Collateral" returns the escrow to the issuer.
 *
 * Every number is an exact decimal in the generated expressions (e.g. `initialLevel * 70 / 100`), evaluated
 * on-chain in 10-decimal fixed point. Worst-of baskets observe one feed per underlying in the same CRE report
 * and compare the worst performance perfK = min(obsK_i / initialLevel_i) with each level.
 */
import {
  buildWorkflow,
  chain,
  field,
  type BuildSpec,
  type BuiltWorkflow,
  type SpecFlow,
  type SpecMessage,
  type SpecNode,
} from '../bpmn';
import { productNotifications } from '../notify';
import type { AssetDefinition, AssetOperation, TemplateField } from '../types';
import {
  CASH_TOKEN,
  collateralTokenOf,
  deliverableToken,
  economicsOf,
  FEEDS,
  MAX_GRACE_DAYS,
  PRODUCT_LABELS,
  productUses,
  underlyingLabel,
  validateTermSheet,
  type CollateralSymbol,
  type ProductParams,
  type Underlying,
} from './params';

export const ISSUER = 'Issuer';
export const PA = 'Paying Agent';
export const INVESTOR = 'Investor';
export const ESCROW = 'Escrow';

export interface InstantiatedProduct extends BuiltWorkflow {
  id: string;
  name: string;
  description: string;
  params: ProductParams;
  /** Where each step sits on the canvas grid, so an edited copy can keep this layout (draft.ts irToBpmn). */
  layout: Record<string, { col: number; row: number }>;
}

const num = (n: number) => {
  const s = String(n);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`unsupported number ${n}`);
  return s;
};
const pct = (n: number) => `${num(n)} / 100`;
const SECONDS_PER_DAY = 86_400;

/** Field and asset names for a collateral asset. */
export const colAsset = (c: CollateralSymbol) => `col_${c}`;
export const pledgeField = (c: CollateralSymbol) => `pledge_${c}`;
export const haircutField = (c: CollateralSymbol) => `haircut_${c}`;
export const priceField = (c: CollateralSymbol) => `px_${c}`;
export const topUpField = (c: CollateralSymbol) => `topUp_${c}`;
export const deliverAsset = (sym: string) => `d_${sym}`;

export function instantiateProduct(p: ProductParams): InstantiatedProduct {
  const errs = validateTermSheet(p); // a legacy (Robinhood Chain) note still rebuilds for display; issuance checks validateProductParams
  if (errs.length) throw new Error('Invalid product parameters: ' + errs.join(' '));
  const use = productUses(p.productType);
  const eco = economicsOf(p);
  const n = p.observations;
  const unds = p.underlyings;
  const basket = unds.length > 1;
  const physical = p.settlement === 'physical';
  const col = eco.collateral;

  const assets: AssetDefinition[] = [
    { id: 'note', name: 'Note', kind: 'issued' },
    { id: 'cash', name: 'USDG', kind: 'cash', decimals: CASH_TOKEN.decimals, token: CASH_TOKEN.token },
    // Physical delivery: each underlying's token, delivered below the knock-in barrier.
    ...(physical
      ? unds.map((u) => {
          const d = deliverableToken(p, u.symbol)!;
          return {
            id: deliverAsset(u.symbol),
            name: d.token,
            kind: 'cash' as const,
            decimals: d.decimals,
            token: d.token,
          };
        })
      : []),
    // Collateral: its own asset per token (even the stablecoin), so pledged collateral never mixes with payments.
    ...col.map((c) => {
      const t = collateralTokenOf(p, c.symbol)!;
      return {
        id: colAsset(c.symbol),
        name: `Collateral ${t.token}`,
        kind: 'cash' as const,
        decimals: t.decimals,
        token: t.token,
      };
    }),
  ];
  const escrowAssets = assets.filter((a) => a.kind === 'cash').map((a) => a.id);

  const oracleField = (name: string, u: Underlying) =>
    field(name, 'Decimal', {
      oracle: {
        feed: u.feed,
        feedChain: u.feedChain,
        min: num(u.minPrice),
        max: num(u.maxPrice),
        staleness: u.staleness ?? 3600,
      },
    });
  // Collateral prices ride on the same CRE reports as the observations (USD needs none).
  const priced = col.filter((c) => c.symbol !== 'USD');
  const priceFields = () =>
    priced.map((c) => oracleField(priceField(c.symbol), FEEDS[c.symbol as Exclude<CollateralSymbol, 'USD'>]));
  /** Coverage now: escrowed collateral x price x haircut, in stablecoin. */
  const coverageExpr =
    col
      .map((c) =>
        c.symbol === 'USD'
          ? `balance(${ESCROW}, ${colAsset(c.symbol)}) * ${haircutField(c.symbol)}`
          : `balance(${ESCROW}, ${colAsset(c.symbol)}) * ${priceField(c.symbol)} * ${haircutField(c.symbol)}`,
      )
      .join(' + ') || '0';
  const covered = `${coverageExpr} >= required`;

  const strikeFields = basket
    ? unds.map((u) => oracleField(`initialLevel_${u.symbol}`, u))
    : [oracleField('initialLevel', unds[0])];
  const obsFields = (k: number): TemplateField[] => [
    ...(basket
      ? [
          ...unds.map((u) => oracleField(`obs${k}_${u.symbol}`, u)),
          field(`perf${k}`, 'Decimal', {
            formula: `min(${unds.map((u) => `obs${k}_${u.symbol} / initialLevel_${u.symbol}`).join(', ')})`,
          }),
        ]
      : [oracleField(`obs${k}`, unds[0])]),
    ...priceFields(),
    field('coverage', 'Decimal', { formula: coverageExpr }),
    field('payDate', 'Date', { formula: `obsDate${k} + lag` }),
  ];
  /** Worst performance at observation k (a ratio, 1 = at strike). */
  const ratio = (k: number) => (basket ? `perf${k}` : `obs${k} / initialLevel`);
  /** Performance at observation k at or above `levelPct` % of strike. */
  const atLeast = (k: number, levelPct: number) =>
    basket ? `perf${k} >= ${pct(levelPct)}` : `obs${k} >= initialLevel * ${pct(levelPct)}`;
  const issuePrice = pct(p.issuePricePct);

  // ---- Paying Agent lifecycle ---------------------------------------------
  const nodes: SpecNode[] = [];
  const flows: SpecFlow[] = [];
  const messages: SpecMessage[] = [];
  let fid = 0;
  const flow = (src: string, tgt: string, extra: Partial<SpecFlow> = {}) =>
    flows.push({ id: `P_F${++fid}`, src, tgt, ...extra });
  let col0 = 7;
  const at = () => col0++;
  const memory = p.productType === 'phoenix' && !!p.memory;
  const fundUntil = (k: number) => `fundUntil${k}`;
  const closing: TemplateField[] = [
    field('closedAt', 'Date', { formula: 'now' }),
    ...Array.from({ length: n }, (_, i) => field(fundUntil(i + 1), 'Date', { formula: 'now' })),
  ];
  // DEFAULT RULE 'cap-at-owed': the holders take what they are owed (owed = a missed payment + par on the
  // units sold) from escrow in order, stablecoin first, each asset valued at its last oracle price (collateral
  // at market, no haircut; a deliverable at its strike level); the rest goes back to the issuer.
  const capped = eco.defaultRule === 'cap-at-owed';
  const takeField = (a: string) => `take_${a}`;
  const priceOf = (a: string) => {
    if (a === 'cash' || a === colAsset('USD')) return '1';
    if (a.startsWith('col_')) return priceField(a.slice(4) as CollateralSymbol);
    return basket ? `initialLevel_${a.slice(2)}` : 'initialLevel';
  };
  const defaultTakes: TemplateField[] = capped
    ? [
        field('owed', 'Decimal', { formula: 'owedDue + principal' }),
        ...escrowAssets.map((a, i) => {
          const taken = escrowAssets
            .slice(0, i)
            .map((b) => ` - ${takeField(b)} * ${priceOf(b)}`)
            .join('');
          const rest = `(owed${taken})`;
          const px = priceOf(a);
          return field(takeField(a), 'Decimal', {
            formula: `max(0, min(balance(${ESCROW}, ${a}), ${px === '1' ? rest : `${rest} / ${px}`}))`,
          });
        }),
      ]
    : [];

  nodes.push(
    {
      id: 'Recv_Mandate',
      type: 'receiveTask',
      name: 'Mandate Received',
      col: 3,
      props: { receiveGuard: 'notional > 0' },
    },
    {
      id: 'Task_IssueNote',
      type: 'serviceTask',
      name: 'Issue Note to Issuer',
      col: 4,
      props: {
        assetOperation: {
          assetId: 'note',
          operation: 'mint',
          params: { amountSource: 'field', amountField: 'notional', owner: ISSUER },
        },
      },
    },
    {
      id: 'Task_FixStrike',
      type: 'serviceTask',
      name: 'Fix Strike (oracle)',
      col: 5,
      props: {
        timer: { dateField: 'strikeDate' },
        templateFields: [
          ...strikeFields,
          ...priceFields(),
          // Units sold when the book closed; the issuer's unsold units are cancelled below.
          field('sold', 'Decimal', { formula: `notional - balance(${ISSUER}, note)` }),
          field('required', 'Decimal', { formula: 'collateralRatio * sold' }),
          field('coverage', 'Decimal', { formula: coverageExpr }),
          ...(memory ? [field('missed', 'Decimal', { formula: '0' })] : []),
          // What a default would owe the holders: par on every unit sold, plus a missed payment (none yet).
          ...(capped
            ? [field('principal', 'Decimal', { formula: 'sold' }), field('owedDue', 'Decimal', { formula: '0' })]
            : []),
        ],
        assetOperation: {
          assetId: 'note',
          operation: 'burn',
          params: { from: ISSUER, amountSource: 'expr', amountExpr: `balance(${ISSUER}, note)` },
        },
      },
    },
    { id: 'GW_Sold', type: 'exclusiveGateway', name: 'Any units sold?', col: 6 },
    // Shared ends: default (escrow to holders) and release (escrow back to the issuer).
    {
      id: 'Task_Default',
      type: 'serviceTask',
      name: capped ? 'Default: Owed to Holders, Rest to Issuer' : 'Default: Collateral to Holders',
      col: 0,
      row: 3,
      props: {
        milestone: 'defaulted',
        templateFields: capped ? [...closing, ...defaultTakes] : closing,
        assetOperations: [
          ...escrowAssets.map((a, i) => ({
            assetId: a,
            operation: 'distribute' as const,
            params: {
              holdingAssetId: 'note',
              payer: ESCROW,
              amountSource: 'expr' as const,
              amountExpr: capped ? `${takeField(a)} / sold` : `balance(${ESCROW}, ${a}) / sold`,
              ...(i === escrowAssets.length - 1 ? { retire: true } : {}),
            },
          })),
          // Capped: whatever the holders are not owed goes back to the issuer.
          ...(capped
            ? escrowAssets.map((a) => ({
                assetId: a,
                operation: 'transfer' as const,
                params: {
                  from: ESCROW,
                  to: ISSUER,
                  amountSource: 'expr' as const,
                  amountExpr: `balance(${ESCROW}, ${a})`,
                },
              }))
            : []),
        ],
      },
    },
    { id: 'End_Defaulted', type: 'endEvent', name: 'Defaulted', col: 1, row: 3 },
    {
      id: 'Task_Release',
      type: 'serviceTask',
      name: 'Release Collateral',
      col: 0,
      row: 2,
      props: {
        milestone: 'collateral-released',
        templateFields: closing,
        assetOperations: escrowAssets.map((a) => ({
          assetId: a,
          operation: 'transfer' as const,
          params: { from: ESCROW, to: ISSUER, amountSource: 'expr' as const, amountExpr: `balance(${ESCROW}, ${a})` },
        })),
      },
    },
    { id: 'End_Closed', type: 'endEvent', name: 'Note Closed', col: 1, row: 2 },
  );
  flows.push(...chain('P_S', 'Recv_Mandate', 'Task_IssueNote', 'Task_FixStrike', 'GW_Sold'));
  flow('Task_Default', 'End_Defaulted');
  flow('Task_Release', 'End_Closed');
  flow('GW_Sold', 'Task_Release', { name: 'Nothing sold: cancel', isDefault: true });

  /** Margin check after a fixing or an observation; returns the step the note continues from. */
  const marginCheck = (k: number, from: string, extra: Partial<SpecFlow> = {}) => {
    const gw = `GW_Margin${k}`,
      call = `Task_MarginCall${k}`,
      wait = `Recv_MarginCure${k}`,
      cured = `GW_MarginCured${k}`,
      ok = `Task_MarginCured${k}`;
    const dateOf = k === 0 ? 'strikeDate' : `obsDate${k}`;
    const c = at();
    nodes.push(
      { id: gw, type: 'exclusiveGateway', name: k === 0 ? 'Collateral covers the note?' : `Covered at ${k}?`, col: c },
      {
        id: call,
        type: 'serviceTask',
        name: `Margin Call${k ? ` ${k}` : ''}`,
        col: c,
        row: 4,
        props: { milestone: 'margin-call' },
      },
      {
        id: wait,
        type: 'receiveTask',
        name: `Await Top-up${k ? ` ${k}` : ''} (grace)`,
        col: c + 1,
        row: 4,
        props: { receiveGuard: `${covered} or now >= ${dateOf} + grace` },
      },
      { id: cured, type: 'exclusiveGateway', name: 'Cured?', col: c + 2, row: 4 },
      {
        id: ok,
        type: 'serviceTask',
        name: `Margin Call${k ? ` ${k}` : ''} Cured`,
        col: c + 3,
        row: 4,
        props: { milestone: 'margin-cured', templateFields: [field('coverage', 'Decimal', { formula: coverageExpr })] },
      },
    );
    flow(from, gw, extra);
    flow(gw, call, { name: 'Below requirement', isDefault: true });
    flow(call, wait);
    flow(wait, cured);
    flow(cured, ok, { name: 'Topped up', cond: covered });
    flow(cured, 'Task_Default', { name: 'Not cured: default', isDefault: true });
    return { gw, ok };
  };

  /**
   * A payment: wait for payment date k, then pay holders from escrow if the issuer funded it (due per unit,
   * `deliver` tokens per unit for physical settlement), else grace, then pay or default. Returns the pay step.
   */
  const firstSettle: Record<number, string> = {};
  const settle = (
    k: number,
    tag: string,
    dueExpr: string,
    opts: { final: boolean; deliver?: { sym: string; perUnit: string } },
  ) => {
    const due = `S_Due${k}${tag}`,
      gw = `GW_Funded${k}${tag}`,
      missed = `Task_Missed${k}${tag}`,
      grace = `Recv_Grace${k}${tag}`,
      cured = `GW_Cured${k}${tag}`,
      pay = `Task_Pay${k}${tag}`;
    const funded = `balance(${ESCROW}, cash) >= dueTotal${opts.deliver ? ` and balance(${ESCROW}, ${deliverAsset(opts.deliver.sym)}) >= sold * ${opts.deliver.perUnit}` : ''}`;
    const c = at();
    const row = opts.final ? 2 : 0;
    firstSettle[k] ??= due;
    const pays: AssetOperation[] = [
      {
        assetId: 'cash',
        operation: 'distribute',
        params: {
          holdingAssetId: 'note',
          payer: ESCROW,
          amountSource: 'field',
          amountField: 'due',
          ...(opts.final && !opts.deliver ? { retire: true } : {}),
        },
      },
      ...(opts.deliver
        ? [
            {
              assetId: deliverAsset(opts.deliver.sym),
              operation: 'distribute' as const,
              params: {
                holdingAssetId: 'note',
                payer: ESCROW,
                amountSource: 'expr' as const,
                amountExpr: opts.deliver.perUnit,
                retire: true,
              },
            },
          ]
        : []),
    ];
    const label = opts.deliver
      ? `Deliver ${opts.deliver.sym} + Pay ${k}`
      : opts.final
        ? k === n
          ? 'Pay at Maturity'
          : `Pay Redemption ${k}`
        : `Pay Coupon ${k}`;
    nodes.push(
      {
        id: due,
        type: 'serviceTask',
        name: `Payment Date ${k}`,
        col: c,
        row,
        props: {
          timer: { dateField: 'payDate' },
          templateFields: [
            field('due', 'Decimal', { formula: dueExpr }),
            field('dueTotal', 'Decimal', { formula: 'due * sold' }),
          ],
        },
      },
      { id: gw, type: 'exclusiveGateway', name: 'Funded?', col: c + 1, row },
      {
        id: missed,
        type: 'serviceTask',
        name: `Payment ${k} Missed`,
        col: c + 1,
        row: row + 1,
        props: {
          milestone: 'payment-missed',
          // Owed on a default: this payment, plus par unless it pays the redemption in cash (a delivery still owes par).
          ...(capped
            ? {
                templateFields: [
                  field('owedDue', 'Decimal', { formula: 'due * sold' }),
                  ...(opts.final && !opts.deliver ? [field('principal', 'Decimal', { formula: '0' })] : []),
                ],
              }
            : {}),
        },
      },
      {
        id: grace,
        type: 'receiveTask',
        name: `Grace ${k}`,
        col: c + 2,
        row: row + 1,
        props: { receiveGuard: `${funded} or now >= payDate + grace` },
      },
      { id: cured, type: 'exclusiveGateway', name: 'Cured in grace?', col: c + 3, row: row + 1 },
      {
        id: pay,
        type: 'serviceTask',
        name: label,
        col: c + 2,
        row,
        props: {
          milestone: 'payment-made',
          assetOperations: pays,
          ...(capped ? { templateFields: [field('owedDue', 'Decimal', { formula: '0' })] } : {}),
        },
      },
    );
    flow(due, gw);
    flow(gw, pay, { name: 'Funded', cond: funded });
    flow(gw, missed, { name: 'Not funded', isDefault: true });
    flow(missed, grace);
    flow(grace, cured);
    flow(cured, pay, { name: 'Funded in grace', cond: funded });
    flow(cured, 'Task_Default', { name: 'Default', isDefault: true });
    col0 += 3;
    if (opts.final) flow(pay, 'Task_Release');
    return { due, pay };
  };

  // Strike: the book has closed. Nothing sold cancels the note; otherwise check the collateral.
  const m0 = marginCheck(0, 'GW_Sold', { name: 'Sold', cond: 'sold > 0' });
  let cont: { from: string; extra?: Partial<SpecFlow> }[] = [
    { from: m0.gw, extra: { name: 'Covered', cond: covered } },
    { from: m0.ok },
  ];
  const linkTo = (tgt: string) => {
    for (const c of cont) flow(c.from, tgt, c.extra ?? {});
    cont = [];
  };

  const rate = p.couponRatePct ?? 0;
  const acFrom = p.autocallFromPeriod ?? 1;
  const redeemPerUnit = (k: number) => (p.productType === 'snowball' ? `1 + ${pct(rate)} * ${k}` : '1');
  /** This period's coupon per unit, as an expression. */
  const cpnExpr =
    p.productType === 'phoenix'
      ? 'cpn'
      : p.productType === 'fcn' || p.productType === 'reverse-convertible'
        ? pct(rate)
        : '0';

  for (let k = 1; k <= n; k++) {
    const last = k === n;
    const obsId = `Task_Observe${k}`;
    nodes.push({
      id: obsId,
      type: 'serviceTask',
      name: last ? 'Final Observation' : `Observe ${k}`,
      col: at(),
      props: { timer: { dateField: `obsDate${k}` }, templateFields: obsFields(k) },
    });
    linkTo(obsId);
    const mk = marginCheck(k, obsId);
    cont = [{ from: mk.gw, extra: { name: 'Covered', cond: covered } }, { from: mk.ok }];

    // The coupon this period (phoenix: only above the barrier; memory catches up missed ones).
    if (p.productType === 'phoenix') {
      const gw = `GW_Coupon${k}`,
        on = `Task_CouponOn${k}`,
        off = `Task_CouponOff${k}`;
      const c = at();
      nodes.push(
        { id: gw, type: 'exclusiveGateway', name: `Coupon ${k} barrier met?`, col: c },
        {
          id: on,
          type: 'serviceTask',
          name: memory ? `Coupon ${k} Due (with memory)` : `Coupon ${k} Due`,
          col: c + 1,
          props: {
            templateFields: [
              field('cpn', 'Decimal', { formula: memory ? `${pct(rate)} * (missed + 1)` : pct(rate) }),
              ...(memory ? [field('missed', 'Decimal', { formula: '0' })] : []),
            ],
          },
        },
        {
          id: off,
          type: 'serviceTask',
          name: `No Coupon ${k}`,
          col: c + 1,
          row: 1,
          props: {
            templateFields: [
              field('cpn', 'Decimal', { formula: '0' }),
              ...(memory ? [field('missed', 'Decimal', { formula: 'missed + 1' })] : []),
            ],
          },
        },
      );
      linkTo(gw);
      flow(gw, on, { name: 'Barrier met', cond: atLeast(k, p.couponBarrierPct!) });
      flow(gw, off, { name: 'Missed', isDefault: true });
      col0 += 1;
      cont = [{ from: on }, { from: off }];
    }

    if (!last) {
      if (use.autocall && k >= acFrom) {
        const gw = `GW_Autocall${k}`;
        nodes.push({ id: gw, type: 'exclusiveGateway', name: `Autocall at ${k}?`, col: at() });
        linkTo(gw);
        const s = settle(k, 'Call', `${cpnExpr} + ${redeemPerUnit(k)}`, { final: true });
        flow(gw, s.due, { name: 'Autocall', cond: atLeast(k, p.autocallLevelPct!) });
        cont = [{ from: gw, extra: { name: 'Continue', isDefault: true } }];
      }
      if (p.productType === 'phoenix') {
        const gw = `GW_HasCoupon${k}`;
        nodes.push({ id: gw, type: 'exclusiveGateway', name: `Coupon ${k} due?`, col: at() });
        linkTo(gw);
        const s = settle(k, '', 'cpn', { final: false });
        flow(gw, s.due, { name: 'Coupon', cond: 'cpn > 0' });
        cont = [{ from: s.pay }, { from: gw, extra: { name: 'None', isDefault: true } }];
      } else if (p.productType === 'fcn' || p.productType === 'reverse-convertible') {
        const s = settle(k, '', pct(rate), { final: false });
        linkTo(s.due);
        cont = [{ from: s.pay }];
      }
      continue;
    }

    // ---- Maturity ---------------------------------------------------------
    if (p.productType === 'ppn') {
      const s = settle(n, 'Mat', `${pct(p.protectionPct!)} + ${pct(p.participationPct!)} * max(${ratio(n)} - 1, 0)`, {
        final: true,
      });
      linkTo(s.due);
      continue;
    }
    if (p.productType === 'snowball') {
      const gw = 'GW_FinalAutocall';
      nodes.push({ id: gw, type: 'exclusiveGateway', name: 'Called at maturity?', col: at() });
      linkTo(gw);
      const s = settle(n, 'Call', redeemPerUnit(n), { final: true });
      flow(gw, s.due, { name: 'Above autocall level', cond: atLeast(n, p.autocallLevelPct!) });
      cont = [{ from: gw, extra: { name: 'Below autocall level', isDefault: true } }];
    }
    const gw = 'GW_KnockIn';
    nodes.push({ id: gw, type: 'exclusiveGateway', name: 'Above knock-in barrier?', col: at() });
    linkTo(gw);
    const par = settle(n, 'Par', `${cpnExpr} + 1`, { final: true });
    flow(gw, par.due, { name: 'At or above barrier', cond: atLeast(n, p.knockInBarrierPct!) });
    if (!physical) {
      const ki = settle(n, 'KI', `${cpnExpr} + ${ratio(n)}`, { final: true });
      flow(gw, ki.due, { name: 'Knocked in', isDefault: true });
    } else if (!basket) {
      const u = unds[0];
      const ki = settle(n, 'KI', cpnExpr, { final: true, deliver: { sym: u.symbol, perUnit: '1 / initialLevel' } });
      flow(gw, ki.due, { name: 'Knocked in: deliver', isDefault: true });
    } else {
      // The worst performer is the one whose ratio equals perfN (same on-chain arithmetic, so exact).
      const worst = 'GW_Worst';
      nodes.push({ id: worst, type: 'exclusiveGateway', name: 'Which is the worst performer?', col: at() });
      flow(gw, worst, { name: 'Knocked in', isDefault: true });
      unds.forEach((u, i) => {
        const ki = settle(n, `KI${u.symbol}`, cpnExpr, {
          final: true,
          deliver: { sym: u.symbol, perUnit: `1 / initialLevel_${u.symbol}` },
        });
        const lastU = i === unds.length - 1;
        flow(
          worst,
          ki.due,
          lastU
            ? { name: `${u.symbol} worst`, isDefault: true }
            : { name: `${u.symbol} worst`, cond: `perf${n} == obs${n}_${u.symbol} / initialLevel_${u.symbol}` },
        );
      });
    }
  }

  // ---- Issuer: pre-trade terms, collateral, funding windows ----------------
  const label = PRODUCT_LABELS[p.productType];
  const terms = [
    'notional > 0',
    'grace >= 0',
    `grace <= ${MAX_GRACE_DAYS * SECONDS_PER_DAY}`,
    'lag >= 0',
    'collateralRatio >= 0',
    ...col.flatMap((c) => [
      `${haircutField(c.symbol)} >= 0`,
      `${haircutField(c.symbol)} <= 1`,
      `${pledgeField(c.symbol)} >= 0`,
    ]),
    'strikeDate < obsDate1',
    // Each period settles (payment date + grace) before the next observation.
    ...Array.from({ length: n - 1 }, (_, i) => `${fundUntil(i + 1)} <= obsDate${i + 2}`),
  ].join(' and ');
  const pretrade: TemplateField[] = [
    field('isin', 'Text'),
    field('notional', 'Decimal'),
    field('strikeDate', 'Date'),
    ...Array.from({ length: n }, (_, i) => field(`obsDate${i + 1}`, 'Date')),
    field('lag', 'Int'),
    field('grace', 'Int'),
    field('collateralRatio', 'Decimal'),
    ...col.flatMap((c) => [field(haircutField(c.symbol), 'Decimal'), field(pledgeField(c.symbol), 'Decimal')]),
    // Each period's funding window closes at its payment date + grace.
    ...Array.from({ length: n }, (_, i) =>
      field(fundUntil(i + 1), 'Date', { formula: `obsDate${i + 1} + lag + grace` }),
    ),
  ];
  const intoEscrow = (asset: string, amount: string): AssetOperation[] => [
    { assetId: asset, operation: 'deposit', params: { amountSource: 'field', amountField: amount } },
    {
      assetId: asset,
      operation: 'transfer',
      params: { from: ISSUER, to: ESCROW, amountSource: 'field', amountField: amount },
    },
  ];
  const windows: SpecNode[] = [
    ...Array.from({ length: n }, (_, i): SpecNode => ({
      id: `Task_Fund${i + 1}`,
      type: 'userTask',
      name: `Fund Payment ${i + 1}`,
      col: 5,
      row: i,
      props: {
        until: { dateField: fundUntil(i + 1) },
        milestone: 'funding-deposited',
        templateFields: [field('fundAmount', 'Decimal')],
        assetOperations: intoEscrow('cash', 'fundAmount'),
      },
    })),
    ...col.map((c, i): SpecNode => ({
      id: `Task_TopUp_${c.symbol}`,
      type: 'userTask',
      name: `Top Up Collateral ${collateralTokenOf(p, c.symbol)!.token}`,
      col: 5,
      row: n + i,
      props: {
        until: { dateField: 'closedAt' },
        milestone: 'collateral-pledged',
        templateFields: [field(topUpField(c.symbol), 'Decimal')],
        assetOperations: intoEscrow(colAsset(c.symbol), topUpField(c.symbol)),
      },
    })),
    ...(physical
      ? unds.map((u, i): SpecNode => ({
          id: `Task_FundDelivery_${u.symbol}`,
          type: 'userTask',
          name: `Fund Delivery ${deliverableToken(p, u.symbol)!.token}`,
          col: 5,
          row: n + col.length + i,
          props: {
            until: { dateField: fundUntil(n) },
            milestone: 'funding-deposited',
            templateFields: [field(`fundDelivery_${u.symbol}`, 'Decimal')],
            assetOperations: intoEscrow(deliverAsset(u.symbol), `fundDelivery_${u.symbol}`),
          },
        }))
      : []),
  ];
  for (let k = 1; k <= n; k++)
    if (firstSettle[k]) messages.push({ id: `MF_Fund${k}`, src: `Task_Fund${k}`, tgt: firstSettle[k], notice: true });
  const issuerFlows: SpecFlow[] = [
    ...chain('I_F', 'Start_Issuer', 'Task_ApproveTerms', 'Task_CheckTerms', 'Task_Mandate', 'GW_Windows'),
    ...windows.flatMap((w, i): SpecFlow[] => [
      { id: `I_W${i + 1}`, src: 'GW_Windows', tgt: w.id },
      { id: `I_C${i + 1}`, src: w.id, tgt: 'GW_WindowsClosed' },
    ]),
    { id: 'I_End', src: 'GW_WindowsClosed', tgt: 'End_Issuer' },
  ];

  const spec: BuildSpec = {
    key: 'SP',
    name: p.name,
    pools: [
      {
        id: 'Part_Issuer',
        name: ISSUER,
        proc: 'Proc_Issuer',
        nodes: [
          { id: 'Start_Issuer', type: 'startEvent', name: 'Offer Drafted', col: 0 },
          // Pre-trade: this issuance's terms; the collateral is pledged (deposited and locked in escrow) now.
          {
            id: 'Task_ApproveTerms',
            type: 'userTask',
            name: 'Approve Terms + Pledge Collateral',
            col: 1,
            props: {
              templateFields: pretrade,
              milestone: 'collateral-pledged',
              assetOperations: col.flatMap((c) => intoEscrow(colAsset(c.symbol), pledgeField(c.symbol))),
            },
          },
          { id: 'Task_CheckTerms', type: 'serviceTask', name: 'Check Terms', col: 2, props: { receiveGuard: terms } },
          { id: 'Task_Mandate', type: 'userTask', name: 'Mandate Paying Agent', col: 3 },
          { id: 'GW_Windows', type: 'parallelGateway', name: 'Open funding windows', col: 4 },
          ...windows,
          { id: 'GW_WindowsClosed', type: 'parallelGateway', name: 'All windows closed', col: 6 },
          { id: 'End_Issuer', type: 'endEvent', name: 'Funding Closed', col: 7 },
        ],
        flows: issuerFlows,
      },
      { id: 'Part_PayingAgent', name: PA, proc: 'Proc_PayingAgent', nodes, flows },
      {
        id: 'Part_Investor',
        name: INVESTOR,
        proc: 'Proc_Investor',
        open: true,
        nodes: [
          { id: 'Recv_Offer', type: 'receiveTask', name: 'Offer Listed', col: 4 },
          // The subscription book: anyone, any number of times, until the strike date. The stablecoin goes to
          // the issuer (the funds the note raises); the investor receives units, atomically.
          {
            id: 'Task_Subscribe',
            type: 'userTask',
            name: 'Subscribe',
            col: 5,
            props: {
              until: { dateField: 'strikeDate' },
              templateFields: [field('units', 'Decimal')],
              assetOperations: [
                {
                  assetId: 'cash',
                  operation: 'deposit',
                  params: { amountSource: 'expr', amountExpr: `units * ${issuePrice}` },
                },
                {
                  assetId: 'note',
                  operation: 'swap',
                  params: {
                    deliveryParty: ISSUER,
                    paymentParty: INVESTOR,
                    amountSource: 'field',
                    amountField: 'units',
                    counterAssetId: 'cash',
                    counterAmountSource: 'expr',
                    counterAmountExpr: `units * ${issuePrice}`,
                  },
                },
              ],
            },
          },
          { id: 'End_Investor', type: 'endEvent', name: 'Book Closed', col: 6 },
        ],
        flows: chain('V_F', 'Recv_Offer', 'Task_Subscribe', 'End_Investor'),
      },
      { id: 'Part_Escrow', name: ESCROW, proc: 'Proc_Escrow', nodes: [], flows: [], escrow: true },
    ],
    messages: [
      { id: 'MF_Mandate', src: 'Task_Mandate', tgt: 'Recv_Mandate' },
      { id: 'MF_Offer', src: 'Task_IssueNote', tgt: 'Recv_Offer' },
      ...messages,
    ],
    assets,
  };
  // Email notifications on the payment cycle (notify.ts): declared on the BPMN, compiled into META only.
  for (const pool of spec.pools)
    for (const n of pool.nodes) {
      const notify = productNotifications(n.id);
      if (notify) n.props = { ...(n.props ?? {}), notify };
    }
  const built = buildWorkflow(spec);
  const layout = Object.fromEntries(
    spec.pools.flatMap((pl) => pl.nodes.map((nd) => [nd.id, { col: nd.col ?? 0, row: nd.row ?? 0 }])),
  );
  return {
    ...built,
    layout,
    id: `product-${p.productType}`,
    name: p.name,
    params: p,
    description: `${label} on ${underlyingLabel(p)}: ${n} observation${n > 1 ? 's' : ''} per issuance; investors subscribe in USDG until the strike date and the issuer receives the funds; the issuer pledges ${col.map((c) => collateralTokenOf(p, c.symbol)!.token).join(', ')} collateral (ratio set per issuance) and funds each payment before its date (${eco.settlementLagDays} days after the observation, ${eco.gracePeriodDays} days' grace), or the collateral goes to the holders. Chainlink CRE fixes the strike and observes from the ${unds.map((u) => `${u.symbol}/USD`).join(', ')} feed${basket ? 's' : ''}. Pools: Issuer, Paying Agent, Investor, Escrow.`,
  };
}

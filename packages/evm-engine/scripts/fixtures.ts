/**
 * Fixtures for test/Products.t.sol: every structured product, compiled by packages/core, driven along a price
 * path with the issuer in the loop (pledging collateral, funding each payment, topping up a margin call, or
 * not), and what every holder must end up with according to the REFERENCE model
 * (packages/core/src/products/payoff.ts: simulatePerf for the payoff, simulateNote for funding and default).
 *
 * Each run is a timeline of actions (CRE reports, keeper advances, issuer funding and top-ups, a transfer)
 * the Foundry test replays at their block times. ABI-encoded as the `Fixture` struct in test/Products.t.sol,
 * written to test/fixtures/products.json. Run: npm run fixtures (from packages/evm-engine).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, toHex } from 'viem';
import {
  collateralTokenOf, compile, compileTemplate, dec, deliverableToken, economicsOf, EXAMPLE_PRODUCTS, EXAMPLE_WORST_OF, evmInput, FEEDS, instantiateProduct, parseBpmn,
  SEED_TEMPLATES, simulateNote, SRC, type Compiled, type IssuerBehaviour, type ProductParams, type ProductType, type TemplateSource,
} from '@sn/core';

/** Block time the Foundry test starts each run at (fixed, so dates can be baked in). */
export const T0 = 1_900_000_000;
const LAG = 10, GRACE = 20, STEP = 100;
const STRIKES: Record<string, number> = { ETH: 2000, BTC: 60000, SOL: 150, AMZN: 200, TSLA: 250 };
/** The mock tokens test/Products.t.sol deploys for the real ones the notes name (USDG, WETH, Robinhood's AMZN and
 * TSLA), with the same decimals. */
const TOKEN_ID: Record<string, number> = { USDG: 1, WETH: 2, AMZN: 3, TSLA: 4 };
const DECIMALS: Record<number, number> = { 1: 6, 2: 18, 3: 18, 4: 18 };
/** The mock token a delivered underlying or a collateral symbol uses on the note's chain. */
const deliverId = (p: ProductParams, sym: string) => TOKEN_ID[deliverableToken(p, sym)!.token];
const collateralId = (p: ProductParams, sym: string) => TOKEN_ID[collateralTokenOf(p, sym as 'USD')!.token];

interface Run {
  type: ProductType; path: number[] | number[][]; investors: number[]; transfer?: number; params?: ProductParams;
  /** The reference payoff's term sheet when it differs from the workflow's basis (custom templates). */
  refParams?: ProductParams;
  source?: TemplateSource; paFee?: number; unsold?: number; label?: string;
  behaviour?: IssuerBehaviour;
  /** Collateral price path by symbol, as a % of its price at the strike (index 0 = strike, k = observation k). */
  colPath?: Record<string, number[]>;
  /** Pledge multiple of the requirement (1 = exactly covered). */
  pledgeCover?: number;
  /** Fund each payment in two deposits. */
  split?: boolean;
}
const seed = (part: string) => SEED_TEMPLATES.find(t => t.name.includes(part))!.source;
const ETH_BTC: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, name: '12M Worst-of FCN on ETH, BTC', underlyings: [FEEDS.ETH, FEEDS.BTC] };
const PHYS_ETH: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, name: '12M FCN on ETH, physical', settlement: 'physical' };
const PHYS_BASKET: ProductParams = { ...EXAMPLE_PRODUCTS['reverse-convertible'], name: '12M Worst-of RC on ETH, AMZN, TSLA, physical', underlyings: [FEEDS.ETH, FEEDS.AMZN, FEEDS.TSLA], settlement: 'physical', chain: 'robinhood-testnet' };
const PHOENIX_NO_MEMORY: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, name: '12M Phoenix (no memory) on ETH', memory: false };
const ETH_COLLATERAL: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, name: '12M Phoenix on ETH, ETH collateral', collateral: [{ symbol: 'ETH', haircutPct: 70 }], collateralRatioPct: 50 };
const MIXED_COLLATERAL: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, name: '12M FCN on ETH, USD + ETH collateral', collateral: [{ symbol: 'USD', haircutPct: 100 }, { symbol: 'ETH', haircutPct: 70 }], collateralRatioPct: 40 };

const RUNS: Run[] = [
  { type: 'fcn', path: [90, 104, 0, 0], investors: [600, 400], split: true }, // autocalled at 2; each payment funded in two deposits
  { type: 'fcn', path: [90, 95, 80, 50], investors: [700, 300] }, // knocked in: cash-settled at 0.5
  { type: 'reverse-convertible', path: [95, 80, 75, 65], investors: [500, 500], unsold: 100 }, // 100 unsold units are cancelled at the strike
  { type: 'phoenix', path: [60, 65, 80, 75], investors: [250, 750], transfer: 100 }, // memory catches up at 3; part of a position changes hands
  { type: 'phoenix', params: PHOENIX_NO_MEMORY, path: [60, 65, 80, 75], investors: [500, 500] }, // no memory: missed coupons are lost
  { type: 'snowball', path: [90, 95, 99, 101], investors: [900, 100] }, // called at maturity
  { type: 'ppn', path: [130], investors: [400, 600] },
  // Worst-of: SOL misses the coupon barrier at 1; at 2 every asset is above 100%: two coupons (memory) and the call.
  { type: 'phoenix', params: EXAMPLE_WORST_OF, path: [[110, 120, 60], [105, 102, 101], [0, 0, 0], [0, 0, 0]], investors: [300, 700] },
  // Worst-of: ETH falls to 50% at maturity while BTC is fine: cash-settled on the worst performer.
  { type: 'fcn', params: ETH_BTC, path: [[95, 90], [90, 85], [80, 99], [50, 90]], investors: [600, 400] },
  // Seed template (custom workflow). Step-down: 96% at Q3 calls (level 95%), where the stock phoenix would not.
  // Along this path it pays as a phoenix calling at 95%: 2.5% at 1, 2 and 3, then 1 at the call.
  { type: 'phoenix', source: seed('Step-down'), params: seed('Step-down').basis, refParams: { ...seed('Step-down').basis!, autocallLevelPct: 95 }, path: [80, 90, 96, 0], investors: [500, 500] },
  // Physical delivery: knocked in, each holder receives units / strike of ETH (single, as WETH) or of the worst performer (TSLA here, Robinhood's token on Robinhood Chain).
  { type: 'fcn', params: PHYS_ETH, path: [90, 95, 80, 50], investors: [700, 300] },
  { type: 'reverse-convertible', params: PHYS_BASKET, path: [[95, 90, 92], [90, 85, 80], [80, 99, 75], [90, 95, 55]], investors: [400, 600] },
  // Servicing fee: investors get the plain phoenix payoff; the paying agent collects 0.1% of 1,000 with each of the 2 coupons paid.
  { type: 'phoenix', source: seed('servicing fee'), params: seed('servicing fee').basis, path: [60, 65, 80, 75], investors: [500, 500], paFee: 2 },
  // ---- The issuer in the loop -------------------------------------------------------------------------------
  // Misses the coupon due at 3: the grace period ends unfunded and the collateral goes to the holders.
  { type: 'phoenix', label: 'misses coupon 3 -> default', path: [60, 65, 80, 75], investors: [250, 750], behaviour: { missPayment: 3 } },
  // Funds coupon 3 late, inside the grace period: paid, and the note runs to maturity.
  { type: 'phoenix', label: 'cures coupon 3 in grace', path: [60, 65, 80, 75], investors: [250, 750], behaviour: { curePayment: 3 } },
  // Knocked in at maturity and funds only half of the redemption: default; holders share the half and the collateral.
  { type: 'fcn', label: 'half-funds the redemption -> default', path: [90, 95, 80, 50], investors: [700, 300], behaviour: { partialPayment: { period: 4, fraction: 0.5 } } },
  // ETH collateral (70% haircut, 50% ratio): ETH falls 40% by observation 2 -> margin call, cured by a top-up.
  { type: 'phoenix', params: ETH_COLLATERAL, label: 'margin call cured', path: [80, 90, 96, 75], investors: [500, 500], colPath: { ETH: [100, 95, 60, 60, 60] }, pledgeCover: 1.2, behaviour: { marginCall: { period: 2, topUp: { ETH: 0.2 } } } },
  // The same, not cured: default at the end of grace; holders receive the ETH collateral in kind.
  { type: 'phoenix', params: ETH_COLLATERAL, label: 'margin call not cured -> default', path: [80, 90, 96, 75], investors: [500, 500], colPath: { ETH: [100, 95, 60, 60, 60] }, pledgeCover: 1.2, behaviour: { marginCall: { period: 2 } } },
  // Stablecoin + ETH collateral worth 1.2x; misses coupon 2. Default rule 'cap-at-owed': holders take the coupon
  // plus par (the stablecoin first, then ETH at its price), and the rest of the ETH goes back to the issuer.
  { type: 'fcn', params: MIXED_COLLATERAL, label: 'mixed collateral, misses coupon 2 -> default (capped)', path: [90, 95, 80, 50], investors: [600, 400], colPath: { ETH: [100, 100, 100, 100, 100] }, pledgeCover: 1.2, behaviour: { missPayment: 2 } },
  // The same under 'all-to-holders': both collateral assets go to the holders in kind, pro rata.
  { type: 'fcn', params: { ...MIXED_COLLATERAL, defaultRule: 'all-to-holders' }, label: 'mixed collateral, misses coupon 2 -> default (all to holders)', path: [90, 95, 80, 50], investors: [600, 400], colPath: { ETH: [100, 100, 100, 100, 100] }, pledgeCover: 1.2, behaviour: { missPayment: 2 } },
];

const paramsOf = (r: Run) => r.params ?? EXAMPLE_PRODUCTS[r.type];
const rows = (r: Run) => (r.path as Array<number | number[]>).map(x => (Array.isArray(x) ? x : [x]));
/** Base units of `x` tokens, rounded up; tokens with more than 10 decimals (WETH, stock tokens: 18) in whole engine
 * fixed-point steps (10 decimals). */
const ceilBase = (x: number, decimals: number) => (decimals <= 10
  ? BigInt(Math.ceil(x * 10 ** decimals - 1e-6))
  : BigInt(Math.ceil(x * 1e10 - 1e-6)) * 10n ** BigInt(decimals - 10));
const fromBase = (b: bigint, decimals: number) => Number(b) / 10 ** decimals;
/** The smallest amount the engine's 10-decimal ledger tells apart, in base units. */
const step = (decimals: number) => (decimals <= 10 ? 1n : 10n ** BigInt(decimals - 10));
/** Engine fixed point (10 decimals) of a token amount held in base units, as the engine floors it. */
const fixedOf = (b: bigint, decimals: number) => (decimals <= 10 ? b * 10n ** BigInt(10 - decimals) : b / 10n ** BigInt(decimals - 10));

const INPUT = { type: 'tuple[]', components: [{ name: 'tag', type: 'uint8' }, { name: 'data', type: 'bytes32' }] } as const;
const FIXTURE = [{
  type: 'tuple', components: [
    { name: 'name', type: 'string' },
    { name: 'def', type: 'bytes' },
    { name: 'tokenOf', type: 'uint8[]' },
    { name: 'startStep', type: 'uint16' },
    { name: 'approveStep', type: 'uint16' },
    { name: 'mandateStep', type: 'uint16' },
    { name: 'subscribeStep', type: 'uint16' },
    { name: 'fixStrikeStep', type: 'uint16' },
    { name: 'approveInputs', ...INPUT },
    { name: 'pledges', type: 'tuple[]', components: [{ name: 'token', type: 'uint8' }, { name: 'base', type: 'uint256' }] },
    { name: 'investorUnits', type: 'int256[]' },
    { name: 'investorCash', type: 'uint256[]' },
    { name: 'transferUnits', type: 'int256' },
    { name: 'actions', type: 'tuple[]', components: [
      { name: 'kind', type: 'uint8' }, { name: 'at', type: 'uint64' }, { name: 'step', type: 'uint16' },
      { name: 'token', type: 'uint8' }, { name: 'base', type: 'uint256' }, { name: 'inputs', ...INPUT }, { name: 'values', type: 'int256[]' },
    ] },
    { name: 'expected', type: 'int256[][]' },
    { name: 'issuerCollateral', type: 'int256[]' },
    { name: 'issuerProceeds', type: 'int256' },
    { name: 'paFee', type: 'int256' },
    { name: 'defaulted', type: 'bool' },
    { name: 'strikeAt', type: 'uint64' },
  ],
}] as const;

export const ACTION = { REPORT: 1, ADVANCE: 2, ISSUER_STEP: 3, TRANSFER: 4 } as const;
type Action = { kind: number; at: bigint; step: number; token: number; base: bigint; inputs: ReturnType<typeof evmInput.number>[]; values: bigint[] };

/** The oracle values a report carries, in the step's capture order, from a name -> price map. */
function reportValues(c: Compiled, step: string, prices: Record<string, number>): bigint[] {
  const s = c.def.steps[c.stepIndex[step]];
  return s.captures.filter(x => x.source === SRC.ORACLE).map(x => {
    const name = c.def.fields[x.field].name;
    if (!(name in prices)) throw new Error(`${step}: no price for ${name}`);
    return dec(prices[name].toFixed(8));
  });
}

function fixture(run: Run, idx: number) {
  const p = paramsOf(run);
  const eco = economicsOf(p);
  const c = run.source ? compileTemplate(run.source) : (() => {
    const prod = instantiateProduct(p);
    return compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
  })();
  const assets = run.source ? run.source.assets! : instantiateProduct(p).assets;
  const tokenOf = c.def.assets.map((a, i) => (a.kind === 0 ? 0 : TOKEN_ID[assets[i]?.token ?? 'USDG'] ?? TOKEN_ID.USDG));
  const assetIdx = (id: string) => assets.findIndex(a => a.id === id);
  const unds = p.underlyings;
  const basket = unds.length > 1;
  const strikes = unds.map(u => STRIKES[u.symbol]);
  const path = rows(run).map(r => r.map((x, i) => strikes[i] * x / 100));
  const sold = run.investors.reduce((a, b) => a + b, 0);
  const notional = sold + (run.unsold ?? 0);
  const n = p.observations;
  const strikeAt = T0 + 30;
  const obsAt = Array.from({ length: n }, (_, k) => strikeAt + STEP * (k + 1));

  // Collateral: the requirement is ratio x units sold; the issuer pledges `pledgeCover` times it (split evenly
  // across the collateral assets by value at the strike, after haircut).
  const ratio = eco.collateralRatioPct / 100;
  const colPx = (sym: string, k: number) => (sym === 'USD' ? 1 : STRIKES[sym] * (run.colPath?.[sym]?.[k] ?? 100) / 100);
  const required = ratio * sold * (run.pledgeCover ?? 1);
  const pledged = eco.collateral.map(cl => {
    const token = collateralId(p, cl.symbol);
    const amount = required / eco.collateral.length / (colPx(cl.symbol, 0) * cl.haircutPct / 100);
    const base = ceilBase(amount, DECIMALS[token]) + step(DECIMALS[token]);
    return { symbol: cl.symbol, token, base, amount: fromBase(base, DECIMALS[token]), haircut: cl.haircutPct / 100 };
  });

  // The reference: what each period owes, what is funded, what each unit receives.
  const perfs = path.map(r => Math.min(...r.map((o, i) => o / strikes[i])));
  const lastRatios = path[n - 1].map((o, i) => o / strikes[i]);
  const worst = lastRatios.indexOf(Math.min(...lastRatios));
  const behaviour = run.behaviour ?? {};
  const topUps: Record<string, number> = {};
  for (const [sym, amt] of Object.entries(behaviour.marginCall?.topUp ?? {})) {
    const token = collateralId(p, sym);
    topUps[sym] = fromBase(ceilBase(amt, DECIMALS[token]), DECIMALS[token]);
  }
  const ref = simulateNote(run.refParams ?? p, {
    perfs, sold, ratio,
    worstAtMaturity: p.settlement === 'physical' ? { symbol: unds[worst].symbol, strike: strikes[worst] } : undefined,
    collateral: pledged.map(x => ({ symbol: x.symbol, amount: x.amount, haircut: x.haircut, prices: Array.from({ length: n + 1 }, (_, k) => colPx(x.symbol, k)) })),
    behaviour: behaviour.marginCall ? { ...behaviour, marginCall: { period: behaviour.marginCall.period, ...(behaviour.marginCall.topUp ? { topUp: topUps } : {}) } } : behaviour,
    feePerCoupon: run.paFee ? notional / 1000 : undefined,
  });

  // Pre-trade inputs, by name, in the step's input order.
  const approve = c.def.steps[c.stepIndex.Task_ApproveTerms];
  const inputsByName: Record<string, ReturnType<typeof evmInput.number>> = {
    isin: evmInput.text(`XS${String(idx).padStart(10, '0')}`), notional: evmInput.number(dec(notional)),
    strikeDate: evmInput.number(BigInt(strikeAt)), lag: evmInput.number(BigInt(LAG)), grace: evmInput.number(BigInt(GRACE)),
    collateralRatio: evmInput.number(dec(ratio.toFixed(10))),
    ...Object.fromEntries(obsAt.map((t, k) => [`obsDate${k + 1}`, evmInput.number(BigInt(t))])),
    ...Object.fromEntries(pledged.flatMap(x => [
      [`haircut_${x.symbol}`, evmInput.number(dec(x.haircut.toFixed(10)))],
      [`pledge_${x.symbol}`, evmInput.number(fixedOf(x.base, DECIMALS[x.token]))],
    ])),
  };
  const approveInputs = approve.captures.filter(x => x.source === SRC.INPUT).map(x => {
    const name = c.def.fields[x.field].name;
    if (!inputsByName[name]) throw new Error(`${p.name}: no pre-trade input for ${name}`);
    return inputsByName[name];
  });

  // The timeline.
  const actions: Action[] = [];
  const at = (t: number) => BigInt(t);
  const prices = (k: number): Record<string, number> => {
    const out: Record<string, number> = {};
    unds.forEach((u, i) => { out[basket ? (k === 0 ? `initialLevel_${u.symbol}` : `obs${k}_${u.symbol}`) : (k === 0 ? 'initialLevel' : `obs${k}`)] = k === 0 ? strikes[i] : path[k - 1][i]; });
    for (const x of pledged) if (x.symbol !== 'USD') out[`px_${x.symbol}`] = colPx(x.symbol, k);
    return out;
  };
  const issuerStep = (t: number, step: string, token: number, base: bigint, amountFixed: bigint): Action =>
    ({ kind: ACTION.ISSUER_STEP, at: at(t), step: c.stepIndex[step], token, base, inputs: [evmInput.number(amountFixed)], values: [] });
  const advance = (t: number): Action => ({ kind: ACTION.ADVANCE, at: at(t), step: 0xffff, token: 0, base: 0n, inputs: [], values: [] });
  // Exact amounts (whole micro-dollars here), so nothing is left in escrow to blur a default's pro rata.
  const fund = (t: number, k: number, total: number) => {
    const base = ceilBase(total, 6);
    if (run.split) {
      const half = base / 2n;
      actions.push(issuerStep(t, `Task_Fund${k}`, 1, half, fixedOf(half, 6)), issuerStep(t + 1, `Task_Fund${k}`, 1, base - half, fixedOf(base - half, 6)));
    } else actions.push(issuerStep(t, `Task_Fund${k}`, 1, base, fixedOf(base, 6)));
  };

  actions.push({ kind: ACTION.REPORT, at: at(strikeAt), step: c.stepIndex.Task_FixStrike, token: 0, base: 0n, inputs: [], values: reportValues(c, 'Task_FixStrike', prices(0)) });
  if (run.transfer) actions.push({ kind: ACTION.TRANSFER, at: at(strikeAt + 1), step: 0, token: 0, base: 0n, inputs: [evmInput.number(dec(run.transfer))], values: [] });
  const last = ref.defaulted ? ref.defaulted.period : (ref.calls.at(-1)?.period ?? n);
  for (let k = 1; k <= last; k++) {
    const t = obsAt[k - 1];
    const call = ref.calls.find(x => x.period === k);
    // Early funding: the issuer prefunds before the observation (it knows the path in this test).
    if (call && call.outcome === 'paid') {
      fund(t - 5, k, call.total);
      if (call.deliver) {
        const token = deliverId(p, call.deliver.symbol);
        const base = ceilBase(call.deliver.perUnit * sold, DECIMALS[token]) + step(DECIMALS[token]);
        actions.push(issuerStep(t - 4, `Task_FundDelivery_${call.deliver.symbol}`, token, base, fixedOf(base, DECIMALS[token])));
      }
    }
    if (call && behaviour.partialPayment?.period === k) fund(t - 5, k, call.total * behaviour.partialPayment.fraction);
    const stepId = `Task_Observe${k}`;
    actions.push({ kind: ACTION.REPORT, at: at(t), step: c.stepIndex[stepId], token: 0, base: 0n, inputs: [], values: reportValues(c, stepId, prices(k)) });
    const cov = ref.coverage.find(x => x.period === k);
    if (cov && !cov.met) {
      if (cov.cured) {
        for (const [sym, amt] of Object.entries(topUps)) {
          const token = collateralId(p, sym);
          const base = ceilBase(amt, DECIMALS[token]);
          actions.push(issuerStep(t + 3, `Task_TopUp_${sym}`, token, base, fixedOf(base, DECIMALS[token])));
        }
      } else {
        actions.push(advance(t + GRACE + 1)); // the grace period ends without a top-up: default
        break;
      }
    }
    if (!call) continue;
    actions.push(advance(t + LAG)); // payment date: paid if funded, else the grace period starts
    if (call.outcome === 'cured') fund(t + LAG + 5, k, call.total);
    if (call.outcome === 'missed') actions.push(advance(t + LAG + GRACE + 1)); // grace ends unfunded: default
  }

  // What each holder must hold at the end (engine fixed point), per asset 1..: cash, deliverables, collateral.
  const holders = run.investors.map(u => u);
  if (run.transfer) { holders[0] -= run.transfer; holders.push(run.transfer); }
  const expected = holders.map(u => c.def.assets.map((_, a) => {
    const id = assets[a]?.id ?? '';
    if (a === 0) return 0n;
    if (id === 'cash') return dec((u * ref.perUnit.cash).toFixed(10));
    if (id.startsWith('d_')) return dec((u * (ref.perUnit.deliver[id.slice(2)] ?? 0)).toFixed(10));
    if (id.startsWith('col_')) return dec((u * (ref.perUnit.collateral[id.slice(4)] ?? 0)).toFixed(10));
    return 0n;
  }));
  const issuerCollateral = c.def.assets.map((_, a) => {
    const id = assets[a]?.id ?? '';
    return id.startsWith('col_') ? dec((ref.released[id.slice(4)] ?? 0).toFixed(10)) : 0n;
  });
  const value = {
    name: run.label ? `${p.name}: ${run.label}` : p.name,
    def: toHex(c.bytes),
    tokenOf,
    startStep: c.stepIndex.Start_Issuer,
    approveStep: c.stepIndex.Task_ApproveTerms,
    mandateStep: c.stepIndex.Task_Mandate,
    subscribeStep: c.stepIndex.Task_Subscribe,
    fixStrikeStep: c.stepIndex.Task_FixStrike,
    approveInputs,
    pledges: pledged.map(x => ({ token: x.token, base: x.base })),
    investorUnits: run.investors.map(u => dec(u)),
    investorCash: run.investors.map(u => ceilBase(u * p.issuePricePct / 100, 6)),
    transferUnits: dec(run.transfer ?? 0),
    actions,
    expected,
    issuerCollateral,
    issuerProceeds: dec((sold * p.issuePricePct / 100).toFixed(10)),
    paFee: dec((ref.fees).toFixed(10)),
    defaulted: !!ref.defaulted,
    strikeAt: BigInt(strikeAt),
  };
  if (assetIdx('cash') !== 1) throw new Error('cash must be asset 1');
  return encodeAbiParameters(FIXTURE, [value]);
}

const out = fileURLToPath(new URL('../test/fixtures/products.json', import.meta.url));
const runs = RUNS.map(fixture);
writeFileSync(out, JSON.stringify({ t0: T0, runs }, null, 1) + '\n');
console.log(`${runs.length} product runs -> ${out}`);

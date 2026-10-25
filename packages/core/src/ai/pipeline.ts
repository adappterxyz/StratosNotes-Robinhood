/**
 * The AI leg (Flow's ai/router.ts + pipeline.ts, for StratosNotes):
 *   route with the decision model (Clef) -> clarify | product | edit | answer
 *  - product: required terms are checked first; missing ones become a
 *    question, never an invented number. The model fills ProductParams for a
 *    verified payoff engine; the issuer reviews them in the issue form.
 *  - edit: the open workflow goes to the model as a draft; it answers with a
 *    patch; the real validator + compiler check the result and their errors go
 *    back for repair (bounded). The BPMN is laid out deterministically.
 */
import type { AiRunner, ChatMessage, DecisionQuestion } from './runner';
import { extractProduct, type Schedule } from './extract';
import { PRODUCT_LABELS, productUses, type ProductParams, type ProductType } from '../products/params';
import { applyPatch, draftToIR, irToBpmn, type DraftPatch, type WorkflowDraft } from '../draft';
import { check } from '../validate';

export type Intent = 'product' | 'edit' | 'question';
export const CONFIDENCE_FLOOR = 0.55;

export type AiResult =
  | { kind: 'reply'; reply: string }
  | { kind: 'clarify'; reply: string; missing: string[] }
  | { kind: 'product'; params: ProductParams; schedule: Schedule; notes: string[] }
  | { kind: 'workflow'; bpmnXml: string; draft: WorkflowDraft; warnings: string[]; changed: string[] }
  | { kind: 'error'; error: string };

const INTENTS: Record<Intent, string> = {
  product:
    'Design or issue a structured note from terms: fixed coupon note, autocallable, phoenix, snowball, reverse convertible or principal-protected note',
  edit: 'Change the note or workflow that is open: how or when it pays (bonuses, fees, coupons, redemption), its steps, fields, conditions, dates or rules, e.g. "when it autocalls pay an extra 1%", "add a fee", "observe monthly"',
  question: 'Ask how something works or for an explanation or advice; or just chat. Nothing should be built or changed',
};
const PRODUCTS: Record<ProductType, string> = {
  fcn: 'Fixed coupon note: a fixed coupon every period, may autocall, knock-in at maturity',
  'reverse-convertible': 'Reverse convertible: fixed coupon, no autocall, loss below a barrier at maturity',
  phoenix: 'Phoenix: coupon paid only when the underlying is above a coupon barrier, optional memory, autocall',
  snowball: 'Snowball: coupons accrue and are paid only when the note is called',
  ppn: 'Principal-protected note: capital protection plus participation in the rise, no coupons',
};

function termQuestions(t: ProductType): Array<[string, string, string]> {
  const use = productUses(t);
  const q: Array<[string, string, string]> = [
    [
      'underlying',
      'the underlying',
      'Is a specific token, stock or index named in the request (e.g. "ETH", "Bitcoin", "SOL")?',
    ],
    [
      'tenor',
      'the tenor or the observation schedule',
      'Does the request state the tenor, maturity or how often it is observed (e.g. "12 months", "quarterly")?',
    ],
  ];
  if (use.coupon) q.push(['coupon', 'the coupon rate', 'Does the request state a coupon rate?']);
  if (use.couponBarrier)
    q.push([
      'couponBarrier',
      'the coupon barrier',
      'Does the request state a coupon barrier level (a % of the initial level)?',
    ]);
  if (use.autocall)
    q.push(['autocall', 'the autocall level', 'Does the request state an autocall or early-redemption level?']);
  if (use.knockIn)
    q.push([
      'knockIn',
      'the knock-in barrier',
      'Does the request state a knock-in, protection or downside barrier level?',
    ]);
  if (use.protection)
    q.push(
      ['protection', 'the capital protection level', 'Does the request state how much capital is protected?'],
      ['participation', 'the participation rate', 'Does the request state a participation rate in the upside?'],
    );
  // The note is secured by collateral the issuer pledges: never assumed.
  q.push([
    'collateral',
    'the collateral (what the issuer pledges, e.g. USDG or ETH, and the share of the notional it must cover)',
    'Does the request say what collateral the issuer pledges or what share of the notional the collateral must cover (e.g. "secured by USDG at 100%", "50% collateral in ETH")?',
  ]);
  return q;
}

const list = (xs: string[]) =>
  xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

export const BRIEF = `You are the StratosNotes assistant. Answer briefly and concretely, only from these facts; if the answer is not covered, say so rather than guess.
StratosNotes issues structured notes on Robinhood Chain testnet (EVM, an Arbitrum Orbit chain): notes run on Robinhood Chain, where every note's lifecycle runs and its collateral is held. A note is a way for the issuer to raise funds against pledged collateral. It is a BPMN workflow with four pools:
- Issuer: approves this issuance's terms (size, dates, settlement lag, grace period of 0-7 days, collateral ratio, haircuts) and pledges collateral (USDG, or tokens such as ETH valued by Chainlink after a haircut) into escrow; funds each payment through a "Fund Payment k" window before its payment date; can top up collateral at any time.
- Paying Agent (the calculation agent, Chainlink CRE): fixes the strike, observes on each date, checks the collateral covers the required share of the notional (else a margin call: top up within the grace period or default), and on each payment date pays holders from escrow if the issuer funded it; unfunded, a grace period runs, then default.
- Investor (open to anyone): subscribes with USDG until the strike date; the USDG goes to the issuer (the funds raised) and the investor receives note units in one atomic swap.
- Escrow: an account the engine holds for the note; nobody can withdraw from it. On default, everything in escrow (collateral in kind and any partial funding) goes to the holders pro rata; after the final payment, the collateral is released to the issuer.
Chainlink CRE delivers each observation from a Chainlink price feed as a signed report through Chainlink's forwarder.
Products: fixed coupon note, reverse convertible, phoenix (optional memory), snowball, principal-protected note. Underlyings with feeds here: ETH, BTC, SOL (Chainlink on Ethereum), TSLA, AMZN, AMD, PLTR, NVDA, AAPL, SPY, META, MSFT, GOOGL, COIN (Chainlink on Robinhood Chain). Settlement in cash, or physical delivery below the knock-in barrier of the underlying's real token on Robinhood Chain: Robinhood's TSLA, AMZN, AMD and PLTR stock tokens and WETH for ETH; BTC, SOL and the other stocks are cash-settled. Collateral: USDG, WETH, TSLA, AMZN, AMD or PLTR, pledged into the note on Robinhood Chain (nothing is bridged).
Issuers can also edit a note's workflow in the studio (steps, fields, gateway conditions such as "obs2 >= initialLevel * 100 / 100", timers, payments) before publishing it; every payment stays funded from escrow.`;

const EDIT_RULES = `You edit a StratosNotes workflow (it runs on an EVM engine). The workflow is JSON: parties (pools), assets, steps.
The note's economics are part of the workflow and must survive every edit:
- "Escrow" is an escrow party (listed in "escrow"): it has no steps. Collateral and funded payments sit there.
- Payments to holders and fees are paid FROM Escrow ("payer": "Escrow", or a transfer "from": "Escrow"), never from the Issuer, and only after a funding check: a "Payment Date k" step (timerField "payDate") computing "due" and "dueTotal", then a "Funded?" decision whose branch tests balance(Escrow, cash) >= dueTotal, with a default branch to "Payment k Missed" -> "Grace k" -> "Cured in grace?" -> pay or the shared "Task_Default".
- The Issuer funds through "Fund Payment k" windows (tasks with untilField) that deposit and move cash into Escrow; "Top Up Collateral" windows do the same for collateral.
- Never remove or bypass: funding windows, Payment Date / Funded? / Missed / Grace / Cured steps, margin checks, Task_Default (default: escrow to holders) or Task_Release (collateral back to the issuer). Never change "milestone" on a step.
- A new payment (a bonus, a fee) is added to an existing payment step's "ops" (paid from Escrow), and its amount is added to "dueTotal" in that period's "Payment Date" step, so the issuer funds it and "Funded?" checks it. E.g. a 0.1% fee to the paying agent: on the Payment Date step {"name":"fee","type":"Decimal","formula":"notional * 1 / 1000"} and dueTotal "due * sold + fee"; on the pay step {"assetId":"cash","operation":"transfer","params":{"from":"Escrow","to":"Paying Agent","amountSource":"field","amountField":"fee"}}.
Step kinds: "start"; "task" (a person in that pool acts, may enter fields); "auto" (runs by itself: payments, formula fields, or price observations); "receive" (waits for another pool's message); "decision" (exclusive gateway: "branches", either all but one with a "condition" plus one default, or none so a person picks); "parallel"; "end".
Links: "next" (same pool), "branches" (decisions), "sendTo" (step ids in OTHER pools). Every path ends in an "end".
Fields: {name, type: Decimal|Int|Date|Text|Party|Bool}; add "formula" (e.g. "missed1 + 1") for computed fields, or "oracle": {feed, feedChain, min, max} for a Chainlink price observed by CRE (only on "auto" steps). Field names are camelCase and shared by all pools.
Timers: "timerField" (a Date field: the step waits for it). "untilField" on a "task": anyone may repeat it until that date (a subscription book).
Payments ("ops", applied in order): {assetId, operation, params}. operation: "deposit" (USDG from the person running the task; params.amountSource "field"|"expr" with amountField/amountExpr), "mint" (params.owner = pool name), "transfer" (params.from and params.to are POOL names; params.amountSource "expr", params.amountExpr = the TOTAL amount), "swap" (deliveryParty, paymentParty, counterAssetId, amounts), "distribute" (pays EVERY HOLDER of params.holdingAssetId, i.e. the investors: params.payer pays amountExpr PER UNIT held; params.retire true redeems the units).
Who gets paid decides the operation: investors/noteholders -> "distribute"; one named pool (the paying agent, a fee to someone) -> "transfer" with from/to. A fee "per unit" or "% of the notional" paid to one pool is a transfer of the total, from Escrow (see above).
Conditions and amounts are expressions over fields: + - * / and comparisons, "and"/"or", min(...), max(...), balance(Pool, asset) (an account's balance) and now (the time).
Reply with a patch: "upsert" new steps and every changed step written out in full (e.g. the step before an inserted one, with its new "next"), and "remove" ids of deleted steps. Keep ids of unchanged steps; do not repeat unchanged steps.`;

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    upsert: { type: 'array', items: { type: 'object', required: ['id', 'party', 'kind', 'name'] } },
    remove: { type: 'array', items: { type: 'string' } },
    parties: { type: 'array', items: { type: 'string' } },
  },
};

/** Steps that carry the note's economics: an edit may change them but never remove them. */
export const ECONOMIC_MILESTONES = [
  'funding-deposited',
  'collateral-pledged',
  'collateral-released',
  'defaulted',
  'payment-made',
  'payment-missed',
  'margin-call',
  'margin-cured',
] as const;

/** Problems with a patch that the validator would not name directly: economic steps it drops. */
export function economicLosses(base: WorkflowDraft, next: WorkflowDraft): string[] {
  const kept = new Set(next.steps.map((s) => s.id));
  const lost = base.steps.filter(
    (s) => s.milestone && (ECONOMIC_MILESTONES as readonly string[]).includes(s.milestone) && !kept.has(s.id),
  );
  const out = lost.map(
    (s) =>
      `Step ${s.id} ('${s.name}', ${s.milestone}) was removed: keep it; the note's funding, default and release steps must stay.`,
  );
  for (const s of base.steps) {
    const n = next.steps.find((x) => x.id === s.id);
    if (n && s.milestone && n.milestone !== s.milestone)
      out.push(`Step ${s.id} lost its milestone '${s.milestone}': keep it.`);
  }
  if ((base.escrow ?? []).some((e) => !next.parties.includes(e))) out.push('The Escrow party was removed: keep it.');
  return out;
}

export async function editWorkflow(
  ai: AiRunner,
  prompt: string,
  base: WorkflowDraft,
  maxRepairs = 3,
): Promise<AiResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: EDIT_RULES },
    { role: 'user', content: `Current workflow:\n${JSON.stringify(base)}\n\nChange requested:\n${prompt}` },
  ];
  let errors: string[] = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const patch = await ai.json<DraftPatch>(messages, PATCH_SCHEMA, 'workflow_patch').catch(() => null);
    if (!patch || (!Array.isArray(patch.upsert) && !Array.isArray(patch.remove))) {
      errors = ['The reply was not a patch.'];
      continue;
    }
    messages.push({ role: 'assistant', content: JSON.stringify(patch) });
    const draft = applyPatch(base, patch);
    let ir;
    try {
      ir = draftToIR(draft);
    } catch (e) {
      errors = [e instanceof Error ? e.message : String(e)];
    }
    if (ir) {
      const r = check(ir);
      errors = [
        ...economicLosses(base, draft),
        ...r.errors.map((e) => `${e.nodeId ? `[${e.nodeId}] ` : ''}${e.message}`),
      ];
      if (!errors.length) {
        const changed = [...(patch.upsert ?? []).map((s) => s.id), ...(patch.remove ?? [])];
        return {
          kind: 'workflow',
          bpmnXml: irToBpmn(ir).bpmnXml,
          draft,
          warnings: r.warnings.map((w) => w.message),
          changed,
        };
      }
    }
    messages.push({
      role: 'user',
      content: `The compiler rejects that:\n- ${errors.join('\n- ')}\nFix these with another patch against the ORIGINAL workflow (repeat your earlier changes, corrected).`,
    });
  }
  return {
    kind: 'error',
    error: `I couldn't produce a valid change. Remaining problems: ${errors.slice(0, 5).join('; ')}`,
  };
}

export async function runAi(
  ai: AiRunner,
  input: { prompt: string; today: string; draft?: WorkflowDraft },
): Promise<AiResult> {
  const hasWorkflow = !!input.draft?.steps?.length;
  const criteria = Object.fromEntries(
    (Object.keys(INTENTS) as Intent[]).filter((i) => hasWorkflow || i !== 'edit').map((i) => [i, INTENTS[i]]),
  );
  const first = await ai.decide(
    input.prompt,
    { intent: { type: 'choice', instructions: 'What does the user want StratosNotes to do?', criteria } },
    { precise: true },
  );
  const intent = (first.intent?.choice as Intent) || 'question';
  if ((first.intent?.confidence ?? 0) < CONFIDENCE_FLOOR) {
    return {
      kind: 'clarify',
      missing: ['intent'],
      reply: hasWorkflow
        ? 'Do you want me to change the open workflow, set up a new note from terms, or answer a question?'
        : 'Do you want me to set up a note from terms, or answer a question?',
    };
  }
  if (intent === 'question') {
    const reply = await ai.text([
      {
        role: 'system',
        content: BRIEF + (hasWorkflow ? `\n\nThe open workflow, as JSON:\n${JSON.stringify(input.draft)}` : ''),
      },
      { role: 'user', content: input.prompt },
    ]);
    return { kind: 'reply', reply };
  }
  if (intent === 'edit' && input.draft) return editWorkflow(ai, input.prompt, input.draft);

  const productQ: Record<string, DecisionQuestion> = {
    product: { type: 'choice', instructions: 'Which structured note is requested?', criteria: PRODUCTS },
  };
  const p = await ai.decide(input.prompt, productQ, { precise: true });
  const product = p.product?.choice as ProductType | undefined;
  if (!product || !PRODUCT_LABELS[product])
    return {
      kind: 'clarify',
      missing: ['product'],
      reply:
        'Which note do you want: a fixed coupon note, reverse convertible, phoenix, snowball or principal-protected note?',
    };
  const terms = termQuestions(product);
  const answers = await ai.decide(
    input.prompt,
    Object.fromEntries(terms.map(([k, , ins]) => [k, { type: 'noul', instructions: ins } as DecisionQuestion])),
    { precise: true },
  );
  const missing = terms.filter(([k]) => (answers[k]?.noul ?? 0) < 0.5).map(([, label]) => label);
  if (missing.length)
    return {
      kind: 'clarify',
      missing,
      reply: `To set up the ${PRODUCT_LABELS[product].toLowerCase()} I still need ${list(missing)}. What are they?`,
    };
  const r = await extractProduct(ai, input.prompt, product, input.today);
  if ('errors' in r) return { kind: 'clarify', missing: r.errors, reply: r.errors.join(' ') };
  return { kind: 'product', params: r.params, schedule: r.schedule, notes: r.notes };
}

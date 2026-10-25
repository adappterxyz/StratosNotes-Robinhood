// One structured note's lifecycle, step by step, and what each step is on-chain. Snippets follow the real
// code: FlowEngine.sol (packages/evm-engine), the SDK that calls it, and the CRE workflow (cre/notes-keeper-evm).

export type Chain = 'evm';

export interface LifecycleStep {
  id: string;
  type: 'event' | 'box' | 'gateway' | 'end';
  x: number;
  y: number;
  label: string;
  tag: string;
  title: string;
  desc: string;
  /** Who makes it happen. */
  actor: string;
  code: Record<Chain, string>;
}

const c = (s: string) => `<span class="cm">${s}</span>`;
const k = (s: string) => `<span class="kw">${s}</span>`;
const f = (s: string) => `<span class="fn">${s}</span>`;
const q = (s: string) => `<span class="st">${s}</span>`;

export const STEPS: LifecycleStep[] = [
  {
    id: 'terms',
    type: 'event',
    x: 8,
    y: 50,
    label: 'Terms + collateral',
    tag: 'Pre-trade · Issuer',
    title: 'Approve Terms, pledge collateral',
    actor: 'Issuer',
    desc: "Size, dates, settlement lag, grace period (0-7 days) and the collateral ratio are set per issuance. The issuer pledges collateral in the same step: it is locked in the note's escrow, which no key controls.",
    code: {
      evm: `${c('// The Issuer runs its user task on FlowEngine (Robinhood Chain testnet)')}
engine.${f('executeStep')}(pid, Task_ApproveTerms, ${q('0')}, [
  isin, notional, strikeDate, obsDate1, obsDate2, obsDate3, obsDate4,
  lag, grace, collateralRatio, haircut_USD, pledge_USD,
])
${c('// ops: deposit(col_USD, pledge_USD); transfer(Issuer → Escrow)')}
${c('// Check Terms: grace <= 7 days, deadlines before the next observation')}`,
    },
  },
  {
    id: 'book',
    type: 'box',
    x: 25,
    y: 26,
    label: 'Subscribe',
    tag: 'Open book · Investors',
    title: 'Subscribe: funds to the issuer',
    actor: 'Any investor',
    desc: "Anyone subscribes until the strike date, swapping USDG for note units atomically. The USDG is the issuer's at once: the money the note raises. Units can be transferred in whole or in part.",
    code: {
      evm: `${c('// An OPEN role: anyone may run it, again and again,')}
${c('// until the strike date (a repeatable window)')}
Task_Subscribe: until = strikeDate
  ops = [
    ${f('deposit')}(USDG, units * ${q('100 / 100')}),           ${c('// investor → engine')}
    ${f('swap')}(note: Issuer → Investor, units,
         USDG: Investor → Issuer, units * ${q('100 / 100')}),  ${c('// the issuer may withdraw it')}
  ]`,
    },
  },
  {
    id: 'strike',
    type: 'box',
    x: 42,
    y: 74,
    label: 'Fix strike',
    tag: 'Oracle step · Chainlink CRE',
    title: 'Fix Strike, check the collateral',
    actor: 'Chainlink CRE',
    desc: "On the strike date CRE reads the Chainlink feeds at a finalized block and writes a DON-signed report: strikes, and the collateral's prices. Coverage below ratio x units sold opens a margin call: top up within grace, or default.",
    code: {
      evm: `${c('// cre/notes-keeper-evm (Chainlink CRE)')}
${k('const')} values = due.feeds.${f('map')}(f => ${f('readFeed')}(runtime, f))  ${c('// at a finalized block')}
evm.${f('writeReport')}(runtime, {
  receiver: engine,                ${c('// through the KeystoneForwarder')}
  report: runtime.${f('report')}(${f('encodeAbiParameters')}(pid, Task_FixStrike, values)),
  gasConfig: { gasLimit: ${q('8000000')} },
})
${c('// sold = notional - balance(Issuer, note); required = ratio * sold')}
${c('// GW_Margin0: coverage >= required, else Margin Call → top up or default')}`,
    },
  },
  {
    id: 'observe',
    type: 'box',
    x: 60,
    y: 26,
    label: 'Observe k',
    tag: 'Oracle step · Chainlink CRE',
    title: 'Observe: what is owed',
    actor: 'Chainlink CRE',
    desc: 'Each observation waits for its own date. One report runs the observation and everything after it: the margin check, the coupon (with memory), the autocall check. That fixes what the issuer must fund by the payment date (observation + lag).',
    code: {
      evm: `Task_Observe2  timer = obsDate2, captures obs2 + collateral prices (oracle)
               payDate = obsDate2 + lag
GW_Coupon2     ${k('if')} perf2 >= ${q('70 / 100')}       ${c('// perf = min(ETH, BTC) vs strike')}
                 cpn = ${q('2.5 / 100')} * (missed + 1)
GW_Autocall2   ${k('if')} perf2 >= ${q('100 / 100')} → due = cpn + 1
${c('// the issuer funds dueTotal = due * sold through "Fund Payment 2"')}`,
    },
  },
  {
    id: 'funded',
    type: 'gateway',
    x: 77,
    y: 74,
    label: 'Funded?',
    tag: 'Gateway · escrow balance',
    title: 'Funded by the payment date?',
    actor: 'The ledger',
    desc: 'On the payment date the ledger checks the escrow. Funded: holders are paid. Not funded: a grace period runs; cured in it, holders are paid; not cured, the note defaults and everything in escrow goes to the holders, pro rata.',
    code: {
      evm: `GW_Funded2:
  Funded       ${k('when')} balance(Escrow, cash) >= dueTotal
  Not funded   ${k('default')} → Payment Missed → Grace
Recv_Grace2    ${k('waits for')} funded ${k('or')} now >= payDate + grace
GW_Cured2:     funded → pay ${k('|')} ${k('default')} → Default: collateral to holders
${c('// the validator refuses any payment without this check')}`,
    },
  },
  {
    id: 'redeem',
    type: 'end',
    x: 93,
    y: 50,
    label: 'Pay, release',
    tag: 'Settlement · every holder',
    title: 'Pay from escrow, release',
    actor: 'Holders, issuer',
    desc: 'Every holder is paid units × per-unit amount from escrow, complete by construction. After the final payment the collateral is released to the issuer. Holders claim their USDG when they like, with a receipt per claim (and withdraw delivered tokens, or collateral after a default).',
    code: {
      evm: `Task_Pay2Call    ${f('distribute')}(USDG per unit due, payer Escrow, retire)
Task_Release     ${f('transfer')}(Escrow → Issuer, balance(Escrow, col_USD))
${c('// then each holder claims, whenever they like (a receipt per claim):')}
engine.${f('pushTo')}(pid, CASH, [holder])`,
    },
  },
];

export const EDGES: Array<[string, string]> = [
  ['terms', 'book'],
  ['book', 'strike'],
  ['strike', 'observe'],
  ['observe', 'funded'],
  ['funded', 'redeem'],
];

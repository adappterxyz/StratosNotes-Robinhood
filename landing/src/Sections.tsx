/**
 * The page sections after the scroll story: why onchain, the three endings, the shelf, how it works, for issuers and
 * the FAQ. Built from the existing classes (.section-head, .cards3/.card, .steps, .side-tabs) plus a few of their own.
 */
import { useRef, useState } from 'react';

const APP_URL = '/app/';
const ISSUE_URL = '/app/issue';

export function WhyOnchain() {
  const rows: Array<[string, string, string]> = [
    ['Your exposure', "The issuer's balance sheet", 'Collateral pledged to the note, at a ratio shown on every note'],
    ['Who calculates', "The issuer's own calculation agent", 'Chainlink, from public price feeds'],
    ["When you're paid", 'Days later, through a custodian', 'On the payment date; claim any time, with a receipt'],
    ['What you can check', 'A PDF term sheet', 'Every term, fixing and payment'],
    ['Who can buy', 'Private-bank clients, six-figure tickets', 'Any wallet with a verified email · from 1 USDG'],
  ];
  return (
    <section id="why" className="why-band">
      <div className="wrap">
        <div className="section-head" data-reveal>
          <span className="eyebrow">Why onchain</span>
          <h2>
            A private-bank product.
            <br />
            Public-chain guarantees.
          </h2>
          <p>
            Structured notes have paid defined coupons to private-bank clients for decades. The payoff was never the
            problem. The plumbing was: issuer credit risk, opaque fixings, slow payments, high minimums. We kept the
            payoff and rebuilt the plumbing.
          </p>
        </div>
        <div className="why-table" data-reveal>
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Question</span>
                </th>
                <th scope="col">Bank-issued note</th>
                <th scope="col">notes.markets</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([k, a, b]) => (
                <tr key={k}>
                  <th scope="row">{k}</th>
                  <td data-h="Bank-issued note">{a}</td>
                  <td data-h="notes.markets">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ---- Outcomes: three tabs, each with a chart drawn to scale (100% strike / autocall, 65% knock-in). ---- */
const W = 600,
  H = 260;
const y = (pct: number) => 15 + ((125 - pct) * (H - 30)) / 85;
const OBS = [150, 270, 390, 510];
type Ending = {
  id: string;
  tab: string;
  tag: string;
  h: string;
  p: string;
  path: Array<[number, number]>;
  marks: Array<{ x: number; pct: number; kind: 'pay' | 'call' | 'ki' | 'end' }>;
  legend: Array<{ kind: 'pay' | 'call' | 'ki' | 'end'; t: string }>;
};
const ENDINGS: Ending[] = [
  {
    id: 'called',
    tab: 'Called early',
    tag: 'Ending 1 · Called early',
    h: 'Principal back early, plus the coupon.',
    p: "The underlying closes at or above the autocall level on an observation date. You receive your principal and that period's coupon, and the note closes.",
    path: [
      [30, 100],
      [70, 97],
      [110, 93],
      [150, 95],
      [190, 99],
      [230, 103],
      [270, 108],
    ],
    marks: [
      { x: 150, pct: 95, kind: 'pay' },
      { x: 270, pct: 108, kind: 'call' },
    ],
    legend: [
      { kind: 'pay', t: 'Coupon paid' },
      { kind: 'call', t: 'Called · principal + coupon paid' },
    ],
  },
  {
    id: 'held',
    tab: 'Held to maturity',
    tag: 'Ending 2 · Held to maturity',
    h: 'Every coupon, then full principal.',
    p: 'The underlying stays between the barrier and the autocall level. Coupons pay on every observation, and principal returns in full at maturity.',
    path: [
      [30, 100],
      [90, 93],
      [150, 88],
      [210, 80],
      [270, 84],
      [330, 77],
      [390, 90],
      [450, 85],
      [510, 93],
    ],
    marks: [
      { x: 150, pct: 88, kind: 'pay' },
      { x: 270, pct: 84, kind: 'pay' },
      { x: 390, pct: 90, kind: 'pay' },
      { x: 510, pct: 93, kind: 'end' },
    ],
    legend: [
      { kind: 'pay', t: 'Coupon paid' },
      { kind: 'end', t: 'Every coupon · full principal' },
    ],
  },
  {
    id: 'breached',
    tab: 'Barrier breached',
    tag: 'Ending 3 · Barrier breached',
    h: "The risk you're paid the coupon to take.",
    p: 'The underlying closes below the knock-in barrier and finishes below strike. Coupons already paid are yours; principal is returned as the underlying, or its value, at the final price.',
    path: [
      [30, 100],
      [90, 94],
      [150, 88],
      [210, 75],
      [270, 60],
      [330, 66],
      [390, 72],
      [450, 68],
      [510, 76],
    ],
    marks: [
      { x: 150, pct: 88, kind: 'pay' },
      { x: 270, pct: 60, kind: 'ki' },
      { x: 390, pct: 72, kind: 'pay' },
      { x: 510, pct: 76, kind: 'end' },
    ],
    legend: [
      { kind: 'pay', t: 'Coupon paid' },
      { kind: 'ki', t: 'Barrier breached' },
      { kind: 'end', t: 'Ends below strike' },
    ],
  },
];

function Mark({ kind }: { kind: 'pay' | 'call' | 'ki' | 'end' }) {
  return (
    <svg className={`oc-mk ${kind}`} viewBox="0 0 12 12" aria-hidden="true">
      {kind === 'ki' ? (
        <path d="M6 1 11 10H1z" />
      ) : kind === 'end' || kind === 'call' ? (
        <rect x="1.5" y="1.5" width="9" height="9" />
      ) : (
        <circle cx="6" cy="6" r="4.5" />
      )}
    </svg>
  );
}

function OutcomeChart({ e }: { e: Ending }) {
  return (
    <div className="oc-chart">
      <div className="oc-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${e.tag}: ${e.legend.map((l) => l.t).join(', ')}`}>
          {OBS.map((x) => (
            <line key={x} x1={x} x2={x} y1={10} y2={H - 10} className="oc-obs" />
          ))}
          <line x1={20} x2={W - 10} y1={y(100)} y2={y(100)} className="oc-strike" />
          <line x1={20} x2={W - 10} y1={y(65)} y2={y(65)} className="oc-ki" />
          <polyline points={e.path.map(([x, p]) => `${x},${y(p)}`).join(' ')} className="oc-path" />
          {e.marks.map((m) =>
            m.kind === 'ki' ? (
              <path
                key={m.x}
                d={`M${m.x} ${y(m.pct) - 9} L${m.x + 9} ${y(m.pct) + 7} L${m.x - 9} ${y(m.pct) + 7}Z`}
                className={`oc-m ${m.kind}`}
              />
            ) : m.kind === 'pay' ? (
              <circle key={m.x} cx={m.x} cy={y(m.pct)} r={7} className={`oc-m ${m.kind}`} />
            ) : (
              <rect key={m.x} x={m.x - 7} y={y(m.pct) - 7} width={14} height={14} className={`oc-m ${m.kind}`} />
            ),
          )}
        </svg>
        <span className="oc-axis" style={{ top: `${(y(100) / H) * 100}%` }}>
          Strike / autocall 100%
        </span>
        <span className="oc-axis ki" style={{ top: `${(y(65) / H) * 100}%` }}>
          Knock-in 65%
        </span>
      </div>
      <ul className="oc-legend">
        <li className="ax" aria-hidden="true">
          <i className="oc-sw" />
          Strike / autocall 100%
        </li>
        <li className="ax" aria-hidden="true">
          <i className="oc-sw ki" />
          Knock-in 65%
        </li>
        {e.legend.map((l) => (
          <li key={l.t}>
            <Mark kind={l.kind} />
            {l.t}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Outcomes() {
  const [i, setI] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (n: number) => {
    const k = (n + ENDINGS.length) % ENDINGS.length;
    setI(k);
    refs.current[k]?.focus();
  };
  const e = ENDINGS[i];
  return (
    <section id="outcomes">
      <div className="wrap">
        <div className="section-head" data-reveal>
          <span className="eyebrow">Defined outcomes</span>
          <h2>
            Three possible endings.
            <br />
            All written down on day one.
          </h2>
        </div>
        <div className="oc" data-reveal>
          <div className="side-tabs oc-tabs" role="tablist" aria-label="How a note can end">
            {ENDINGS.map((t, k) => (
              <button
                key={t.id}
                ref={(el) => {
                  refs.current[k] = el;
                }}
                id={`oc-tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={i === k}
                aria-controls="oc-panel"
                tabIndex={i === k ? 0 : -1}
                className={i === k ? 'on' : ''}
                onClick={() => setI(k)}
                onKeyDown={(ev) => {
                  if (ev.key === 'ArrowRight') {
                    ev.preventDefault();
                    move(k + 1);
                  } else if (ev.key === 'ArrowLeft') {
                    ev.preventDefault();
                    move(k - 1);
                  } else if (ev.key === 'Home') {
                    ev.preventDefault();
                    move(0);
                  } else if (ev.key === 'End') {
                    ev.preventDefault();
                    move(ENDINGS.length - 1);
                  }
                }}
              >
                {t.tab}
              </button>
            ))}
          </div>
          <div id="oc-panel" className="oc-panel" role="tabpanel" aria-labelledby={`oc-tab-${e.id}`} key={e.id}>
            <div className="oc-text">
              <span className={`tag${e.id === 'breached' ? ' risk' : ' ok'}`}>{e.tag}</span>
              <h3>{e.h}</h3>
              <p>{e.p}</p>
            </div>
            <OutcomeChart e={e} />
          </div>
          <p className="oc-foot">Which ending applies is decided by Chainlink-reported prices. Not by the issuer.</p>
        </div>
      </div>
    </section>
  );
}

export function Shelf() {
  const cards = [
    {
      label: 'FCN · Fixed coupon note',
      t: 'Highest income',
      p: 'A fixed coupon on every observation, whatever the market does. Principal is protected down to the knock-in barrier.',
      best: 'Best for: sideways or mildly bullish views',
    },
    {
      label: 'Autocallable',
      t: 'Income with an exit',
      p: 'Ends early when the underlying closes at or above its autocall level on an observation date. Principal and coupon come back early, ready to redeploy.',
      best: 'Best for: bullish views on a short horizon',
    },
    {
      label: 'Custom',
      t: 'Your payoff, your terms',
      p: 'Issuers set the barrier, coupon and observation schedule on reverse convertibles, phoenix, snowball, principal-protected and worst-of notes. The term sheet fills in as they build.',
      best: 'Best for: desks with a specific view to sell',
    },
  ];
  return (
    <section id="notes" className="shelf">
      <div className="wrap">
        <div className="section-head" data-reveal>
          <span className="eyebrow">The shelf</span>
          <h2>Pick the trade-off you want.</h2>
          <p>
            Every note trades some upside for something you value more: income, a buffer, an early exit. You choose
            which.
          </p>
        </div>
        <div className="cards3">
          {cards.map((c) => (
            <div key={c.label} className="card shelf-card" data-reveal>
              <span className="tag">{c.label}</span>
              <h3>{c.t}</h3>
              <p>{c.p}</p>
              <span className="best">{c.best}</span>
            </div>
          ))}
        </div>
        <p className="underlyings" data-reveal>
          <span className="built-label">Underlyings</span>BTC · ETH · SOL (Chainlink on Ethereum) · US stocks TSLA,
          AMZN, AMD, PLTR, NVDA, AAPL, SPY, META, MSFT, GOOGL and COIN (Chainlink on Robinhood Chain) · Robinhood
          Chain's own TSLA, AMZN, AMD and PLTR tokens and WETH, pledged as collateral or delivered at maturity, on the
          same chain
        </p>
      </div>
    </section>
  );
}

export function HowItWorks() {
  const steps = [
    [
      'Issue',
      'The issuer sets underlying, tenor, coupon and barriers, then pledges collateral into the note contract at the ratio shown on the note.',
    ],
    [
      'Subscribe',
      'Investors subscribe with USDG on Robinhood Chain, where the note, its collateral and its payments all live.',
    ],
    [
      'Fix and observe',
      'Chainlink fixes the strike at launch, then reads the price on every observation date and checks each barrier.',
    ],
    [
      'Pay',
      'The issuer funds each coupon, autocall and redemption, and Chainlink CRE pays it into the note automatically on the payment date. Holders claim from their portfolio whenever they like, with a receipt per claim. If the issuer misses a payment, the pledged collateral pays holders instead. No calculation dispute.',
    ],
  ];
  return (
    <section id="how">
      <div className="wrap">
        <div className="section-head" data-reveal>
          <span className="eyebrow">How it works</span>
          <h2>
            No back office.
            <br />
            Just a contract and an oracle.
          </h2>
        </div>
        <ol className="steps four" data-reveal>
          {steps.map(([k, p]) => (
            <li key={k}>
              <h3>{k}</h3>
              <p>{p}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function ForIssuers() {
  const cards = [
    [
      'Launch in minutes',
      'Start from a template or design the payoff on a visual canvas. The term sheet writes itself.',
    ],
    ['Fund against collateral', 'Pledge collateral, raise USDG, keep your market view.'],
    ['Zero back office', 'Chainlink is your calculation agent and paying agent, on every note.'],
    [
      'Onchain distribution',
      'Any wallet with a verified email can subscribe on Robinhood Chain, next to the stock tokens your note pays or pledges.',
    ],
  ];
  return (
    <section id="issuers">
      <div className="wrap">
        <div className="section-head" data-reveal>
          <span className="eyebrow">For issuers</span>
          <h2>Raise funding against collateral you already hold.</h2>
          <p>
            Turn inventory into term funding, priced through the coupon you set. Distribution, fixings and payments run
            onchain.
          </p>
          <div className="hero-cta">
            <a href={ISSUE_URL} className="btn btn-primary btn-lg">
              Issue a note
            </a>
          </div>
        </div>
        <div className="cards4">
          {cards.map(([t, p]) => (
            <div key={t} className="card" data-reveal>
              <h3>{t}</h3>
              <p>{p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Faq() {
  const qa: Array<[string, string]> = [
    [
      'What happens if the issuer disappears?',
      "Each note shows its collateral ratio. If the issuer misses a payment, Chainlink CRE triggers a default and holders are paid what they're owed from the pledged collateral, up to its value. You can inspect it onchain at any time.",
    ],
    [
      'Where do the prices come from?',
      'Chainlink price feeds. The same source that fixes the strike decides every barrier, coupon and redemption.',
    ],
    [
      'Can I lose money?',
      'Yes. If the barrier is breached and the underlying ends below strike, principal comes back as the underlying, or its value, at the final price. Coupons already paid are yours to keep.',
    ],
    [
      'Can I exit before maturity?',
      "There's no secondary market and no buyback. You can transfer your notes to another verified address, and a note ends early if it autocalls.",
    ],
    [
      'Who can invest?',
      'During testnet, anyone with a verified email. Eligibility and jurisdiction rules will be published before mainnet.',
    ],
  ];
  return (
    <section id="faq">
      <div className="wrap">
        <div className="section-head" data-reveal>
          <span className="eyebrow">FAQ</span>
          <h2>Straight answers</h2>
        </div>
        <div className="faq" data-reveal>
          {qa.map(([q, a], i) => (
            <FaqItem key={q} q={q} a={a} id={`faq-${i}`} first={i === 0} />
          ))}
        </div>
      </div>
    </section>
  );
}

export { APP_URL, ISSUE_URL };

/** One FAQ answer that opens and closes with a height animation (grid rows 0fr to 1fr), the first one open. */
function FaqItem({ q, a, id, first }: { q: string; a: string; id: string; first: boolean }) {
  const [open, setOpen] = useState(first);
  return (
    <div className={`faq-item${open ? ' open' : ''}`}>
      <h3 className="faq-q">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-a`}
          id={`${id}-q`}
          onClick={() => setOpen((o) => !o)}
        >
          <span>{q}</span>
          <span className="faq-icon" aria-hidden="true" />
        </button>
      </h3>
      <div className="faq-a" id={`${id}-a`} role="region" aria-labelledby={`${id}-q`} aria-hidden={!open}>
        <div className="faq-a-inner">
          <p>{a}</p>
        </div>
      </div>
    </div>
  );
}

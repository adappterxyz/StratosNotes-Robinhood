import { useCallback, useEffect, useRef, useState } from 'react';
import './notes.css';
import Carousel, { type Side } from './Carousel';
import Stage from './Stage';
import ExplorerPanel from './ExplorerPanel';
import TermSheet from './TermSheet';
import { WhyOnchain, Outcomes, Shelf, HowItWorks, ForIssuers, Faq } from './Sections';
import { DEFAULT_START, type ExplorerStart } from './explorer/start';

const APP_URL = '/app/';
const ISSUE_URL = '/app/issue';
const STRATOS_URL = 'https://stratoslab.xyz';
const REPO_URL = 'https://github.com/adappterxyz/StratosNotes-Robinhood';

/** The wordmark: lowercase, with the dot as the one blue mark. */
export function Wordmark({ size = 'md', dark = false }: { size?: 'md' | 'lg'; dark?: boolean }) {
  // Primary lockup (docs/brand/logo-guide.pdf): the payoff note, then "notes" in Geist Bold, a Signal-green square dot,
  // "markets" in Geist Regular, Slate.
  return (
    <span className={`wordmark ${size}${dark ? ' on-dark' : ''}`} aria-label="notes.markets">
      <img className="wm-mark" src={dark ? '/brand/mark-reversed.svg' : '/brand/mark.svg'} alt="" aria-hidden="true" />
      <span className="wm-text" aria-hidden="true">
        <b>notes</b>
        <i />
        <span>markets</span>
      </span>
    </span>
  );
}

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [side, setSide] = useState<Side>('Investors');
  // The full explorer opens on request only (a card, the "Try a note" buttons, or a #explore link).
  const [explorer, setExplorer] = useState<ExplorerStart | null>(() =>
    typeof window !== 'undefined' && window.location.hash === '#explore' ? DEFAULT_START : null,
  );
  const openExplorer = useCallback((s: ExplorerStart = DEFAULT_START) => {
    setMenu(false);
    setExplorer(s);
  }, []);
  const closeExplorer = useCallback(() => {
    setExplorer(null);
    if (window.location.hash === '#explore')
      history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === '#explore') setExplorer((e) => e ?? DEFAULT_START);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Nav state and gentle reveals; the page is complete without them.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const header = root.querySelector('header.nav');
    const onScroll = () => header?.classList.toggle('scrolled', window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    root.classList.add('js');
    const els = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add('in');
            io.unobserve(en.target);
          }
        }),
      { threshold: 0.1 },
    );
    els.forEach((el) => io.observe(el));
    const all = window.setTimeout(() => els.forEach((el) => el.classList.add('in')), 1800);
    return () => {
      window.removeEventListener('scroll', onScroll);
      io.disconnect();
      clearTimeout(all);
      root.classList.remove('js');
    };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const links = [
    ['#outcomes', 'Outcomes'],
    ['#notes', 'Notes'],
    ['#how', 'How it works'],
    ['#issuers', 'For issuers'],
    ['#faq', 'FAQ'],
  ];

  return (
    <div className="sn-root" ref={rootRef}>
      <header className={`nav${menu ? ' open' : ''}`}>
        <div className="nav-inner">
          <a className="brand" href="#top" aria-label="notes.markets home">
            <Wordmark />
          </a>
          <nav className="nav-links" aria-label="Sections">
            {links.map(([h, t]) => (
              <a key={h} href={h}>
                {t}
              </a>
            ))}
          </nav>
          <div className="nav-cta">
            <button type="button" className="btn btn-ghost hide-sm" onClick={() => openExplorer()}>
              Try a note
            </button>
            <a href={APP_URL} className="btn btn-primary">
              Launch app
            </a>
            <button
              type="button"
              className="nav-menu"
              aria-label={menu ? 'Close menu' : 'Open menu'}
              aria-expanded={menu}
              aria-controls="nav-sheet"
              onClick={() => setMenu((m) => !m)}
            >
              <span />
              <span />
              <span />
            </button>
          </div>
        </div>
        <div id="nav-sheet" className="nav-sheet" hidden={!menu}>
          {links.map(([h, t]) => (
            <a key={h} href={h} onClick={() => setMenu(false)}>
              {t}
            </a>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => openExplorer()}>
            Try a note
          </button>
        </div>
      </header>

      <main id="top">
        <Stage />

        <section id="note-types" className="notes-sec">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">What a note can do</span>
              <SideTabs side={side} onChange={setSide} />
              <p className="side-sub" aria-live="polite">
                {side === 'Investors'
                  ? 'Terms set before you buy, built for income, partial protection, exposure or a hedge. Paid in USDG; you can lose money.'
                  : 'Raise USDG against collateral you lock, and pay each coupon when it falls due.'}
              </p>
            </div>
          </div>
          <div id="notes-panel" role="tabpanel" aria-labelledby={`tab-${side}`}>
            <Carousel key={side} side={side} onOpen={openExplorer} />
          </div>
          <div className="wrap">
            <div className="try-row">
              <button type="button" className="btn btn-ghost" onClick={() => openExplorer()}>
                Try a note yourself
              </button>
            </div>
          </div>
        </section>

        <section id="live" className="ts-sec">
          <div className="wrap ts-wrap">
            <div className="section-head" data-reveal>
              <span className="badge">
                <i />
                Live on testnet
              </span>
              <h2>Every term on one sheet, before you subscribe.</h2>
              <p>
                Each note publishes its coupon, tenor, autocall level, knock-in barrier and the collateral pledged
                behind it.
              </p>
              <div className="hero-cta">
                <a href={APP_URL} className="btn btn-ghost">
                  Browse live notes
                </a>
              </div>
            </div>
            <div data-reveal>
              <TermSheet />
            </div>
          </div>
        </section>

        <WhyOnchain />
        <Outcomes />
        <Shelf />

        <HowItWorks />

        <section id="robinhood">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Why Robinhood Chain</span>
              <h2>Notes run where the stocks live.</h2>
              <p>
                Every note is issued, collateralised and paid on Robinhood Chain, next to Robinhood&apos;s tokenized
                stocks. TSLA and AMZN can back a note and be delivered at maturity on the same chain, with no bridge.
                Chainlink reads every observation and Chainlink CRE runs each payment step the issuer has funded.
              </p>
            </div>
            <div className="cards3">
              <div className="card" data-reveal>
                <div className="card-logo">
                  <img src="/logos/robinhood-chain-dark.svg" alt="" height={24} />
                  Robinhood Chain
                </div>
                <span className="tag">Where notes run · testnet 46630</span>
                <p>
                  Issue, subscribe, observe and pay: every note&apos;s lifecycle, on stocks or crypto, settled in USDG.
                </p>
              </div>
              <div className="card" data-reveal>
                <div className="card-logo">
                  <img src="/logos/robinhood-chain-dark.svg" alt="" height={24} />
                  Stock tokens
                </div>
                <span className="tag">Collateral and delivery</span>
                <p>
                  Robinhood&apos;s TSLA, AMZN, AMD and PLTR, plus USDG and WETH: pledged as collateral into the note, or
                  delivered to holders below the barrier.
                </p>
              </div>
              <div className="card" data-reveal>
                <div className="card-logo">
                  <img src="/logos/chainlink.svg" alt="Chainlink" height={20} />
                </div>
                <span className="tag">Prices and automation</span>
                <p>
                  Prices for ETH, BTC, SOL, TSLA, NVDA, AAPL, AMZN and SPY, checked on-chain. Chainlink CRE observes and
                  pays on schedule.
                </p>
              </div>
            </div>
          </div>
        </section>

        <ForIssuers />
        <Faq />

        <section id="cta">
          <div className="wrap">
            <div className="cta-final" data-reveal>
              <h2>
                Terms set upfront.
                <br />
                Every payment step onchain.
              </h2>
              <div className="hero-cta">
                <a href={APP_URL} className="btn btn-primary btn-lg">
                  Browse live notes
                </a>
                <a href={ISSUE_URL} className="btn btn-ghost btn-lg">
                  Issue a note
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap foot-inner">
          <Wordmark dark />
          <div className="foot-links">
            <a href={APP_URL}>App</a>
            <a href={REPO_URL} target="_blank" rel="noopener">
              GitHub
            </a>
            <a href={STRATOS_URL} target="_blank" rel="noopener">
              stratoslab.xyz
            </a>
          </div>
          <small className="by">
            <img src="/logos/stratos-mark.png" alt="" width={16} height={16} />
            notes.markets by StratosLab · Built on Robinhood Chain and Chainlink
          </small>
          <small className="disclaimer">
            notes.markets is software running on a test network: notes here use test tokens with no value. Nothing on
            this site is an offer to sell, a solicitation to buy, or a recommendation of any security, and nothing here
            is investment, legal or tax advice. Structured notes are complex: you can lose some or all of what you
            invest, payments depend on the issuer and on the collateral pledged, and examples and simulations do not
            predict results. Any future offering will be subject to eligibility and jurisdiction rules. Robinhood Chain
            and Chainlink are trademarks of their owners; notes.markets is not affiliated with or endorsed by them.
          </small>
        </div>
      </footer>
      {explorer && <ExplorerPanel start={explorer} onClose={closeExplorer} />}
    </div>
  );
}

const SIDES: Array<{ id: Side; label: string }> = [
  { id: 'Investors', label: 'For investors' },
  { id: 'Issuers', label: 'For issuers' },
];

/** Investor / issuer pill tabs that filter the carousel. */
function SideTabs({ side, onChange }: { side: Side; onChange: (s: Side) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (i: number) => {
    const n = (i + SIDES.length) % SIDES.length;
    onChange(SIDES[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div className="side-tabs" role="tablist" aria-label="Who the notes are for">
      {SIDES.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={side === t.id}
          aria-controls="notes-panel"
          tabIndex={side === t.id ? 0 : -1}
          className={side === t.id ? 'on' : ''}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              move(i + 1);
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault();
              move(i - 1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              move(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              move(SIDES.length - 1);
            }
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

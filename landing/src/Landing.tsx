import { useCallback, useEffect, useRef, useState } from 'react';
import './notes.css';
import Carousel from './Carousel';
import Stage from './Stage';
import ExplorerPanel from './ExplorerPanel';
import TermSheet from './TermSheet';
import { WhyOnchain, Outcomes, ForIssuers, Faq } from './Sections';
import { SideTabs, type Side } from './SideTabs';
import Chains from './Chains';
import Numbers from './Numbers';
import PayoffRule from './PayoffRule';
import { DEFAULT_START, type ExplorerStart } from './explorer/start';
import { Wordmark } from './Wordmark';

const APP_URL = '/app/';
const ISSUE_URL = '/app/issue';
const STRATOS_URL = 'https://stratoslab.xyz';
const REPO_URL = 'https://github.com/adappterxyz/StratosNotes-Robinhood';

/** Where the page snaps panel by panel (keep in step with the same query in notes.css). */
const SNAP_QUERY = '(min-width: 960px) and (min-height: 700px) and (prefers-reduced-motion: no-preference)';
const MIN_ZOOM = 0.62;

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  // One audience choice for the whole page: hero copy and buttons, the note cards and the section order. Remembered.
  const [side, setSideState] = useState<Side>(() => {
    try {
      return localStorage.getItem('nm-side') === 'Issuers' ? 'Issuers' : 'Investors';
    } catch {
      return 'Investors';
    }
  });
  const setSide = useCallback((v: Side) => {
    setSideState(v);
    try {
      localStorage.setItem('nm-side', v);
    } catch {
      /* private mode: the choice lasts for this visit */
    }
  }, []);
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
    return () => {
      window.removeEventListener('scroll', onScroll);
      root.classList.remove('js');
    };
  }, []);
  // Snap panels: on a screen large enough to snap, scale each panel's content down (never up) until it fits the
  // height under the nav. A panel that would need to shrink too far is left at full size and scrolls freely.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mq = window.matchMedia(SNAP_QUERY);
    const inner = (p: HTMLElement) =>
      (p.querySelector(':scope > .snap-in') ?? p.firstElementChild) as HTMLElement | null;
    let raf = 0;
    const fit = () => {
      raf = 0;
      for (const p of root.querySelectorAll<HTMLElement>('.snap')) {
        const el = inner(p);
        if (!el) continue;
        el.style.zoom = '';
        el.style.removeProperty('--snap-z');
        if (!mq.matches) continue;
        const cs = getComputedStyle(p);
        const room = window.innerHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        const h = el.getBoundingClientRect().height;
        if (h <= room + 1) continue;
        // Two passes: at the wider measure a chart can grow back a little.
        let z = room / h;
        for (let pass = 0; pass < 2 && z >= MIN_ZOOM; pass++) {
          el.style.zoom = z.toFixed(3);
          // The side gutters stay where the nav's are: the content gets shorter, not narrower.
          el.style.setProperty('--snap-z', z.toFixed(3));
          const now = el.getBoundingClientRect().height;
          if (now <= room + 1) break;
          z *= room / now;
        }
        if (z < MIN_ZOOM) {
          el.style.zoom = '';
          el.style.removeProperty('--snap-z');
        }
      }
    };
    const ask = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };
    const ro = new ResizeObserver(ask);
    root.querySelectorAll<HTMLElement>('.snap').forEach((p) => {
      const el = inner(p);
      if (el) ro.observe(el);
    });
    window.addEventListener('resize', ask);
    mq.addEventListener('change', ask);
    document.fonts?.ready.then(ask).catch(() => undefined);
    ask();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', ask);
      mq.removeEventListener('change', ask);
      cancelAnimationFrame(raf);
    };
  }, [side]);
  // Wheel steps. Native snapping sends a single wheel notch back where it came from (it has to pass half a screen),
  // so on a snapping screen one wheel gesture moves one panel. Inside anything taller than the screen (the scroll
  // story, a panel too tall to fit) the wheel scrolls as usual until that area's edge. Touch and keys stay native.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || explorer) return;
    const mq = window.matchMedia(SNAP_QUERY);
    let acc = 0,
      lockedUntil = 0,
      lastWheel = 0;
    const areas = () => {
      const els = [...root.querySelectorAll<HTMLElement>('.stage, .snap, #cta')];
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return els.map((el, i) => {
        const top = el.getBoundingClientRect().top + window.scrollY;
        const last = i === els.length - 1;
        return { top, bottom: last ? document.documentElement.scrollHeight : top + el.offsetHeight, max };
      });
    };
    const onWheel = (e: WheelEvent) => {
      if (!mq.matches || e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const now = performance.now();
      // While a step is under way, and until the wheel (or a trackpad's momentum) has gone quiet, swallow the rest.
      if (now < lockedUntil || (lockedUntil && now - lastWheel < 140)) {
        lastWheel = now;
        e.preventDefault();
        return;
      }
      lockedUntil = 0;
      lastWheel = now;
      const list = areas();
      const y = window.scrollY,
        vh = window.innerHeight,
        mid = y + vh / 2;
      const i = Math.max(
        0,
        list.findIndex((a) => mid >= a.top && mid < a.bottom),
      );
      const cur = list[i];
      const down = e.deltaY > 0;
      // More of this area to see in that direction: scroll as usual.
      if (down ? cur.bottom > y + vh + 2 : cur.top < y - 2) {
        acc = 0;
        return;
      }
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < 30) return;
      acc = 0;
      const to = list[i + (down ? 1 : -1)];
      if (!to) return;
      // Down: the next area's top. Up: the previous area's last screen (its top, unless it is taller than the screen).
      const target = Math.min(to.max, down ? to.top : Math.max(to.top, to.bottom - vh));
      lockedUntil = now + 650;
      window.scrollTo({ top: target, behavior: 'smooth' });
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [side, explorer]);
  // Reveals. Re-run when the audience changes: that reorders the sections, and a section that moves is mounted anew.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>('[data-reveal]:not(.in)')];
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
      io.disconnect();
      clearTimeout(all);
    };
  }, [side]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const links = [
    ['#chains', 'Chains'],
    ['#notes', 'Notes'],
    ['#faq', 'FAQ'],
    ['/support', 'Docs'],
  ];

  // What a note can do: the cards for this audience, how a note can end, and the explorer to try one.
  const notes = (
    <section id="notes" className="notes-sec" key="notes">
      <div className="snap">
        <div className="snap-in">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">What a note can do</span>
              <h2>Pick your trade-off.</h2>
              <SideTabs side={side} onChange={setSide} idPrefix="tab" controls="notes-panel" />
              <p className="side-sub" aria-live="polite">
                {side === 'Investors'
                  ? 'A note pays a set coupon while a price stays above a line. Terms set before you buy. You can lose money.'
                  : 'Lock collateral. Raise stablecoins. Pay coupons as they fall due.'}
              </p>
            </div>
          </div>
          <div id="notes-panel" role="tabpanel" aria-labelledby={`tab-${side}`}>
            <Carousel key={side} side={side} onOpen={openExplorer} />
          </div>
          <div className="wrap">
            <div className="try-row">
              <button type="button" className="btn btn-primary" onClick={() => openExplorer()}>
                Try a note yourself
              </button>
            </div>
          </div>
        </div>
      </div>
      <Outcomes />
    </section>
  );
  const live = (
    <section id="live" className="ts-sec snap" key="live">
      <div className="wrap ts-wrap">
        <div className="section-head" data-reveal>
          <span className="badge">
            <i />
            Live on testnet
          </span>
          <h2>Every term on one sheet.</h2>
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
  );

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
        <Stage side={side} onSide={setSide} onTry={() => openExplorer()} />
        <Numbers />
        <Chains />
        <PayoffRule />
        {side === 'Issuers' && <ForIssuers key="issuers" />}
        {notes}
        {live}
        <WhyOnchain />
        {side === 'Investors' && <ForIssuers key="issuers" />}
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
            <a href="/support">Docs</a>
            <a href={REPO_URL} target="_blank" rel="noopener">
              GitHub
            </a>
            <a href={STRATOS_URL} target="_blank" rel="noopener">
              stratoslab.xyz
            </a>
          </div>
          <small className="by">
            <img src="/logos/stratos-mark.png" alt="" width={16} height={16} />
            notes.markets by StratosLab · Built on Robinhood Chain, Base, BNB Chain and Chainlink
          </small>
          <small className="by">
            Recognition: Best Use of Chainlink CRE at TOKEN2049 (an earlier build of this engine) · Top-five finalist,
            CoinMarketCap × Atlas challenge, BNB Hack Bangkok 2026
          </small>
          <small className="disclaimer">
            notes.markets is software running on a test network: notes here use test tokens with no value. Nothing on
            this site is an offer to sell, a solicitation to buy, or a recommendation of any security, and nothing here
            is investment, legal or tax advice. Structured notes are complex: you can lose some or all of what you
            invest, payments depend on the issuer and on the collateral pledged, and examples and simulations do not
            predict results. Any future offering will be subject to eligibility and jurisdiction rules. Tokens used as
            cash or collateral (USDG, USDC, the stock tokens) can be paused or frozen by their issuers. The stock tokens
            on Base and BNB Chain testnets, and nmUSD, are notes.markets&apos; own test copies, not Coinbase&apos;s or
            Binance&apos;s. The contracts are not audited. Robinhood Chain, Base, Coinbase, Binance, BNB Chain,
            CoinMarketCap, Atlas and Chainlink are trademarks of their owners; notes.markets is not affiliated with or
            endorsed by them.
          </small>
        </div>
      </footer>
      {explorer && <ExplorerPanel start={explorer} onClose={closeExplorer} />}
    </div>
  );
}

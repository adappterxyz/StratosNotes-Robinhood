/**
 * The opening of the page: the hero over a 3D scene, then a pinned scroll story of one note's life.
 * Scroll position through the stage maps to the scene's progress (0..1); the captions use the same beat
 * ranges as the scene. The scene is code-split (three.js loads after first paint) and pauses offscreen.
 * With reduced motion there is no pinning: one still render under the hero, and the beats as a list.
 */
import { useEffect, useRef, useState } from 'react';
import { BEATS } from './scene/beats';

const APP_URL = '/app/';
const ISSUE_URL = '/app/issue';

export const BEAT_COPY: ReadonlyArray<{ k: string; t: string; n?: string }> = [
  { k: 'Issue', t: 'The issuer pledges collateral into the note.' },
  { k: 'Subscribe', t: 'USDG in, note units out, in one transaction on Arbitrum.' },
  { k: 'Fix and observe', t: 'Chainlink fixes the strike, then prices every observation date.' },
  { k: 'Pay', t: 'Coupons paid in USDG on the payment date, ready to claim.' },
  {
    k: 'Held to maturity',
    t: 'Every coupon, then full principal back in USDG.',
    n: 'Paid in full: CRE releases the collateral to the issuer.',
  },
  {
    k: 'Barrier breached',
    t: 'Below the knock-in, holders are repaid final ÷ strike in USDG: the loss follows TSLA.',
    n: 'Missed payment: CRE triggers the default and the collateral goes to holders; TSLA locked on Robinhood Chain is released to them there.',
  },
];

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
function lowPowerDevice() {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  return window.innerWidth < 760 || (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

export default function Stage() {
  const [reduced] = useState(prefersReducedMotion);
  const stageRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const beatRefs = useRef<Array<HTMLDivElement | null>>([]);
  const railRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stage = stageRef.current,
      canvas = canvasRef.current;
    if (!stage || !canvas) return;
    let disposed = false;
    let scene: import('./scene/NoteScene').NoteScene | null = null;
    let frame = 0;

    const progress = () => {
      if (reduced) return 0;
      const r = stage.getBoundingClientRect();
      const range = stage.offsetHeight - window.innerHeight;
      return range > 0 ? clamp(-r.top / range) : 0;
    };
    // Captions and the hero fade are set directly (no React re-render per scroll event).
    const paint = (p: number) => {
      const hero = heroRef.current;
      if (hero) {
        const f = clamp((p - 0.025) / 0.075);
        hero.style.opacity = String(1 - f);
        hero.style.transform = `translateY(${-f * 40}px)`;
        hero.style.visibility = f >= 1 ? 'hidden' : 'visible';
      }
      BEATS.forEach((b, i) => {
        const el = beatRefs.current[i];
        if (!el) return;
        const w = b.to - b.from,
          edge = Math.min(0.035, w * 0.25);
        const last = i === BEATS.length - 1;
        const o = clamp((p - b.from) / edge) * (last ? 1 : clamp((b.to - p) / edge));
        el.style.opacity = String(o);
        el.style.transform = `translateY(${(1 - o) * 14}px)`;
        el.setAttribute('aria-hidden', o < 0.5 ? 'true' : 'false');
      });
      const rail = railRef.current;
      if (rail) {
        rail.style.opacity = String(clamp((p - 0.11) / 0.04));
        const active = BEATS.findIndex((b) => p >= b.from && p < b.to);
        [...rail.children].forEach((c, i) =>
          c.classList.toggle('on', i <= (active < 0 ? (p >= 1 ? BEATS.length - 1 : -1) : active)),
        );
      }
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const p = progress();
        paint(p);
        scene?.setProgress(p);
      });
    };

    if (!reduced) {
      paint(progress());
      window.addEventListener('scroll', onScroll, { passive: true });
    }
    const onResize = () => {
      scene?.resize();
      onScroll();
    };
    window.addEventListener('resize', onResize);

    // Pause rendering while the stage is offscreen or the tab is hidden.
    const io = new IntersectionObserver(([e]) => scene?.setVisible(e.isIntersecting && !document.hidden), {
      threshold: 0,
    });
    io.observe(stage);
    const onVis = () => scene?.setVisible(!document.hidden && stage.getBoundingClientRect().bottom > 0);
    document.addEventListener('visibilitychange', onVis);

    // three.js after first paint; draw labels once the mono face is available.
    const start = async () => {
      const [{ NoteScene }] = await Promise.all([
        import('./scene/NoteScene'),
        document.fonts?.load?.('500 64px "Geist Mono"').catch(() => undefined),
      ]);
      if (disposed) return;
      try {
        scene = new NoteScene(canvas, { lowPower: lowPowerDevice(), reducedMotion: reduced });
      } catch {
        return; // no WebGL: the page stands without the scene
      }
      if (reduced) scene.snap(0.8);
      else {
        scene.snap(progress());
        scene.setProgress(progress());
      }
      setReady(true);
    };
    void start();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      io.disconnect();
      scene?.dispose();
    };
  }, [reduced]);

  return (
    <section ref={stageRef} className={`stage${reduced ? ' still' : ''}`} aria-label="notes.markets">
      <div className="stage-sticky">
        <canvas ref={canvasRef} className={`stage-canvas${ready ? ' ready' : ''}`} aria-hidden="true" />
        <div className="stage-shade" aria-hidden="true" />
        <div ref={heroRef} className="stage-hero">
          <div className="wrap hero-inner">
            <span className="badge">
              <i />
              Structured notes · Arbitrum · Robinhood Chain
            </span>
            <h1>Know the outcome before you invest.</h1>
            <p className="sub">
              Fixed-coupon and autocallable notes on stocks and crypto. Terms lock at subscription, collateral is
              pledged onchain, and Chainlink prices every observation and executes every payment.
            </p>
            <ul className="outcomes" aria-label="Why you can trust the terms">
              <li>
                <b>Prices and payments by Chainlink</b>
              </li>
              <li>
                <b>Collateral visible onchain</b>
              </li>
              <li>
                <b>Winner, Chainlink CRE track · TOKEN2049</b>
              </li>
            </ul>
            <div className="hero-cta">
              <a href={APP_URL} className="btn btn-primary btn-lg">
                Browse live notes
              </a>
              <a href={ISSUE_URL} className="btn btn-ghost btn-lg">
                Issue a note
              </a>
            </div>
            <div className="built-on">
              <span className="built-label">Built on</span>
              <span className="built-mark">
                <img src="/logos/arbitrum.svg" alt="" height={26} />
                Arbitrum
              </span>
              <span className="built-mark">
                <img src="/logos/robinhood-chain-dark.svg" alt="" height={24} />
                Robinhood Chain
              </span>
              <span className="built-mark">
                <img src="/logos/chainlink.svg" alt="Chainlink" height={20} />
              </span>
            </div>
          </div>
          {!reduced && (
            <span className="scroll-cue" aria-hidden="true">
              Scroll
            </span>
          )}
        </div>
        {!reduced && (
          <>
            <div className="beats wrap">
              {BEAT_COPY.map((b, i) => (
                <div
                  key={b.k}
                  ref={(el) => {
                    beatRefs.current[i] = el;
                  }}
                  className="beat"
                  aria-hidden="true"
                >
                  <span className="beat-k">
                    <b>{String(i + 1).padStart(2, '0')}</b> {b.k}
                  </span>
                  <p>{b.t}</p>
                  {b.n && <span className="beat-n">{b.n}</span>}
                </div>
              ))}
            </div>
            <div ref={railRef} className="beat-rail" aria-hidden="true">
              {BEAT_COPY.map((b) => (
                <span key={b.k} />
              ))}
            </div>
          </>
        )}
      </div>
      {/* Anchor for the scroll story: the first beat. */}
      <span id="story" className="stage-anchor" />
      {/* The story in words: visible as a list with reduced motion, for screen readers otherwise. */}
      {
        <ol className={`beats-list wrap${reduced ? '' : ' sr-only'}`}>
          {BEAT_COPY.map((b, i) => (
            <li key={b.k}>
              <span className="beat-k">
                <b>{String(i + 1).padStart(2, '0')}</b> {b.k}
              </span>
              <p>{b.t}</p>
              {b.n && <span className="beat-n">{b.n}</span>}
            </li>
          ))}
        </ol>
      }
    </section>
  );
}

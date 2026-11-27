/**
 * The opening of the page: the hero over a 3D scene, then a pinned scroll story of one note's life.
 * Scroll position through the stage maps to the scene's progress (0..1); the captions use the same beat
 * ranges as the scene. The scene is code-split (three.js loads after first paint) and pauses offscreen.
 * With reduced motion there is no pinning: one still render under the hero, and the beats as a list.
 */
import { useEffect, useRef, useState } from 'react';
import { BEATS } from './scene/beats';
import { SideTabs, type Side } from './SideTabs';

const APP_URL = '/app/';
const ISSUE_URL = '/app/issue';

export const BEAT_COPY: ReadonlyArray<{ k: string; t: string; n?: string }> = [
  { k: 'Issue', t: 'Collateral goes in. Locked.' },
  { k: 'Subscribe', t: 'Cash in, notes out. One transaction.' },
  { k: 'Observe', t: 'Chainlink sets the start price and checks every date.' },
  { k: 'Pay', t: 'Coupons land on schedule.' },
  {
    k: 'Held to maturity',
    t: 'In range: every coupon, then principal back.',
    n: 'The collateral returns to the issuer.',
  },
  {
    k: 'Barrier breached',
    t: 'Below the barrier: the loss follows the price.',
    n: 'If the issuer misses a payment, the collateral goes to holders, up to its value.',
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

export default function Stage({ side, onSide, onTry }: { side: Side; onSide: (s: Side) => void; onTry: () => void }) {
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
            <h1>Structured notes, onchain.</h1>
            <p className="sub">A set coupon for a defined risk. Collateral locked, every payment run by Chainlink.</p>
            <SideTabs side={side} onChange={onSide} idPrefix="hero-tab" />
            <div className="hero-cta">
              {side === 'Investors' ? (
                <>
                  <a href={APP_URL} className="btn btn-primary btn-lg">
                    Browse live notes
                  </a>
                  <button type="button" className="btn btn-ghost btn-lg" onClick={onTry}>
                    Try a note
                  </button>
                </>
              ) : (
                <>
                  <a href={ISSUE_URL} className="btn btn-primary btn-lg">
                    Issue a note
                  </a>
                  <a href={APP_URL} className="btn btn-ghost btn-lg">
                    Browse live notes
                  </a>
                </>
              )}
            </div>
            <div className="built-on">
              <span className="built-label">Built on</span>
              <span className="built-mark">
                <img src="/logos/robinhood-chain-dark.svg" alt="" height={24} />
                Robinhood Chain
              </span>
              <span className="built-mark">
                <img src="/logos/base.svg" alt="" height={18} />
                Base
              </span>
              <span className="built-mark">
                <img src="/logos/bnb-chain.svg" alt="BNB Chain" height={18} />
              </span>
              <span className="built-mark">
                <img src="/logos/chainlink.svg" alt="Chainlink" height={20} />
              </span>
            </div>
            <div className="built-on awards">
              <span className="built-label">Recognition</span>
              <span className="built-mark">Best Use of Chainlink CRE · TOKEN2049</span>
              <span className="built-mark">Finalist · BNB Hack Bangkok 2026</span>
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

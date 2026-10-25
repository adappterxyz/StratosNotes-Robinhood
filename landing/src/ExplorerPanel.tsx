/**
 * The full note explorer, mounted only when a visitor asks for it: a full-screen panel with a close button,
 * Esc to close, the page behind it locked, and focus returned to where it came from. The explorer's code
 * (and the reference payoff it uses) loads on first open.
 */
import { lazy, Suspense, useEffect, useRef } from 'react';
import type { ExplorerStart } from './explorer/start';

const Explorer = lazy(() => import('./explorer/Explorer'));

export default function ExplorerPanel({ start, onClose }: { start: ExplorerStart; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      back?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="xp-overlay" role="dialog" aria-modal="true" aria-labelledby="xp-title">
      <div className="xp-bar">
        <div>
          <span className="eyebrow">Note explorer</span>
          <h2 id="xp-title">Try a note.</h2>
        </div>
        <button ref={closeRef} type="button" className="xp-close" onClick={onClose} aria-label="Close the explorer">
          Close ✕
        </button>
      </div>
      <div className="xp-body">
        <p className="xp-intro">
          Drag the price path. Same payoff maths as the on-chain engine; example terms, not live prices.
        </p>
        <Suspense fallback={<div className="xp-loading">Loading the explorer…</div>}>
          <Explorer start={start} />
        </Suspense>
      </div>
    </div>
  );
}

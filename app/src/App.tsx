import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Briefcase, LayoutGrid, Mail, Menu, Moon, PenTool, Sun, X } from 'lucide-react';
import Marketplace from './pages/Marketplace';
import OfferingPage from './pages/Offering';
import Portfolio from './pages/Portfolio';
import IssueWizard from './pages/IssueWizard';
import Workspace from './pages/Workspace';
import AlertsPage, { AlertsConfirm, AlertsUnsubscribe } from './pages/Alerts';
import FaucetButton from './components/FaucetButton';
import RoleSwitch from './components/RoleSwitch';
import { useChains } from './lib/chains';
import { watchTables } from './lib/stackTables';

function ThemeToggle() {
  // White is the default; the navy theme is an opt-in kept per browser.
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('nm-theme', dark ? 'dark' : 'light');
    } catch {
      /* private mode */
    }
    window.dispatchEvent(new Event('sn-theme'));
  }, [dark]);
  return (
    <button
      className="btn"
      onClick={() => setDark((d) => !d)}
      aria-label={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
      title={dark ? 'Light theme' : 'Dark theme'}
    >
      {dark ? <Sun className="i" /> : <Moon className="i" />}
    </button>
  );
}

/** True below the width where the header's extra controls fold into a menu. */
function useNarrow(px = 1000) {
  const q = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

/** The primary lockup (docs/brand/logo-guide.pdf): the payoff-note mark, "notes" in Geist Bold, a Signal-green square
 *  dot, "markets" in Geist Regular, Slate. On the dark theme: the reversed mark, white and light grey. */
function Wordmark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const on = () => setDark(document.documentElement.classList.contains('dark'));
    window.addEventListener('sn-theme', on);
    return () => window.removeEventListener('sn-theme', on);
  }, []);
  return (
    <span className="wordmark" aria-label="notes.markets">
      <img
        className="wm-mark"
        src={`${import.meta.env.BASE_URL}brand/${dark ? 'mark-reversed' : 'mark'}.svg`}
        alt=""
        aria-hidden="true"
      />
      <span className="wm-text" aria-hidden="true">
        <b>notes</b>
        <i />
        <span>markets</span>
      </span>
    </span>
  );
}

export default function App() {
  const { pathname } = useLocation();
  const { config } = useChains();
  const narrow = useNarrow();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    setMenu(false);
  }, [pathname, narrow]);
  useEffect(() => watchTables(), []);
  const networks = config.chains.map((c) => c.name).join(' · ');
  const workspace = pathname.startsWith('/issue');
  const extras = (
    <>
      <span className="pill plain" title="Notes run on Robinhood Chain">
        <span className="dot text-success" />
        {networks}
      </span>
      <FaucetButton />
      <RoleSwitch />
      <ThemeToggle />
    </>
  );
  return (
    <>
      <NewVersion />
      <header className={`appbar${menu ? ' open' : ''}`}>
        <div className="appbar-row">
          <Link to="/" className="brand" aria-label="notes.markets marketplace">
            <Wordmark />
          </Link>
          <nav className="seg main-nav" aria-label="Sections">
            <NavLink to="/" end>
              <LayoutGrid className="i" />
              Marketplace
            </NavLink>
            <NavLink to="/issue">
              <PenTool className="i" />
              Issue
            </NavLink>
            <NavLink to="/portfolio">
              <Briefcase className="i" />
              Portfolio
            </NavLink>
            <NavLink to="/alerts">
              <Mail className="i" />
              Alerts
            </NavLink>
          </nav>
          <div className="right">
            {!narrow && extras}
            <ConnectButton chainStatus="icon" accountStatus={narrow ? 'avatar' : 'address'} showBalance={false} />
            {narrow && (
              <button
                className="btn menu-btn"
                aria-label={menu ? 'Close menu' : 'Open menu'}
                aria-expanded={menu}
                aria-controls="appbar-sheet"
                onClick={() => setMenu((m) => !m)}
              >
                {menu ? <X className="i" /> : <Menu className="i" />}
              </button>
            )}
          </div>
        </div>
        {narrow && menu && (
          <div id="appbar-sheet" className="appbar-sheet">
            {extras}
          </div>
        )}
      </header>
      <Routes>
        <Route path="/" element={<Marketplace />} />
        <Route path="/note/:id" element={<OfferingPage />} />
        <Route path="/issue" element={<IssueWizard />} />
        <Route path="/issue/advanced" element={<Workspace />} />
        <Route path="/studio" element={<Navigate to="/issue" replace />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/alerts/confirm" element={<AlertsConfirm />} />
        <Route path="/alerts/unsubscribe" element={<AlertsUnsubscribe />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {!workspace && (
        <footer className="foot">
          <span>
            notes.markets · Robinhood Chain testnet. Each note is a workflow run by one contract on Robinhood Chain;
            Chainlink CRE writes the strikes and observations.
          </span>
          {config.chains
            .filter((c) => c.explorer)
            .map((c) => (
              <a key={c.key} href={`${c.explorer}/address/${c.engine}`} target="_blank" rel="noreferrer">
                Engine on {c.name}
              </a>
            ))}
        </footer>
      )}
    </>
  );
}

/** The app's own bundle, as named in the page that loaded it. */
const loadedBundle = () =>
  document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') ??
  null;

/**
 * A tab opened before a deploy keeps running the code it loaded. Every few minutes (and when the tab comes back into
 * view) compare the live page's bundle with ours; when they differ, offer a one-click reload.
 */
function NewVersion() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const mine = loadedBundle();
    if (!mine) return;
    let off = false;
    const check = async () => {
      try {
        const html = await (await fetch(`${import.meta.env.BASE_URL}?v=${Date.now()}`, { cache: 'no-store' })).text();
        const live = /src="([^"]*\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
        if (!off && live && live !== mine) setStale(true);
      } catch {
        /* offline: try later */
      }
    };
    const t = setInterval(check, 5 * 60_000);
    const vis = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      off = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  if (!stale) return null;
  return (
    <div className="notice ok new-version" role="status">
      A newer version of notes.markets is live.{' '}
      <button type="button" className="btn sm" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

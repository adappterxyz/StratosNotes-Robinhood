import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles.css';
import App from './App';
import { api, type AppConfig } from './lib/api';
import { ChainsProvider, prepareConfig } from './lib/chains';
import { setTestWallet } from './components/RoleSwitch';

const root = createRoot(document.getElementById('root')!);

async function boot() {
  let config: AppConfig;
  try {
    config = prepareConfig(await api.config());
  } catch (e) {
    root.render(
      <main className="page">
        <div className="empty">
          <strong>Cannot reach the notes.markets API.</strong>
          <span className="small">{e instanceof Error ? e.message : String(e)}</span>
        </div>
      </main>,
    );
    return;
  }
  // Before the contracts on Robinhood Chain are deployed the API serves no chain: wagmi needs at least one, so say so.
  if (!config.chains.some((c) => c.family === 'evm' && c.chainId)) {
    root.render(
      <main className="page">
        <div className="empty">
          <strong>notes.markets is moving to Robinhood Chain.</strong>
          <span className="small">
            The new contracts are being deployed: the app opens here as soon as they are live.
          </span>
        </div>
      </main>,
    );
    return;
  }
  // Dev builds only: a test wallet on the first chain (a local anvil fork), signing with anvil's public test keys.
  if (import.meta.env.VITE_TEST_WALLET === '1' && config.chains[0]?.chainId) {
    const { installTestWallet } = await import('./lib/testWallet');
    setTestWallet(installTestWallet(config.chains[0].chainId, config.chains[0].rpc));
  }
  root.render(
    <StrictMode>
      <ChainsProvider config={config}>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
          <App />
        </BrowserRouter>
      </ChainsProvider>
    </StrictMode>,
  );
}
void boot();

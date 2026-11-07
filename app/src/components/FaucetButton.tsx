/**
 * Where to get testnet tokens. notes.markets mints none: every token a note uses is a real one, from its issuer's
 * own faucet, linked here in the order a newcomer needs them, per network the deployment serves: ETH for gas
 * (Robinhood Chain's faucet; Base Sepolia faucets), the cash token (USDG from Paxos on Robinhood Chain, USDC from
 * Circle on Base), WETH (wrapped from that ETH: the issue step offers it when a note takes ETH collateral), and
 * Robinhood Chain's stock tokens (Robinhood's faucet). On a local dev chain the API mints its mock stablecoin instead.
 */
import { AssetIcon, AssetStack } from './AssetIcon';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Droplet, ExternalLink } from 'lucide-react';
import { CASH_FAUCETS, CHAIN_CASH, CHAIN_TOKENS, FAUCETS, GAS_FAUCETS, isNoteChain, type NoteChain } from '@sn/core';
import { api } from '../lib/api';
import { useAddress, useChains } from '../lib/chains';
import { errText } from '../lib/format';

const CASH_ISSUER: Record<string, string> = { USDG: 'Paxos', USDC: 'Circle' };
const STOCKS = Object.values(CHAIN_TOKENS['robinhood-testnet'])
  .filter((t) => t.issuer === 'Robinhood')
  .map((t) => t.token);
const host = (url: string) => new URL(url).hostname.replace(/^www\./, '');

export default function FaucetButton() {
  const address = useAddress();
  const { config } = useChains();
  const [state, setState] = useState<{ busy: boolean; text: string; bad?: boolean }>({ busy: false, text: '' });
  if (!address) return null;
  const testnets = config.chains.filter((c) => isNoteChain(c.key));
  const dev = config.chains.find((c) => c.faucet);

  if (!testnets.length && dev) {
    const get = async () => {
      setState({ busy: true, text: `Sending test ${dev.stablecoin.symbol}…` });
      try {
        const r = await api.faucet(dev.key, address);
        setState({ busy: false, text: `${Number(r.amount).toLocaleString()} ${r.symbol} sent.` });
      } catch (e) {
        setState({ busy: false, text: errText(e), bad: true });
      }
    };
    const status = state.text && (
      <span
        className="xs"
        role="status"
        style={{
          color: state.bad ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))',
          maxWidth: 220,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={state.text}
      >
        {state.text}
      </span>
    );
    return (
      <span className="row gap-6 flex-nowrap">
        {status}
        <button className="btn" onClick={get} disabled={state.busy}>
          <Droplet className="i" />
          Test {dev.stablecoin.symbol}
        </button>
      </span>
    );
  }
  if (!testnets.length) return null;
  return (
    <TokenMenu
      gas={testnets.flatMap((c) => GAS_FAUCETS[c.key as NoteChain].map((url) => ({ name: c.name, url })))}
      cash={testnets.map((c) => ({
        name: c.name,
        token: CHAIN_CASH[c.key as NoteChain].token,
        url: CASH_FAUCETS[c.key as NoteChain],
      }))}
      stocks={config.chains.some((c) => c.key === 'robinhood-testnet')}
    />
  );
}

/** "Get testnet tokens": one menu that says where each token comes from. */
function TokenMenu({
  gas,
  cash,
  stocks,
}: {
  gas: Array<{ name: string; url: string }>;
  cash: Array<{ name: string; token: string; url: string }>;
  stocks: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="menu" ref={ref}>
      <button className="btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <Droplet className="i" />
        Get testnet tokens
        <ChevronDown className="i" />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <span className="label pad-4-10">1 · Gas (testnet ETH)</span>
          {gas.map((g) => (
            <a key={`${g.name}:${g.url}`} className="mi" role="menuitem" href={g.url} target="_blank" rel="noreferrer">
              <span className="row gap-8">
                <AssetIcon sym="ETH" size={20} />
                <span>
                  ETH on {g.name}
                  <small>{host(g.url)}</small>
                </span>
              </span>
              <ExternalLink className="i" />
            </a>
          ))}
          <div className="sep" />
          <span className="label pad-4-10">2 · {[...new Set(cash.map((c) => c.token))].join(' or ')} to subscribe</span>
          {cash.map((c) => (
            <a
              key={c.name}
              className="mi"
              role="menuitem"
              href={c.url}
              target="_blank"
              rel="noreferrer"
              data-cash-faucet={c.token}
            >
              <span className="row gap-8">
                <AssetIcon sym={c.token} size={20} />
                <span>
                  {c.token} from {CASH_ISSUER[c.token] ?? c.token}
                  <small>Notes on {c.name} are paid in it</small>
                </span>
              </span>
              <ExternalLink className="i" />
            </a>
          ))}
          <div className="sep" />
          <span className="label pad-4-10">Collateral and delivery</span>
          <span className="mi" role="menuitem" aria-disabled="true">
            <span className="row gap-8">
              <AssetIcon sym="WETH" size={20} />
              <span>
                WETH: wrap your testnet ETH<small>Offered when you issue a note with ETH collateral</small>
              </span>
            </span>
          </span>
          {stocks && (
            <a className="mi" role="menuitem" href={FAUCETS.robinhood} target="_blank" rel="noreferrer">
              <span className="row gap-8">
                <AssetStack syms={STOCKS} size={20} label={false} />
                <span>
                  {STOCKS.join(', ')} from Robinhood<small>Stock tokens on Robinhood Chain testnet</small>
                </span>
              </span>
              <ExternalLink className="i" />
            </a>
          )}
        </div>
      )}
    </span>
  );
}

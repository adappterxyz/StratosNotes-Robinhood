/**
 * Chains and wallets. The API's /api/config says which chains this deployment serves (RPC, engine, lens,
 * stablecoin): Robinhood Chain testnet. This builds the wagmi + RainbowKit setup for it (injected wallets,
 * discovered with EIP-6963) and one SDK adapter per (chain, engine): the chain's current engine, plus any earlier
 * engine whose notes stay on it (none today). `useNoteChain` picks the one that runs a note. Writes go through `useSigner`, which puts the
 * wallet on the note's chain first.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { connectorsForWallets, darkTheme, lightTheme, RainbowKitProvider } from '@rainbow-me/rainbowkit';
import {
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  trustWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createPublicClient, defineChain, http, type Chain, type PublicClient, type WalletClient } from 'viem';
import { createConfig, deserialize, WagmiProvider, useAccount, type State } from 'wagmi';
import { getAccount, getWalletClient, switchChain } from 'wagmi/actions';
import { EvmAdapter, type EngineVersion } from '@sn/sdk';
import { CASH_TOKEN, CASH_TOKENS, EXTERNAL_TOKENS, TEST_CASH_TOKEN } from '@sn/core';
import type { AppConfig, ChainConfig } from './api';
import { entryFor, legacyConfig, type ByKey, type EngineEntry } from './engines';

export { engineOf, entryFor, issueChains, legacyConfig, type ByKey, type EngineEntry } from './engines';
import '@rainbow-me/rainbowkit/styles.css';

/** The chain notes run on: Robinhood Chain testnet (the only one this deployment serves). */
export const NOTE_CHAIN = 'robinhood-testnet';

/**
 * The deployment's config as the app uses it: USDG (Paxos) as the cash token, with a deployment's own test dollar kept
 * under its symbol (tUSD) if the API names one, and the chain's own tokens (WETH, Robinhood's stock tokens).
 */
export function prepareConfig(config: AppConfig): AppConfig {
  const chains = config.chains.map((c) => {
    const usdg = CASH_TOKENS[c.key];
    const tokens: Record<string, `0x${string}`> = { ...(EXTERNAL_TOKENS[c.key] ?? {}), ...c.tokens };
    if (!usdg) return { ...c, tokens };
    // An older deployment's own test dollar, when the API still names it the stablecoin. Never overwrite a tUSD the
    // API already lists: that would relabel every tUSD note as USDG.
    if (
      c.stablecoin?.address &&
      c.stablecoin.address.toLowerCase() !== usdg.toLowerCase() &&
      !tokens[TEST_CASH_TOKEN.token]
    ) {
      tokens[TEST_CASH_TOKEN.token] = c.stablecoin.address;
    }
    return { ...c, tokens, stablecoin: { symbol: CASH_TOKEN.token, address: usdg, decimals: CASH_TOKEN.decimals } };
  });
  return { ...config, chains };
}

/** A note's cash symbol from the token it actually settles in: USDG, or tUSD for notes issued before USDG. */
export function cashSymbol(cfg: ChainConfig | undefined, cashToken?: string): string {
  if (!cfg) return 'USDG';
  const t = cashToken?.toLowerCase();
  if (!t || t === cfg.stablecoin.address.toLowerCase()) return cfg.stablecoin.symbol;
  return Object.entries(cfg.tokens).find(([, a]) => a.toLowerCase() === t)?.[0] ?? cfg.stablecoin.symbol;
}

/** Native gas tokens that are not ETH (every chain here pays gas in ETH today). */
const NATIVE: Record<string, { name: string; symbol: string }> = {};

function toChain(c: ChainConfig): Chain {
  return defineChain({
    id: c.chainId!,
    name: c.name,
    testnet: c.testnet,
    nativeCurrency: { ...(NATIVE[c.key] ?? { name: 'Ether', symbol: 'ETH' }), decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
    ...(c.explorer ? { blockExplorers: { default: { name: 'Explorer', url: c.explorer } } } : {}),
  });
}

/** How many wallets answer an EIP-6963 request right now (wallets announce synchronously, MetaMask included). */
export function announcedWallets(): number {
  if (typeof window === 'undefined') return 0;
  let n = 0;
  const on = () => {
    n++;
  };
  window.addEventListener('eip6963:announceProvider', on);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  window.removeEventListener('eip6963:announceProvider', on);
  return n;
}

/**
 * The wallet session wagmi saved last visit, read synchronously. wagmi loads its storage asynchronously, so without
 * this the first renders after a reload have no session: the reconnect starts as 'connecting' and RainbowKit shows
 * "Connect Wallet" until the wallet answers (about 5 s while MetaMask's service worker starts). Handed to
 * WagmiProvider as `initialState`, the reconnect starts as 'reconnecting' with the saved account, which RainbowKit
 * shows as connected; a failed reconnect still clears it.
 */
export function savedWalletState(): State | undefined {
  try {
    const raw = localStorage.getItem('wagmi.store');
    const saved = raw ? (deserialize(raw) as { state?: Partial<State> }).state : undefined;
    if (!saved?.current || !(saved.connections instanceof Map) || !saved.connections.has(saved.current))
      return undefined;
    return {
      chainId: saved.chainId ?? 0,
      connections: saved.connections,
      current: saved.current,
      status: 'reconnecting',
    };
  } catch {
    return undefined;
  }
}

interface Chains {
  config: AppConfig;
  /** The saved wallet session, if any (`savedWalletState`). */
  initialState?: State;
  /** Each chain's current engine, with every engine it serves (`entryFor` picks a note's). */
  byKey: ByKey;
  wagmi: ReturnType<typeof createConfig>;
}

/** WalletConnect (Reown) project id: public, built into the page; its allowlist names notes.markets. */
const WC_PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID ?? 'ca733b9845b6e338bba0d7bed1a4bb3c';

const Ctx = createContext<Chains | null>(null);

export function ChainsProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const value = useMemo<Chains>(() => {
    const evm = config.chains.filter((c) => c.family === 'evm' && c.chainId);
    const byKey: Chains['byKey'] = {};
    for (const cfg of evm) {
      const chain = toChain(cfg);
      const client = createPublicClient({ chain, transport: http(cfg.rpc) }) as PublicClient;
      const current: EngineEntry = {
        cfg,
        chain,
        client,
        version: 4,
        legacy: false,
        adapter: new EvmAdapter(cfg, client, { engine: cfg.engine, lens: cfg.lens, fromBlock: BigInt(cfg.fromBlock) }),
      };
      const engines: Record<string, EngineEntry> = { [cfg.engine.toLowerCase()]: current };
      for (const l of cfg.legacyEngines ?? []) {
        const version = (l.version < 4 ? 3 : 4) as EngineVersion; // earlier engines use the v3 ABI subset
        const lc = legacyConfig(cfg, l);
        engines[l.engine.toLowerCase()] = {
          cfg: lc,
          chain,
          client,
          version,
          legacy: version < 4,
          adapter: new EvmAdapter(lc, client, {
            engine: l.engine,
            lens: l.lens,
            fromBlock: BigInt(l.fromBlock),
            version,
          }),
        };
      }
      byKey[cfg.key] = { ...current, engines };
    }
    const chains = Object.values(byKey).map((x) => x.chain);
    const initialState = savedWalletState(); // before createConfig, which can write its empty state over the saved one
    // Injected wallets only (MetaMask, Rabby, Coinbase Wallet extension…), each discovered via EIP-6963 as its own
    // connector. The generic "Browser Wallet" connector is only a fallback for a wallet that does not announce
    // itself: next to an announced MetaMask it is a second connector on the same provider, so one wallet showed
    // twice in the modal and its session (recent connector, disconnect flags) was split between the two ids.
    // WalletConnect (Reown project, public id; notes.markets is on its domain allowlist) adds mobile wallets: on a
    // desktop with a browser wallet, one "WalletConnect" entry (a QR code for a phone wallet); on a phone browser
    // with no wallet inside it, MetaMask, Rainbow and Trust by name (each opens its app to approve) plus WalletConnect.
    const announced = announcedWallets();
    const mobile =
      announced === 0 && typeof window !== 'undefined' && !(window as unknown as { ethereum?: unknown }).ethereum;
    const groups = [
      ...(announced === 0 && !mobile ? [{ groupName: 'Browser wallets', wallets: [injectedWallet] }] : []),
      {
        groupName: mobile ? 'Wallet apps' : 'Phone wallets',
        wallets: mobile ? [metaMaskWallet, rainbowWallet, trustWallet, walletConnectWallet] : [walletConnectWallet],
      },
    ];
    const connectors = connectorsForWallets(groups, {
      appName: 'notes.markets',
      appUrl: 'https://notes.markets',
      projectId: WC_PROJECT_ID,
    });
    const wagmi = createConfig({
      chains: chains as [Chain, ...Chain[]],
      connectors,
      transports: Object.fromEntries(Object.values(byKey).map((x) => [x.chain.id, http(x.cfg.rpc)])),
      multiInjectedProviderDiscovery: true,
      ssr: false,
    });
    return { config, byKey, wagmi, initialState };
  }, [config]);
  const queryClient = useMemo(() => new QueryClient(), []);
  // The wallet modal follows the app theme: light by default, navy when the user picks the dark theme.
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const on = () => setDark(document.documentElement.classList.contains('dark'));
    window.addEventListener('sn-theme', on);
    return () => window.removeEventListener('sn-theme', on);
  }, []);
  const rkTheme = useMemo(
    () =>
      dark
        ? darkTheme({
            accentColor: '#12A971',
            accentColorForeground: '#0E1116',
            borderRadius: 'medium',
            fontStack: 'system',
          })
        : lightTheme({
            accentColor: '#0E1116',
            accentColorForeground: '#FFFFFF',
            borderRadius: 'medium',
            fontStack: 'system',
          }),
    [dark],
  );
  return (
    <Ctx.Provider value={value}>
      <WagmiProvider config={value.wagmi} initialState={value.initialState}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider theme={rkTheme} modalSize="compact">
            {children}
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </Ctx.Provider>
  );
}

export function useChains() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useChains outside ChainsProvider');
  return c;
}

/**
 * The engine that runs a note: its chain's current engine or an earlier one (by the note's engine address, or its
 * id). Undefined when this deployment does not serve that chain or engine.
 */
export function useNoteChain(
  note: { chain: string; engine?: string; id?: string } | null | undefined,
): EngineEntry | undefined {
  const { byKey } = useChains();
  return note ? entryFor(byKey, note) : undefined;
}

/** The connected wallet's address (lower-case), or null. */
export function useAddress(): string | null {
  const { address } = useAccount();
  return address ? address.toLowerCase() : null;
}

/** A WalletClient on `chainKey`, switching the wallet's network first when needed. */
export function useSigner() {
  const { wagmi, byKey } = useChains();
  return useCallback(
    async (chainKey: string): Promise<WalletClient> => {
      const target = byKey[chainKey];
      if (!target) throw new Error(`This app is not configured for ${chainKey}.`);
      const acct = getAccount(wagmi);
      if (!acct.address) throw new Error('Connect a wallet first.');
      if (acct.chainId !== target.chain.id) await switchChain(wagmi, { chainId: target.chain.id });
      return (await getWalletClient(wagmi, { chainId: target.chain.id })) as WalletClient;
    },
    [wagmi, byKey],
  );
}

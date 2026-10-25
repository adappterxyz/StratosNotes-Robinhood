/**
 * The API client (services/api). The app reads every note, portfolio and template from here; it writes to
 * chains directly through the SDK (lib/chains.tsx).
 */
import type { TemplateEntry, TemplateSummary, WorkflowDraft } from '@sn/core';
import type { ChainInfo, NoteState, NoteView } from '@sn/sdk';

export interface ChainConfig extends ChainInfo {
  rpc: string;
  engine: `0x${string}`;
  lens: `0x${string}`;
  fromBlock: number;
  stablecoin: { symbol: string; address: `0x${string}`; decimals: number };
  /** The API mints the stablecoin (local dev chains). */
  faucet: boolean;
  /** The retired notes.markets TokenFaucet, when the API still names one: the app no longer offers it. */
  tokenFaucet: `0x${string}` | null;
  /** Tokens by symbol: the chain's real tokens (USDG, WETH, Robinhood's stock tokens), receipts (TSLA.rh…) on the
   * home chain, and tUSD where older notes settle in it. */
  tokens: Record<string, `0x${string}`>;
  /** Cross-chain collateral (docs/CROSS-CHAIN.md): home = this chain runs notes and holds receipts; asset = vault. */
  crossChain?: CrossChainConfig | null;
  /**
   * Earlier engines on this chain whose notes stay on them (FlowEngine v3 next to v4): their notes render and
   * holders withdraw and settle on them; new issuance and subscriptions go to `engine`.
   */
  legacyEngines?: LegacyEngineConfig[];
  /** Earlier gateway–vault pairs of the current engine: receipts still in wallets redeem through their own gateway. */
  previousCrossChain?: CrossChainConfig[];
}
export interface LegacyEngineConfig {
  engine: `0x${string}`;
  lens: `0x${string}`;
  fromBlock: number;
  version: number;
  /** Symbols that differ for this engine's notes (its cross-chain receipts). */
  tokens: Record<string, `0x${string}`>;
  /** Its own gateway–vault pair (collateral locked for its notes is released through it). */
  crossChain: CrossChainConfig | null;
}
export interface CrossChainReceipt {
  receipt: `0x${string}`;
  token: `0x${string}`;
  decimals: number;
  valuedAs: string | null;
  note?: string;
}
export interface CrossChainConfig {
  role: 'home' | 'asset';
  router: `0x${string}`;
  selector: string;
  gateway?: `0x${string}`;
  vault?: `0x${string}`;
  home?: { chain: string; gateway: `0x${string}`; selector: string };
  remotes?: Array<{
    chain: string;
    selector: string;
    vault: `0x${string}`;
    receipts: Record<string, CrossChainReceipt>;
  }>;
}
export interface AppConfig {
  chains: ChainConfig[];
  ai: boolean;
}

export interface NoteItem {
  id: string;
  chain: string;
  definition: string;
  view: NoteView;
}
export interface NoteDetail {
  state: NoteState;
  view: NoteView;
}
export interface HistoryEvent {
  seq: number;
  name: string;
  block: number;
  tx: string;
  at: number;
  data: Record<string, unknown>;
}
export interface PortfolioItem extends NoteItem {
  position: { units: number; cash: number; holdings: NoteState['holdings'] };
}
/** A payout paid to the wallet (FlowEngine v4: the holder's claim, or a push the issuer opted into): `amount` in the cash token's base units, `payoutId` its receipt. */
export interface PayoutItem {
  noteId: string;
  asset: number;
  period: number;
  amount: string;
  payoutId: string;
  tx: string;
  at: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok) throw new ApiError(r.status, j?.error ?? `The API answered ${r.status}.`);
  return j as T;
}

export interface NoteFilters {
  chain?: string;
  status?: 'book' | 'live' | 'redeemed' | 'active' | 'all';
  underlying?: string;
  product?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export const api = {
  config: () => call<AppConfig>('/api/config'),
  notes: (f: NoteFilters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(f)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)]),
    );
    return call<{ notes: NoteItem[]; next: string | null }>(`/api/notes?${qs}`);
  },
  note: (id: string) => call<NoteDetail>(`/api/notes/${encodeURIComponent(id)}`),
  history: (id: string) => call<{ events: HistoryEvent[] }>(`/api/notes/${encodeURIComponent(id)}/history`),
  definition: (chain: string, id: string) =>
    call<{ id: string; bytes: `0x${string}` }>(`/api/definitions/${chain}/${id}`),
  portfolio: (address: string) =>
    call<{ positions: PortfolioItem[]; payouts?: PayoutItem[] }>(`/api/portfolio/${address}`),
  templates: () => call<TemplateSummary[]>('/api/templates'),
  template: (definition: string) => call<TemplateEntry>(`/api/templates/${definition}`),
  saveTemplate: (entry: Omit<TemplateEntry, 'createdAt'>, signature: string) =>
    call<TemplateSummary>('/api/templates', { method: 'POST', body: JSON.stringify({ entry, signature }) }),
  ai: (prompt: string, draft?: WorkflowDraft) =>
    call<unknown>('/api/ai', { method: 'POST', body: JSON.stringify({ prompt, draft }) }),
  faucet: (chain: string, address: string) =>
    call<{ tx: string; amount: string; symbol: string }>('/api/faucet', {
      method: 'POST',
      body: JSON.stringify({ chain, address }),
    }),
};

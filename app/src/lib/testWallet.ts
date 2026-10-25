/**
 * DEV BUILDS ONLY (VITE_TEST_WALLET=1, see main.tsx): an injected EIP-1193 wallet backed by anvil's public test
 * accounts (the "test test … junk" mnemonic, worthless outside a local chain), announced with EIP-6963 so wagmi
 * and RainbowKit list it like any browser wallet. It signs without pop-ups, which lets one person (or a
 * headless browser) act as issuer and investors: RoleSwitch moves between the accounts.
 */
import { createWalletClient, http, numberToHex, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const MNEMONIC = 'test test test test test test test test test test test junk';
/** Roles by anvil account index: 1 issuer, 3 and 4 investors (0 deploys, 2 is the e2e paying agent). */
export const TEST_ROLES = [
  { label: 'Issuer', index: 1 },
  { label: 'Investor A', index: 3 },
  { label: 'Investor B', index: 4 },
] as const;

type Listener = (...args: unknown[]) => void;

export interface TestWallet {
  role: number;
  setRole(i: number): void;
}

export function installTestWallet(chainId: number, rpc: string): TestWallet {
  const accounts = TEST_ROLES.map((r) => mnemonicToAccount(MNEMONIC, { addressIndex: r.index }));
  let role = 0;
  try {
    role = Math.min(accounts.length - 1, Math.max(0, Number(localStorage.getItem('sn-test-role') ?? 0)));
  } catch {
    /* storage blocked */
  }
  const listeners = new Map<string, Set<Listener>>();
  const emit = (ev: string, ...a: unknown[]) => listeners.get(ev)?.forEach((l) => l(...a));
  const rpcCall = async (method: string, params: unknown[] = []) => {
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = (await r.json()) as { result?: unknown; error?: { code: number; message: string } };
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };
  const provider = {
    isStratosTest: true,
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      const acct = accounts[role];
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [acct.address];
        case 'eth_chainId':
          return numberToHex(chainId);
        case 'net_version':
          return String(chainId);
        case 'wallet_switchEthereumChain': {
          const want = Number((params[0] as { chainId: string }).chainId);
          if (want !== chainId)
            throw Object.assign(new Error('The test wallet only knows the local chain.'), { code: 4902 });
          return null;
        }
        case 'wallet_addEthereumChain':
          return null;
        // "Add to wallet": recorded for the e2e (window.__watchedAssets), accepted.
        case 'wallet_watchAsset':
          ((window as unknown as { __watchedAssets?: unknown[] }).__watchedAssets ??= []).push(params);
          return true;
        case 'wallet_requestPermissions':
          return [{ parentCapability: 'eth_accounts' }];
        case 'wallet_getPermissions':
          return [{ parentCapability: 'eth_accounts' }];
        case 'personal_sign':
          return acct.signMessage({ message: { raw: params[0] as Hex } });
        case 'eth_signTypedData_v4':
          return acct.signTypedData(JSON.parse(params[1] as string));
        case 'eth_sendTransaction': {
          const tx = params[0] as { to?: Hex; data?: Hex; value?: Hex; gas?: Hex };
          const w = createWalletClient({ account: acct, transport: http(rpc) });
          return w.sendTransaction({
            chain: null,
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          } as never);
        }
        default:
          return rpcCall(method, params);
      }
    },
    on(ev: string, l: Listener) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(l);
      return provider;
    },
    removeListener(ev: string, l: Listener) {
      listeners.get(ev)?.delete(l);
      return provider;
    },
  };
  const info = {
    uuid: '4b9f7c1e-6a2b-4e8f-9d1c-5e3a7b2c9d01',
    name: 'StratosNotes test wallet',
    rdns: 'xyz.stratosnotes.testwallet',
    icon:
      'data:image/svg+xml;base64,' +
      btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#10b981"/><text x="16" y="21" font-size="14" font-family="Arial" font-weight="700" fill="#fff" text-anchor="middle">T</text></svg>',
      ),
  };
  const announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  return {
    get role() {
      return role;
    },
    setRole(i: number) {
      role = i;
      try {
        localStorage.setItem('sn-test-role', String(i));
      } catch {
        /* storage blocked */
      }
      emit('accountsChanged', [accounts[i].address]);
    },
  };
}

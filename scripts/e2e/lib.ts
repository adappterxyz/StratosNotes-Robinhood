/**
 * Shared by the local end-to-end scripts: anvil's well-known test accounts (public keys of the default
 * "test test ... junk" mnemonic, funded on every anvil chain and worthless anywhere else) and the note used.
 */
import { createPublicClient, createWalletClient, defineChain, http, type Hex, type PublicClient } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import {
  compile,
  EXAMPLE_PRODUCTS,
  FEEDS,
  instantiateProduct,
  parseBpmn,
  SRC,
  type EvmInput,
  type ProductParams,
} from '@sn/core';

export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
/** 0 deployer/owner, 1 issuer, 2 paying agent, 3-4 investors, 8 CRE simulator broadcaster, 9 fallback reporter. */
export const acct = (i: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
export const keyOf = (i: number): Hex => `0x${Buffer.from(acct(i).getHdKey().privateKey!).toString('hex')}`;

export function clients(rpc: string, chainId: number) {
  const chain = defineChain({
    id: chainId,
    name: `fork-${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const client = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  const wallet = (i: number) => createWalletClient({ chain, account: acct(i), transport: http(rpc) });
  return { chain, client, wallet };
}

/**
 * The note both runs use: a phoenix on the worst of ETH and BTC (E2E_NOTE=equity: TSLA and NVDA), three observations a short time apart
 * (coupon barrier 70%, autocall at 100% from the second observation, knock-in 60%).
 */
export const NOTE: ProductParams =
  process.env.E2E_NOTE === 'equity'
    ? // Equities: Chainlink TSLA/USD and NVDA/USD on Robinhood Chain mainnet (the stock tokens' own chain; CRE reads them
      // over HTTP JSON-RPC, the fallback keeper with viem). NYSE hours; outside them, the last close.
      {
        ...EXAMPLE_PRODUCTS.phoenix,
        name: 'E2E Worst-of Phoenix on TSLA, NVDA',
        underlyings: [FEEDS.TSLA, FEEDS.NVDA],
        observations: 3,
      }
    : {
        ...EXAMPLE_PRODUCTS.phoenix,
        name: 'E2E Worst-of Phoenix on ETH, BTC',
        underlyings: [FEEDS.ETH, FEEDS.BTC],
        observations: 3,
      };

export function compiled(p: ProductParams = NOTE) {
  const prod = instantiateProduct(p);
  return { c: compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params }), prod };
}

/** Pre-trade inputs in the order Approve Terms captures them, by field name (throws if one is missing). */
export function approveInputs(c: ReturnType<typeof compiled>['c'], byName: Record<string, EvmInput>): EvmInput[] {
  const step = c.def.steps[c.stepIndex.Task_ApproveTerms];
  return step.captures
    .filter((x) => x.source === SRC.INPUT)
    .map((x) => {
      const name = c.def.fields[x.field].name;
      if (!byName[name]) throw new Error(`no pre-trade input for ${name}`);
      return byName[name];
    });
}

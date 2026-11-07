/**
 * How much of each note chain's real tokens the demo accounts hold, with their ETH for gas: on Robinhood Chain testnet
 * USDG (the cash leg), WETH and Robinhood's stock tokens (TSLA, AMZN, AMD, PLTR, NFLX); on Base Sepolia USDC (the cash
 * leg) and WETH. So you know whether an account must claim from a faucet (or wrap ETH) before issuing, or lock stock
 * tokens on Robinhood Chain for a Base note.
 * Read-only: it reads the public addresses from .keys/*.json (never the keys) and calls balanceOf.
 * CHAINS=robinhood-testnet (or base-sepolia) limits it to one chain; RPC_ROBINHOOD_TESTNET / RPC_BASE_SEPOLIA override.
 *
 *   npx tsx scripts/stock-token-holdings.ts            # deployer (the demo issuer), keeper, demo investors
 *   npx tsx scripts/stock-token-holdings.ts 0xabc…     # the deployer plus any addresses (e.g. your own wallet)
 */
import { existsSync, readFileSync } from 'node:fs';
import { createPublicClient, formatUnits, http, parseAbi, type Address } from 'viem';
import {
  CASH_FAUCETS,
  CHAIN_TOKENS,
  GAS_FAUCETS,
  NOTE_CHAIN_LABELS,
  NOTE_CHAINS,
  STOCK_TOKEN_FAUCETS,
  type NoteChain,
} from '../packages/core/src';

const RPCS: Record<NoteChain, string> = {
  'robinhood-testnet': process.env.RPC_ROBINHOOD_TESTNET ?? 'https://rpc.testnet.chain.robinhood.com',
  'base-sepolia': process.env.RPC_BASE_SEPOLIA ?? 'https://base-sepolia-rpc.publicnode.com',
};
const chains = (process.env.CHAINS?.split(/[ ,]+/).filter(Boolean) ?? NOTE_CHAINS) as NoteChain[];
for (const c of chains) if (!RPCS[c]) throw new Error(`CHAINS: ${NOTE_CHAINS.join(', ')}`);
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

function addressOf(file: string): Address | null {
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, 'utf8')) as Array<{ address?: string }> | { address?: string };
  const a = Array.isArray(d) ? d[0]?.address : d.address;
  return a ? (a as Address) : null;
}

const args = process.argv.slice(2);
for (const a of args) if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`Not an address: ${a}`);
const own = (args.length ? (['deployer'] as const) : (['deployer', 'keeper', 'investor1', 'investor2'] as const))
  .map((n) => [n, addressOf(`.keys/${n}.json`)] as [string, Address | null])
  .filter((x): x is [string, Address] => !!x[1]);
const named: Array<[string, Address]> = [
  ...own,
  ...args.map((a, i) => [`address ${i + 1}`, a as Address] as [string, Address]),
];

for (const chain of chains) {
  const client = createPublicClient({ transport: http(RPCS[chain]) });
  console.log(`== ${NOTE_CHAIN_LABELS[chain]}`);
  for (const [name, who] of named) {
    const row: string[] = [`ETH ${formatUnits(await client.getBalance({ address: who }), 18)}`];
    for (const t of Object.values(CHAIN_TOKENS[chain])) {
      const bal = await client.readContract({ address: t.address, abi: erc20, functionName: 'balanceOf', args: [who] });
      row.push(`${t.token} ${formatUnits(bal, t.decimals)}`);
    }
    console.log(`${name.padEnd(10)} ${who}  ${row.join('  ')}`);
  }
  console.log(
    `   gas: ${GAS_FAUCETS[chain].join(', ')}  ·  cash: ${CASH_FAUCETS[chain]}${STOCK_TOKEN_FAUCETS[chain] ? `  ·  stock tokens: ${STOCK_TOKEN_FAUCETS[chain]}` : ''}`,
  );
}

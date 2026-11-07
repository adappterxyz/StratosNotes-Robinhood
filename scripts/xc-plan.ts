/**
 * Cross-chain deployment helper for scripts/deploy-crosschain.sh. packages/core is the single source of truth for
 * the pairs (REMOTE_COLLATERAL / wirePlan) and the chains' CCIP coordinates (XC_CHAINS).
 *
 *   npx tsx scripts/xc-plan.ts env <home> <asset>
 *       shell assignments for the pair: routers, selectors, the vault's TOKENS and the wire step's TOKENS, DECIMALS
 *       and SYMBOLS (e.g. TSLA.rh), one per line (eval them).
 *   npx tsx scripts/xc-plan.ts assemble <home> <asset> <dir> <engine> <owner> <out>
 *       read <dir>/{gateway,vault,wire}.json (written by DeployCrossChain.s.sol with OUT=) and <dir>/blocks.json, write
 *       the deployments/crosschain/<home>.json record (CrossChainDeployment) to <out>, and check it.
 *   npx tsx scripts/xc-plan.ts check <file>
 *       check a record against the directory and the plan (exit 1 with the problems).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  checkCrossChainDeployment,
  isNoteChain,
  wirePlan,
  XC_CHAINS,
  type CrossChainDeployment,
  type NoteChain,
} from '../packages/core/src';

const [cmd, ...args] = process.argv.slice(2);
const chainArg = (s: string | undefined): NoteChain => {
  if (!isNoteChain(s)) throw new Error(`not a note chain: ${s} (robinhood-testnet | base-sepolia)`);
  return s;
};
const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

if (cmd === 'env') {
  const home = chainArg(args[0]);
  const asset = chainArg(args[1]);
  const plan = wirePlan(home, asset);
  const out = {
    HOME_ID: XC_CHAINS[home].chainId,
    ASSET_ID: XC_CHAINS[asset].chainId,
    HOME_SELECTOR: XC_CHAINS[home].selector,
    ASSET_SELECTOR: XC_CHAINS[asset].selector,
    HOME_DEFAULT_RPC: XC_CHAINS[home].rpc,
    ASSET_DEFAULT_RPC: XC_CHAINS[asset].rpc,
    XC_TOKENS: plan.map((w) => w.token).join(','),
    XC_DECIMALS: plan.map((w) => w.decimals).join(','),
    XC_SYMBOLS: plan.map((w) => w.symbol).join(','),
  };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
} else if (cmd === 'assemble') {
  const home = chainArg(args[0]);
  const asset = chainArg(args[1]);
  const [dir, engine, owner, outPath] = args.slice(2);
  const g = read<{ gateway: string; router: string; feePoolWei: string; version?: number }>(`${dir}/gateway.json`);
  const v = read<{ vault: string; router: string; gateway: string }>(`${dir}/vault.json`);
  const w = read<{ receipts: Record<string, string> | string; gasLimit: number; vault: string }>(`${dir}/wire.json`);
  const blocks = read<{ gateway: number; vault: number }>(`${dir}/blocks.json`);
  const receipts = typeof w.receipts === 'string' ? (JSON.parse(w.receipts) as Record<string, string>) : w.receipts;
  if (v.gateway.toLowerCase() !== g.gateway.toLowerCase()) throw new Error('the vault answers to another gateway');
  if (w.vault.toLowerCase() !== v.vault.toLowerCase()) throw new Error('the gateway was wired to another vault');
  const rec: CrossChainDeployment = {
    home: {
      chain: home,
      chainId: XC_CHAINS[home].chainId,
      selector: XC_CHAINS[home].selector,
      router: g.router,
      engine,
      gateway: g.gateway,
      gatewayBlock: blocks.gateway,
      version: g.version ?? 2,
      feePoolWei: String(g.feePoolWei),
    },
    remotes: [
      {
        chain: asset,
        chainId: XC_CHAINS[asset].chainId,
        selector: XC_CHAINS[asset].selector,
        router: v.router,
        vault: v.vault,
        vaultBlock: blocks.vault,
        gasLimit: Number(w.gasLimit),
        receipts: Object.fromEntries(
          wirePlan(home, asset).map((p) => {
            const receipt = receipts[p.symbol];
            if (!receipt) throw new Error(`the wire step registered no ${p.symbol}`);
            return [p.symbol, { receipt, token: p.token, decimals: p.decimals, valuedAs: p.valuedAs }];
          }),
        ),
      },
    ],
    owner,
    checkedAt: new Date().toISOString().slice(0, 10),
  };
  const errs = checkCrossChainDeployment(rec);
  if (errs.length) throw new Error(`cross-chain record does not check out:\n  ${errs.join('\n  ')}`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(rec, null, 2) + '\n');
  console.log(
    `${outPath}: gateway ${rec.home.gateway} on ${home}, vault ${rec.remotes[0].vault} on ${asset}, receipts ${Object.keys(rec.remotes[0].receipts).join(', ')}`,
  );
} else if (cmd === 'check') {
  const errs = checkCrossChainDeployment(read<CrossChainDeployment>(args[0]));
  if (errs.length) {
    console.error(errs.join('\n'));
    process.exit(1);
  }
  console.log(`${args[0]}: ok`);
} else {
  console.error(
    'usage: xc-plan.ts env <home> <asset> | assemble <home> <asset> <dir> <engine> <owner> <out> | check <file>',
  );
  process.exit(2);
}

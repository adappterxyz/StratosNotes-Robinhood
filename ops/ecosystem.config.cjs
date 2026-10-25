// pm2 processes for the live demo on this server (docs/DEPLOY.md):
//   pm2 start ops/ecosystem.config.cjs
// Secrets come from .env.server at the repo root (gitignored, mode 600): DATABASE_URL, SN_PROXY_SECRET.
// Nothing secret is written here.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env.server');
const secrets = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) secrets[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

// The issuer's side of the demo notes (scripts/issuer-bot.ts) on Robinhood Chain testnet: funds each payment as it
// falls due. MISS (e.g. "5:1") leaves a payment unfunded to show a default. Not started until the deployment file
// names an engine (it is a placeholder before the fresh deploy).
const RPCS = { 'robinhood-testnet': ['https://rpc.testnet.chain.robinhood.com', 46630] };
const issuerBots = Object.entries(RPCS).flatMap(([chain, [rpc, id]]) => {
  const file = path.join(root, 'deployments', `${chain}.json`);
  if (!fs.existsSync(file)) return [];
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!dep.engine) return [];
  return [{
    name: `sn-rh-issuer-${chain}`,
    cwd: root,
    script: 'npx',
    args: 'tsx scripts/issuer-bot.ts',
    env: { RPC: rpc, CHAIN_ID: String(id), ENGINE: dep.engine, LENS: dep.lens, FROM_BLOCK: String(dep.block ?? 0), ISSUER_KEY_FILE: '.keys/deployer.json', MINT: '1', INTERVAL: '20', MISS: process.env.MISS ?? '' },
    restart_delay: 10000,
  }];
});

module.exports = {
  apps: [
    ...issuerBots,
    // The indexer and the API run in the notes.markets Worker on Cloudflare D1 (services/edge); nothing to run here.
    {
      name: 'sn-rh-keeper',
      cwd: root,
      script: 'scripts/keeper-loop.sh',
      interpreter: 'bash',
      restart_delay: 10000,
    },
  ],
};

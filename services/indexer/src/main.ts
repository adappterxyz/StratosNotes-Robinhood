/**
 * The indexer service: ingest every configured chain into Postgres, forever.
 *
 *   INDEXER_CONFIG=config.json DATABASE_URL=postgres://... npx tsx src/main.ts
 *
 * config.json: { "chains": [ { "key": "arbitrum-sepolia", "family": "evm", "chainId": 421614, "rpc": "...",
 *   "engine": "0x...", "startBlock": 123, "confirmations": 2, "maxRange": 2000, "pollMs": 2000 } ] }
 *
 * Each chain runs its own loop: catch up, then poll. Errors back off and retry; they never stop other chains.
 */
import { readFileSync } from 'node:fs';
import { migrate } from './schema';
import { pgDb } from './db';
import { Ingestor, type ChainConfig } from './ingest';
import { evmSource } from './source';

const cfgPath = process.env.INDEXER_CONFIG ?? 'config.json';
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { database?: string; chains: ChainConfig[] };
const url = process.env.DATABASE_URL ?? cfg.database;
if (!url) throw new Error('set DATABASE_URL (or "database" in the config)');
const db = pgDb(url);
await migrate(db);

const log = (chain: string, msg: string) => console.log(`${new Date().toISOString()} [${chain}] ${msg}`);
let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(c: ChainConfig) {
  const ing = new Ingestor(db, c, evmSource(c.rpc, c.engine));
  let backoff = 1000;
  for (;;) {
    if (stopping) return;
    try {
      await ing.init();
      const r = await ing.step();
      if (r.reorgedTo !== undefined)
        log(c.key, `reorg: rewound to block ${r.reorgedTo}, rebuilt ${r.notes.length} note(s)`);
      else if (!r.idle) log(c.key, `blocks ${r.from}-${r.to}: ${r.events} event(s), ${r.notes.length} note(s) updated`);
      backoff = 1000;
      if (r.idle) await sleep(c.pollMs ?? 2000);
    } catch (e) {
      log(c.key, `error: ${e instanceof Error ? e.message : String(e)}; retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    stopping = true;
    setTimeout(() => db.close().finally(() => process.exit(0)), 500);
  });
log('indexer', `indexing ${cfg.chains.map((c) => c.key).join(', ')}`);
await Promise.all(cfg.chains.map(run));

/**
 * Publish the seed template library (packages/core/src/products/library.ts) to a running API, each entry signed
 * (EIP-191) by the deployer key:
 *
 *   API=https://notes.markets npx tsx scripts/seed-templates.ts
 *   API=http://127.0.0.1:8787 ORIGIN=http://127.0.0.1:5173 ONLY=TSLA npx tsx scripts/seed-templates.ts
 *
 * KEY_FILE (default .keys/deployer.json, a `cast wallet new --json` file) signs; the key is never printed. The API
 * recompiles each workflow and refuses one that doesn't land on the definition it names. Re-running is safe: an
 * entry already in the library answers 409 and is skipped.
 */
import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileTemplate, definitionId, SEED_TEMPLATES, templateMessage } from '../packages/core/src';

const API = (process.env.API ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const ORIGIN = process.env.ORIGIN ?? new URL(API).origin; // POSTs must come from an allowed origin
const keyFile = process.env.KEY_FILE ?? '.keys/deployer.json';
const pk = (JSON.parse(readFileSync(keyFile, 'utf8')) as Array<{ private_key: string }>)[0].private_key;
const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex);

for (const t of SEED_TEMPLATES.filter((x) => !process.env.ONLY || x.name.includes(process.env.ONLY))) {
  const definition = definitionId(compileTemplate(t.source));
  const entry = { definition, name: t.name, description: t.description, author: account.address, ...t.source };
  const signature = await account.signMessage({ message: templateMessage(definition) });
  const r = await fetch(`${API}/api/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ entry, signature }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  console.log(
    `${r.status === 201 ? 'published' : r.status === 409 ? 'already there' : `failed ${r.status}`}  ${definition.slice(0, 12)}…  ${t.name}${j.error && r.status !== 409 ? `: ${j.error}` : ''}`,
  );
}

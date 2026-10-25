/**
 * Run the API on Node:
 *   API_CONFIG=config.json DATABASE_URL=postgres://… PORT=8787 npx tsx src/main.ts
 * Optional environment: CF_ACCOUNT_ID + CF_AI_TOKEN (Workers AI, when the config enables "ai"), FAUCET_KEY
 * (dev chains with a faucet only), SN_PROXY_SECRET (trust X-Forwarded-For only from the site's Worker).
 */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import type { Hex } from 'viem';
import { restAiRunner } from '@sn/core/src/ai/rest-runner';
import { migrate, pgDb } from '@sn/indexer';
import { AlertsStore, EmailNotConfigured, mockSender, pgSql, relaySender, type EmailSender } from '@sn/notifier';
import { chainLabelOf, notifierTick, type AlertsDeps } from './alerts';
import { createApp } from './app';
import { ApiConfig } from './config';

const config = ApiConfig.parse(JSON.parse(readFileSync(process.env.API_CONFIG ?? 'config.json', 'utf8')));
const url = process.env.DATABASE_URL;
if (!url) throw new Error('set DATABASE_URL');
const db = pgDb(url);
await migrate(db);
const ai =
  config.ai && process.env.CF_ACCOUNT_ID && process.env.CF_AI_TOKEN
    ? restAiRunner(process.env.CF_ACCOUNT_ID, process.env.CF_AI_TOKEN)
    : null;
if (config.ai && !ai)
  console.warn('AI is enabled in the config but CF_ACCOUNT_ID / CF_AI_TOKEN are not set: /api/ai answers 503');
const faucetKey = process.env.FAUCET_KEY as Hex | undefined;

// Email: the site Worker's /internal/email (Cloudflare Email Service) when EMAIL_RELAY_URL and EMAIL_RELAY_SECRET
// are set; EMAIL_SENDER=mock keeps emails in memory (local dev and e2e read them at /api/dev/emails).
const store = new AlertsStore(pgSql(db));
await store.migrate();
const mailbox = process.env.EMAIL_SENDER === 'mock' ? mockSender() : undefined;
const sender: EmailSender =
  mailbox ??
  (process.env.EMAIL_RELAY_URL && process.env.EMAIL_RELAY_SECRET
    ? relaySender(process.env.EMAIL_RELAY_URL, process.env.EMAIL_RELAY_SECRET)
    : {
        send: async () => {
          throw new EmailNotConfigured('EMAIL_RELAY_URL / EMAIL_RELAY_SECRET are not set');
        },
      });
let verifierKey: Hex | null = null;
if (process.env.VERIFIER_KEY_FILE) {
  const k = String(JSON.parse(readFileSync(process.env.VERIFIER_KEY_FILE, 'utf8'))[0].private_key);
  verifierKey = (k.startsWith('0x') ? k : `0x${k}`) as Hex;
}
const alerts: AlertsDeps = {
  store,
  sender,
  verifierKey,
  siteUrl: process.env.SITE_URL ?? 'https://notes.markets',
  devMailbox: mailbox,
};
if (!verifierKey) console.warn('VERIFIER_KEY_FILE is not set: emails verify, but on-chain attestations are refused');

const app = createApp({
  db,
  config,
  ai,
  faucetKey,
  proxySecret: process.env.SN_PROXY_SECRET,
  alerts,
  clientIp: (c) =>
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ?? 'unknown',
});
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, (i) =>
  console.log(`api listening on http://${i.address}:${i.port}`),
);

// The notifier runs in this process (no separate service): plan, queue and send every NOTIFIER_INTERVAL ms.
let notConfiguredLogged = false;
const every = Number(process.env.NOTIFIER_INTERVAL ?? 30_000);
const tick = async () => {
  try {
    const r = await notifierTick(db, alerts, Math.floor(Date.now() / 1000), chainLabelOf);
    if (r.notConfigured && !notConfiguredLogged) {
      console.warn('email: not sent, Email Sending is not onboarded or configured yet; holding the outbox');
      notConfiguredLogged = true;
    }
    if (r.sent || r.failed) console.log(`email: sent ${r.sent}, failed ${r.failed}, queued ${r.queued}`);
  } catch (e) {
    console.error(`notifier: ${e instanceof Error ? e.message : String(e)}`);
  }
  setTimeout(tick, every);
};
if (every > 0) setTimeout(tick, 5_000);

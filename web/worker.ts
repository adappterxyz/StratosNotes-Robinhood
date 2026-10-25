/**
 * notes.markets: one Cloudflare Worker for the whole site.
 *
 *   /             the landing page (static, from dist/)
 *   /app/*        the app (static; client-side routes fall back to /app/index.html)
 *   /api/ai       the AI assistant, on Workers AI here (term sheet -> note, workflow edits, questions)
 *   /api/*        everything else, served here from D1 (services/edge), including verified emails and alerts
 *   /internal/email  an email relay (Cloudflare Email Service), guarded by EMAIL_RELAY_SECRET: kept for the Node
 *                 API (services/api) in local dev; the Worker's own notifier sends through the binding directly
 *
 * The Worker is the whole backend: the API reads D1, and the cron (scheduled) indexes both chains into D1 every
 * minute and sends due notifications through Cloudflare Email Service. API_MODE = "proxy" forwards /api/* to
 * API_ORIGIN instead (only used during a cutover).
 *
 * The browser only ever talks to this origin, so the API needs no CORS for the site.
 */
import { runAi } from '../packages/core/src/ai/pipeline';
import { workersAiRunner } from '../packages/core/src/ai/runner';
import type { WorkflowDraft } from '../packages/core/src/draft';
import { createEdgeApp, type RateLimitBinding } from '../services/edge/src/api';
import { parseEdgeConfig, type EdgeConfig } from '../services/edge/src/config';
import { Store, type D1Database } from '../services/edge/src/d1';
import { bindingSender, type EmailBinding } from '../services/edge/src/notify';
import { mockSender, type MockSender } from '../services/notifier/src/sender';
import { CHAINS } from '../packages/sdk/src/model';
import { runCron } from '../services/edge/src/scheduled';
import apiJson from '../deployments/server/api.json';
import indexerJson from '../deployments/server/indexer.json';

interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> };
  AI?: Parameters<typeof workersAiRunner>[0];
  AI_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  API_ORIGIN: string;
  SN_PROXY_SECRET?: string;
  /** D1: the read model, templates, subscriptions, outbox (the `edge` environment). */
  DB?: D1Database;
  /** "proxy" forwards /api/* to API_ORIGIN even with DB bound (cutover); anything else serves from D1. */
  API_MODE?: string;
  /** Per-minute read limit for the API (Workers rate-limiting binding). */
  READ_LIMIT?: RateLimitBinding;
  /** Cloudflare Email Service; sending is on only when EMAIL_SENDING = "on" (the domain must be onboarded). */
  EMAIL?: EmailBinding;
  EMAIL_SENDING?: string;
  EMAIL_FROM?: string;
  /** JSON { api, indexer } replacing the bundled deployments/server config (e.g. wrangler dev on a fork). */
  SN_CONFIG?: string;
  /** Dev chains only: the faucet signer for the mock stablecoin. */
  FAUCET_KEY?: string;
  /** The engine's attestation verifier key (hex): signs on-chain email attestations. Secret. */
  VERIFIER_KEY?: string;
  /** "mock": keep emails in memory and expose them at /api/dev/emails (local e2e only). */
  EMAIL_SENDER?: string;
  /** Public origin for links in emails (default https://notes.markets). */
  SITE_URL?: string;
  /** Shared secret for /internal/email. */
  EMAIL_RELAY_SECRET?: string;
}

/** Constant-time string comparison (Workers have no timingSafeEqual on strings). */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The email relay for the Node API (local dev). Exported for tests. */
export async function relayEmail(
  req: Request,
  env: Pick<Env, 'EMAIL' | 'EMAIL_RELAY_SECRET' | 'EMAIL_FROM'>,
): Promise<Response> {
  const given = req.headers.get('X-Email-Relay-Secret') ?? '';
  if (!env.EMAIL_RELAY_SECRET || !given || !sameSecret(given, env.EMAIL_RELAY_SECRET))
    return json({ error: 'Not allowed.' }, 401);
  const b = (await req.json().catch(() => null)) as {
    to?: unknown;
    subject?: unknown;
    html?: unknown;
    text?: unknown;
  } | null;
  const ok = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (
    !b ||
    !ok(b.to, 254) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.to)) ||
    !ok(b.subject, 300) ||
    !ok(b.html, 200_000) ||
    !ok(b.text, 100_000)
  ) {
    return json({ error: 'Send {to, subject, html, text}.' }, 400);
  }
  if (!env.EMAIL)
    return json(
      {
        error:
          'Email Sending is not configured on this Worker (no EMAIL binding); onboard notes.markets in Email Service.',
      },
      503,
    );
  try {
    const r = await env.EMAIL.send({
      to: String(b.to),
      from: { email: env.EMAIL_FROM ?? 'alerts@notes.markets', name: 'notes.markets' },
      subject: String(b.subject),
      html: String(b.html),
      text: String(b.text),
    });
    return json({ messageId: (r && 'messageId' in r && r.messageId) || '' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const notReady = /E_SENDER_DOMAIN_NOT_AVAILABLE|E_ACCOUNT_SUSPENDED|not (onboarded|available)|paused/i.test(msg);
    return json({ error: msg }, notReady ? 503 : 502);
  }
}

/** The dev mailbox survives across requests in one isolate (local e2e reads codes from it). */
let devMailbox: MockSender | null = null;
const siteOf = (env: Env) => env.SITE_URL ?? 'https://notes.markets';
const verifierOf = (env: Env) =>
  env.VERIFIER_KEY
    ? ((env.VERIFIER_KEY.startsWith('0x') ? env.VERIFIER_KEY : `0x${env.VERIFIER_KEY}`) as `0x${string}`)
    : null;
/** The email sender: the dev mailbox, or Email Service when EMAIL_SENDING = "on"; null otherwise. */
function senderOf(env: Env) {
  if (env.EMAIL_SENDER === 'mock') return (devMailbox ??= mockSender());
  return env.EMAIL && env.EMAIL_SENDING === 'on'
    ? bindingSender(env.EMAIL, env.EMAIL_FROM ?? 'alerts@notes.markets')
    : null;
}
/** For the API: a sender that reports "not configured" instead of null, so /api/alerts/start answers 503. */
const unconfigured = {
  async send(): Promise<{ messageId: string }> {
    throw new Error('Email sending is not enabled on this deployment.');
  },
};
const chainLabel = (key: string) => CHAINS[key]?.name ?? key;

let configCache: { raw: string | undefined; cfg: EdgeConfig } | null = null;
function edgeConfig(env: Env): EdgeConfig {
  if (configCache && configCache.raw === env.SN_CONFIG) return configCache.cfg;
  const cfg = parseEdgeConfig(env.SN_CONFIG ? JSON.parse(env.SN_CONFIG) : { api: apiJson, indexer: indexerJson });
  configCache = { raw: env.SN_CONFIG, cfg };
  return cfg;
}

let appCache: { env: Env; app: ReturnType<typeof createEdgeApp> } | null = null;
function edgeApp(env: Env) {
  if (appCache?.env === env) return appCache.app;
  const app = createEdgeApp({
    store: () => new Store(env.DB!),
    config: edgeConfig(env).api,
    ai: !!env.AI,
    readLimit: env.READ_LIMIT,
    faucetKey: env.FAUCET_KEY as `0x${string}` | undefined,
    alerts: {
      sender: senderOf(env) ?? unconfigured,
      verifierKey: verifierOf(env),
      siteUrl: siteOf(env),
      devMailbox: env.EMAIL_SENDER === 'mock' ? (senderOf(env) as MockSender) : undefined,
    },
  });
  appCache = { env, app };
  return app;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function ai(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin) return json({ error: 'Not allowed from this origin.' }, 403);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (env.AI_LIMIT && !(await env.AI_LIMIT.limit({ key: ip })).success)
    return json({ error: 'Too many AI requests; wait a minute and try again.' }, 429);
  const body = (await req.json().catch(() => null)) as { prompt?: string; draft?: WorkflowDraft } | null;
  const prompt = (body?.prompt ?? '').trim();
  if (!prompt)
    return json({ error: 'Say what you want: a note from terms, a change to the workflow, or a question.' }, 400);
  if (prompt.length > 4000) return json({ error: 'Keep the request under 4,000 characters.' }, 400);
  try {
    return json(
      await runAi(workersAiRunner(env.AI!), {
        prompt,
        today: new Date().toISOString().slice(0, 10),
        draft: body?.draft,
      }),
    );
  } catch (e) {
    return json({ kind: 'error', error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

/** Forward to the API with the caller's IP (trusted by the API only alongside the shared proxy secret). */
async function proxy(req: Request, env: Env, url: URL): Promise<Response> {
  const target = new URL(url.pathname + url.search, env.API_ORIGIN);
  const headers = new Headers(req.headers);
  headers.set('X-Forwarded-For', req.headers.get('CF-Connecting-IP') ?? '');
  if (env.SN_PROXY_SECRET) headers.set('X-SN-Proxy', env.SN_PROXY_SECRET);
  headers.delete('Host');
  try {
    return await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      redirect: 'manual',
    });
  } catch {
    return json({ error: 'The notes.markets API is unreachable right now; try again shortly.' }, 502);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // One canonical host: the earlier domain and www redirect to notes.markets.
    const host = new URL(req.url).hostname;
    if (host === 'notes.stratoslab.app' || host === 'www.notes.markets') {
      const to = new URL(req.url);
      to.hostname = 'notes.markets';
      return Response.redirect(to.toString(), 301);
    }
    const url = new URL(req.url);
    if (url.pathname === '/internal/email' && req.method === 'POST') return relayEmail(req, env);
    if (url.pathname.startsWith('/internal/')) return json({ error: 'Not found' }, 404);
    if (url.pathname === '/api/ai' && req.method === 'POST') {
      if (!env.AI) return json({ error: 'The AI assistant is not configured here.' }, 503);
      return ai(req, env);
    }
    if (url.pathname.startsWith('/api/')) {
      if (env.DB && env.API_MODE !== 'proxy') return edgeApp(env).fetch(req);
      return proxy(req, env, url);
    }
    if (url.pathname === '/app') return Response.redirect(`${url.origin}/app/`, 301);
    if (url.pathname.startsWith('/app/')) {
      // A file (assets, logos) is served as is; anything else is a client-side route (/app/note/…, /app/issue)
      // and gets the app shell.
      if (/\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(req);
      return env.ASSETS.fetch(new Request(`${url.origin}/app/`, req));
    }
    return env.ASSETS.fetch(req);
  },

  /** Every minute: index both chains into D1, then plan, queue and send due notifications. */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (!env.DB) return;
    const work = runCron({
      store: new Store(env.DB),
      config: edgeConfig(env),
      sender: senderOf(env),
      siteUrl: siteOf(env),
      chainLabel,
    }).then((r) => {
      console.log(
        JSON.stringify({
          cron: 'indexer',
          ms: r.ms,
          queries: r.queries,
          sent: r.sent,
          notify: r.notify && {
            notes: r.notify.notes,
            queued: r.notify.queued,
            held: r.notify.held,
            failed: r.notify.failed,
            notConfigured: r.notify.notConfigured,
          },
          chains: r.chains.map((ch) => ({
            chain: ch.chain,
            rpc: ch.rpcCalls,
            steps: ch.steps.length,
            events: ch.steps.reduce((a, x) => a + x.events, 0),
            to: ch.steps.at(-1)?.to,
            error: ch.error,
          })),
        }),
      );
    });
    ctx.waitUntil(work);
    await work;
  },
};

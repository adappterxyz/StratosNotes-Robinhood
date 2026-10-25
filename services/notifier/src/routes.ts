/**
 * Verified emails and email alerts: the HTTP routes (docs/NOTIFICATIONS.md). Portable: Web Crypto and
 * @noble/hashes only, so the same routes run in the Node API and in the notes.markets Worker (on D1).
 *
 *   POST /api/alerts/start          {address, email, categories, issuedAt, signature}  -> a 6-digit code (and a link) by email
 *   POST /api/alerts/verify         {address, code}                                    -> verified; salt and hash fixed
 *   GET  /api/alerts/confirm?token=                                                    -> the link alternative to the code
 *   POST /api/alerts/attestation    {address, chain}                                   -> the verifier's EIP-712 attestation to submit on-chain
 *   GET  /api/alerts/status?address=                                                   -> verified? masked email, preferences
 *   POST /api/alerts/preferences    {address, categories, issuedAt, signature}
 *   POST /api/alerts/salt           {address, issuedAt, signature}                     -> the person's email, salt and hash (proof)
 *   POST /api/alerts/emails         {address, issuedAt, signature, before?, limit?}    -> the wallet's own emails (copies), newest first
 *   POST /api/alerts/unsubscribe    {token}                                            -> one click, from any alert
 *   GET  /api/dev/emails?to=        (only with the in-memory dev sender)               -> what was "sent", for local e2e
 *
 * A verified email is required to issue and to subscribe: the app gates its buttons on /status, and the engine
 * enforces it on-chain when requireEmail is on (the attestation binds keccak256(abi.encode(salt, email))).
 */
import type { Context, Hono } from 'hono';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  isAddress,
  keccak256,
  verifyMessage,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { NOTIFY_CATEGORIES } from '@sn/core';
import { flowEngineAbi } from '@sn/sdk';
import type { EmailSender, MockSender } from './sender';
import { MESSAGES_KEPT, type AlertsStore } from './store';
import { alertsMessage, isEmail, maskEmail, normEmail, render, templateFor, TEMPLATES, type Vars } from './templates';

/** The chains the API serves (key, RPC, engine), as in the API config. */
export interface AlertsChain {
  key: string;
  rpc: string;
  engine: string;
}
/** A fixed-window limiter: in memory (Node) or a D1 counter (Worker). True when allowed. */
export interface AlertsLimiter {
  take(bucket: string, client: string, limit: number, windowMs: number): boolean | Promise<boolean>;
}

export interface AlertsDeps {
  store: AlertsStore;
  sender: EmailSender;
  /** The engine's `verifier` key (hex): signs attestations. Null: verification works, attestations are refused. */
  verifierKey: Hex | null;
  /** Public site origin, for links in emails (https://notes.markets). */
  siteUrl: string;
  /** The in-memory dev sender, exposed at /api/dev/emails for local e2e. */
  devMailbox?: MockSender;
  /** The engine's current attestation nonce for a holder (tests inject it; default: read the chain). */
  nonceOf?: (chainKey: string, holder: Address) => Promise<{ chainId: number; nonce: bigint }>;
}

const CODE_TTL = 600,
  MAX_CODE_ATTEMPTS = 5,
  SIG_SKEW = 600,
  ATTEST_TTL = 365 * 86_400;
const Address_ = z
  .string()
  .refine(isAddress, 'must be an address')
  .transform((a) => a.toLowerCase());
const Categories = z.array(z.enum(NOTIFY_CATEGORIES as [string, ...string[]])).max(4);
const Signed = { address: Address_, issuedAt: z.number().int(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) };
const StartBody = z.object({ ...Signed, email: z.string().max(254), categories: Categories });
const PrefsBody = z.object({ ...Signed, categories: Categories });
const SaltBody = z.object(Signed);
const EmailsBody = z.object({
  ...Signed,
  before: z.object({ at: z.number().int().min(0), id: z.string().min(1).max(400) }).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
const VerifyBody = z.object({ address: Address_, code: z.string().regex(/^\d{6}$/) });
const AttestBody = z.object({ address: Address_, chain: z.string().regex(/^[a-z0-9-]{1,40}$/) });

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sha = (s: string) => hex(nobleSha256(new TextEncoder().encode(s)));
/** Constant-time comparison of two hex strings. */
const sameHex = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
/** A uniform 6-digit code (rejection sampling over 32-bit values). */
function randomCode(): string {
  const max = 4_294_000_000; // a multiple of 1,000,000 below 2^32
  for (;;) {
    const v = crypto.getRandomValues(new Uint32Array(1))[0];
    if (v < max) return String(v % 1_000_000).padStart(6, '0');
  }
}
/** keccak256(abi.encode(bytes32 salt, string email)): what the engine stores for a verified email. */
export const emailHashOf = (salt: Hex, email: string) =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [salt, normEmail(email)]));

export function alertsRoutes(
  app: Hono,
  deps: AlertsDeps,
  ctx: { config: { chains: AlertsChain[] }; limiter: AlertsLimiter; ipOf: (c: Context) => string; now: () => number },
) {
  const { store, sender } = deps;
  const sec = () => Math.floor(ctx.now() / 1000);
  const err = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503, error: string) =>
    c.json({ error }, status);
  const appUrl = `${deps.siteUrl.replace(/\/$/, '')}/app`;
  const clients = new Map<string, ReturnType<typeof createPublicClient>>();
  const nonceOf =
    deps.nonceOf ??
    (async (chainKey: string, holder: Address) => {
      const ch = ctx.config.chains.find((x) => x.key === chainKey)!;
      let cl = clients.get(chainKey);
      if (!cl) {
        cl = createPublicClient({ transport: http(ch.rpc) });
        clients.set(chainKey, cl);
      }
      const [chainId, [, , nonce]] = await Promise.all([
        cl.getChainId(),
        cl.readContract({
          address: ch.engine as Address,
          abi: flowEngineAbi,
          functionName: 'emailOf',
          args: [holder],
        }) as Promise<readonly [Hex, bigint, bigint]>,
      ]);
      return { chainId, nonce: BigInt(nonce) };
    });

  async function checkSig(
    c: Context,
    a: { address: string; issuedAt: number; signature: string },
    message: string,
  ): Promise<Response | null> {
    if (Math.abs(sec() - a.issuedAt) > SIG_SKEW) return err(c, 401, 'The signature is too old; sign again.');
    const ok = await verifyMessage({ address: a.address as Address, message, signature: a.signature as Hex }).catch(
      () => false,
    );
    return ok ? null : err(c, 401, 'The signature does not match this wallet.');
  }

  async function sendCode(address: string, email: string, code: string, linkToken: string) {
    const r = render(TEMPLATES.code, { code, link: `${appUrl}/alerts/confirm?token=${linkToken}` });
    await sender.send({ to: email, ...r });
    void address;
  }

  app.post('/api/alerts/start', async (c) => {
    const ip = ctx.ipOf(c);
    if (!(await ctx.limiter.take('alerts-start-ip', ip, 10, 3_600_000)))
      return err(c, 429, 'Too many verification emails from here; try again in an hour.');
    const b = StartBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const email = normEmail(b.data.email);
    if (!isEmail(email)) return err(c, 400, 'That does not look like an email address.');
    const bad = await checkSig(
      c,
      b.data,
      alertsMessage({
        action: 'verify',
        address: b.data.address,
        email,
        categories: b.data.categories,
        issuedAt: b.data.issuedAt,
      }),
    );
    if (bad) return bad;
    if (!(await ctx.limiter.take('alerts-start-addr', b.data.address, 5, 3_600_000)))
      return err(c, 429, 'Too many codes for this wallet; try again in an hour.');
    const code = randomCode();
    const link = randomHex(32);
    const existing = await store.binding(b.data.address);
    await store.startVerification({
      address: b.data.address,
      email,
      categories: b.data.categories,
      codeHash: sha(`${b.data.address}:${code}`),
      codeExpires: sec() + CODE_TTL,
      linkTokenHash: sha(link),
      unsubscribeToken: existing?.unsubscribeToken ?? randomHex(24),
      now: sec(),
    });
    try {
      await sendCode(b.data.address, email, code, link);
    } catch (e) {
      return err(
        c,
        503,
        `We could not send the email right now (${e instanceof Error ? e.message : 'unknown error'}). Try again shortly.`,
      );
    }
    return c.json({ sent: true, to: maskEmail(email), expiresIn: CODE_TTL });
  });

  async function complete(address: string) {
    const b = await store.binding(address);
    if (!b?.pendingEmail) return null;
    const salt = `0x${randomHex(32)}` as Hex;
    await store.completeVerification(address, salt, emailHashOf(salt, b.pendingEmail), sec());
    return store.binding(address);
  }

  app.post('/api/alerts/verify', async (c) => {
    if (!(await ctx.limiter.take('alerts-verify-ip', ctx.ipOf(c), 30, 3_600_000)))
      return err(c, 429, 'Too many attempts; try again later.');
    const b = VerifyBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'Enter the 6-digit code from the email.');
    const cur = await store.binding(b.data.address);
    if (!cur?.pendingEmail || !cur.codeHash)
      return err(c, 404, 'No verification is waiting for this wallet; ask for a new code.');
    if (cur.codeAttempts >= MAX_CODE_ATTEMPTS) return err(c, 429, 'Too many wrong codes; ask for a new one.');
    if ((cur.codeExpires ?? 0) < sec()) return err(c, 401, 'That code has expired; ask for a new one.');
    await store.countAttempt(b.data.address, sec());
    if (!sameHex(sha(`${b.data.address}:${b.data.code}`), cur.codeHash))
      return err(c, 401, 'That code is not right; check the email and try again.');
    const done = await complete(b.data.address);
    return c.json({ verified: true, email: maskEmail(done!.email!), emailHash: done!.emailHash });
  });

  app.get('/api/alerts/confirm', async (c) => {
    const token = c.req.query('token') ?? '';
    if (!/^[0-9a-f]{64}$/.test(token)) return err(c, 400, 'This link is not valid.');
    const b = await store.byLinkToken(sha(token));
    if (!b?.pendingEmail || (b.codeExpires ?? 0) < sec())
      return err(c, 404, 'This link has expired or was already used; ask for a new code.');
    const done = await complete(b.address);
    return c.json({ verified: true, address: done!.address, email: maskEmail(done!.email!) });
  });

  app.post('/api/alerts/attestation', async (c) => {
    const b = AttestBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'Send {address, chain}.');
    if (!deps.verifierKey) return err(c, 503, 'On-chain email attestations are not enabled on this server.');
    const ch = ctx.config.chains.find((x) => x.key === b.data.chain);
    if (!ch) return err(c, 404, 'Unknown chain.');
    const bind = await store.binding(b.data.address);
    if (!bind?.verifiedAt || !bind.emailHash) return err(c, 403, 'Verify an email for this wallet first.');
    let chainId: number, nonce: bigint;
    try {
      ({ chainId, nonce } = await nonceOf(ch.key, b.data.address as Address));
    } catch {
      return err(c, 502, 'Could not read the chain right now; try again.');
    }
    const expiry = BigInt(sec() + ATTEST_TTL);
    const signature = await privateKeyToAccount(deps.verifierKey).signTypedData({
      domain: { name: 'notes.markets', version: '1', chainId, verifyingContract: ch.engine as Address },
      types: {
        EmailAttestation: [
          { name: 'holder', type: 'address' },
          { name: 'emailHash', type: 'bytes32' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      primaryType: 'EmailAttestation',
      message: { holder: b.data.address as Address, emailHash: bind.emailHash as Hex, expiry, nonce },
    });
    return c.json({
      chain: ch.key,
      chainId,
      engine: ch.engine,
      holder: b.data.address,
      emailHash: bind.emailHash,
      expiry: Number(expiry),
      nonce: nonce.toString(),
      signature,
    });
  });

  app.get('/api/alerts/status', async (c) => {
    const a = Address_.safeParse(c.req.query('address') ?? '');
    if (!a.success) return err(c, 400, 'address: must be an address');
    const b = await store.binding(a.data);
    return c.json({
      address: a.data,
      verified: !!b?.verifiedAt,
      email: b?.email ? maskEmail(b.email) : null,
      emailHash: b?.emailHash ?? null,
      pending: b?.pendingEmail ? maskEmail(b.pendingEmail) : null,
      categories: b?.unsubscribed ? [] : (b?.categories ?? []),
      unsubscribed: !!b?.unsubscribed,
    });
  });

  app.post('/api/alerts/preferences', async (c) => {
    const b = PrefsBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const bad = await checkSig(
      c,
      b.data,
      alertsMessage({
        action: 'preferences',
        address: b.data.address,
        categories: b.data.categories,
        issuedAt: b.data.issuedAt,
      }),
    );
    if (bad) return bad;
    if (!(await store.binding(b.data.address))?.verifiedAt)
      return err(c, 404, 'Verify an email for this wallet first.');
    await store.setCategories(b.data.address, b.data.categories, sec());
    return c.json({ ok: true, categories: b.data.categories });
  });

  app.post('/api/alerts/salt', async (c) => {
    const b = SaltBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'Send {address, issuedAt, signature}.');
    const bad = await checkSig(
      c,
      b.data,
      alertsMessage({ action: 'salt', address: b.data.address, issuedAt: b.data.issuedAt }),
    );
    if (bad) return bad;
    const bind = await store.binding(b.data.address);
    if (!bind?.verifiedAt) return err(c, 404, 'This wallet has no verified email.');
    return c.json({
      address: bind.address,
      email: bind.email,
      salt: bind.salt,
      emailHash: bind.emailHash,
      formula: 'keccak256(abi.encode(bytes32 salt, string lowercase(trim(email))))',
    });
  });

  /**
   * The emails sent to this wallet's verified address: copies kept by the notifier (the newest MESSAGES_KEPT),
   * plus on the first page what is still queued. Only for the wallet that signs (EIP-191, issuedAt within ten
   * minutes, so one signature serves "load more" for a while); never another address's mail, never the salt.
   * Verification-code emails are not kept (their codes would be stored in the clear).
   */
  app.post('/api/alerts/emails', async (c) => {
    if (!(await ctx.limiter.take('alerts-emails-ip', ctx.ipOf(c), 240, 3_600_000)))
      return err(c, 429, 'Too many requests; try again later.');
    const b = EmailsBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'Send {address, issuedAt, signature}.');
    const bad = await checkSig(
      c,
      b.data,
      alertsMessage({ action: 'emails', address: b.data.address, issuedAt: b.data.issuedAt }),
    );
    if (bad) return bad;
    if (!(await ctx.limiter.take('alerts-emails-addr', b.data.address, 240, 3_600_000)))
      return err(c, 429, 'Too many requests; try again later.');
    const bind = await store.binding(b.data.address);
    if (!bind?.verifiedAt) return err(c, 404, 'This wallet has no verified email.');
    const page = await store.messages(bind.address, { before: b.data.before, limit: b.data.limit + 1 });
    const more = page.length > b.data.limit;
    const emails = page.slice(0, b.data.limit).map((m) => ({
      id: m.dedupe,
      at: m.sentAt,
      status: m.status,
      subject: m.subject,
      noteId: m.noteId,
      note: m.noteLabel,
      category: m.category,
      to: m.recipient,
      html: m.html,
      text: m.text,
    }));
    // What is still to come (first page only): rendered now, as it would be sent.
    const queued = b.data.before
      ? []
      : (await store.queued(bind.address)).flatMap((q) => {
          const p = JSON.parse(q.payload) as { template?: string; subject?: string; body?: string; vars?: Vars };
          const t = templateFor(p.template, p);
          if (!t || !bind.email) return [];
          const vars = p.vars ?? {};
          const r = render(
            vars.reminder ? { ...t, subject: `Reminder: ${t.subject}` } : t,
            vars,
            `${appUrl}/alerts/unsubscribe?token=${bind.unsubscribeToken}`,
          );
          return [
            {
              id: q.dedupe,
              at: Math.max(q.sendAfter, q.nextAt),
              status: 'queued' as const,
              subject: r.subject,
              noteId: q.noteId,
              note: vars.note ?? null,
              category: q.category,
              to: maskEmail(bind.email),
              html: r.html,
              text: r.text,
            },
          ];
        });
    const last = emails.at(-1);
    return c.json({
      address: bind.address,
      emails,
      queued,
      next: more && last ? { at: last.at, id: last.id } : null,
      kept: MESSAGES_KEPT,
    });
  });

  app.post('/api/alerts/unsubscribe', async (c) => {
    const b = z.object({ token: z.string().regex(/^[0-9a-f]{48}$/) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'This link is not valid.');
    return (await store.unsubscribe(b.data.token, sec()))
      ? c.json({ ok: true })
      : err(c, 404, 'This link is not valid.');
  });

  if (deps.devMailbox) {
    const box = deps.devMailbox;
    app.get('/api/dev/emails', (c) => {
      const to = (c.req.query('to') ?? '').toLowerCase();
      return c.json({
        emails: box.sent
          .filter((e) => !to || e.to.toLowerCase() === to)
          .slice(-20)
          .map((e) => ({ to: e.to, subject: e.subject, text: e.text })),
      });
    });
  }
}

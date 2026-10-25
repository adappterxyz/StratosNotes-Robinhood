/**
 * The StratosNotes API (Hono): notes, portfolios, templates, AI and live updates, over the indexer's read model.
 *
 *   GET  /api/health
 *   GET  /api/config                     chains the app can use: RPC, engine, lens, stablecoin, test tokens, CRE support
 *   GET  /api/notes?chain&status&underlying&product&q&limit&cursor
 *   GET  /api/notes/:id                  state, view, holders
 *   GET  /api/notes/:id/history?limit
 *   GET  /api/definitions/:chain/:id     the definition's bytes (CORE ‖ META), hex
 *   GET  /api/portfolio/:address
 *   GET  /api/templates  ·  GET /api/templates/:definition  ·  POST /api/templates (EIP-191 signed)
 *   POST /api/ai                         term sheet -> note, edits to the open workflow, questions
 *   POST /api/faucet                     dev chains only: mint the mock stablecoin
 *   GET  /api/stream?notes=a,b|chain=x   Server-Sent Events: `notes` when the indexer commits changes
 *   /api/alerts/*                        verified emails and email alerts (alerts.ts)
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { createWalletClient, http, isAddress, verifyMessage, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import {
  compileTemplate,
  definitionId,
  runAi,
  summarize,
  templateMessage,
  templateOffered,
  type AiRunner,
  type TemplateEntry,
  type WorkflowDraft,
} from '@sn/core';
import { CHAINS, mockErc20Abi, noteView, parseNoteId, positionOf, type NoteState } from '@sn/sdk';
import { loadDef, NOTIFY_CHANNEL, type Db } from '@sn/indexer';
import { alertsRoutes, type AlertsDeps } from './alerts';
import type { ApiConfig } from './config';
import { RateLimiter } from './ratelimit';

export interface AppDeps {
  db: Db;
  config: ApiConfig;
  /** Workers AI (null: the assistant is off). */
  ai: AiRunner | null;
  /** Dev faucet signer key (hex), when a chain has a faucet. */
  faucetKey?: Hex;
  /** Client IP for a request (the Node server passes the socket address). */
  clientIp?: (c: Context) => string;
  /** When set, X-Forwarded-For is trusted only on requests carrying it in X-SN-Proxy (the site's Worker adds it),
   * so a caller reaching the API directly cannot spoof its IP past the rate limits. */
  proxySecret?: string;
  now?: () => number;
  /** Verified emails and email alerts (alerts.ts); off when absent. */
  alerts?: AlertsDeps;
}

const err = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503, error: string) =>
  c.json({ error }, status);

const NoteQuery = z.object({
  chain: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
  status: z.enum(['book', 'live', 'redeemed', 'active', 'all']).default('all'),
  underlying: z
    .string()
    .regex(/^[A-Za-z0-9.]{1,12}$/)
    .optional(),
  product: z.enum(['fcn', 'reverse-convertible', 'phoenix', 'snowball', 'ppn', 'custom']).optional(),
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

const TemplateBody = z.object({
  entry: z.object({
    definition: z.string().regex(/^0x[0-9a-f]{64}$/),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(280),
    author: z.string().refine(isAddress, 'author must be an address'),
    product: z.unknown().optional(),
    bpmnXml: z.string().max(250_000).optional(),
    assets: z.array(z.unknown()).max(16).optional(),
    basis: z.unknown().optional(),
  }),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

const AiBody = z.object({ prompt: z.string().trim().min(1).max(4000), draft: z.unknown().optional() });
const FaucetBody = z.object({ chain: z.string(), address: z.string().refine(isAddress) });

const parseState = (s: NoteState | string): NoteState => (typeof s === 'string' ? JSON.parse(s) : s);

export function createApp(deps: AppDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => Date.now());
  const limiter = new RateLimiter();
  const streams = new Map<string, number>();
  const chainKeys = new Set(config.chains.map((c) => c.key));
  const ipOf = (c: Context) => {
    if (config.trustProxy && (!deps.proxySecret || c.req.header('x-sn-proxy') === deps.proxySecret)) {
      const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (fwd) return fwd;
    }
    return deps.clientIp?.(c) ?? 'unknown';
  };
  const allowed = (origin: string | undefined) => !origin || config.allowedOrigins.includes(origin);

  // Live updates: one LISTEN connection, fanned out to every open stream.
  const listeners = new Set<(p: { chain: string; notes?: string[]; all?: boolean }) => void>();
  let listening: Promise<unknown> | null = null;
  const ensureListening = () => {
    listening ??= db.listen(NOTIFY_CHANNEL, (payload) => {
      let p: { chain: string; notes?: string[]; all?: boolean };
      try {
        p = JSON.parse(payload);
      } catch {
        return;
      }
      for (const l of listeners) l(p);
    });
    return listening;
  };

  const app = new Hono();
  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  app.use(
    '/api/*',
    cors({
      origin: (o) => (config.allowedOrigins.includes(o) ? o : null),
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );
  // Writes must come from an allowed origin (browsers always send Origin on POST); reads are rate-limited.
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' && !allowed(c.req.header('origin')))
      return err(c, 403, 'Not allowed from this origin.');
    if (
      c.req.method === 'GET' &&
      !c.req.path.startsWith('/api/stream') &&
      !limiter.take('read', ipOf(c), config.limits.readsPerMinute, 60_000)
    ) {
      return err(c, 429, 'Too many requests; slow down.');
    }
    await next();
  });
  app.onError((e, c) => {
    console.error(e);
    return err(c, 500, 'Something went wrong on our side.');
  });

  if (deps.alerts) alertsRoutes(app, deps.alerts, { config, limiter, ipOf, now });

  app.get('/api/health', async (c) => {
    const chains = await db.query<{ chain: string; cursor: string; head: string | null; updated_at: string }>(
      'SELECT chain, cursor, head, updated_at FROM chains ORDER BY chain',
    );
    return c.json({
      ok: true,
      chains: chains.map((r) => ({
        chain: r.chain,
        cursor: Number(r.cursor),
        head: r.head === null ? null : Number(r.head),
        updatedAt: r.updated_at,
      })),
    });
  });

  app.get('/api/config', (c) =>
    c.json({
      chains: config.chains.map((ch) => ({
        ...(CHAINS[ch.key] ?? { key: ch.key, family: 'evm', name: ch.key, testnet: true, cre: false }),
        rpc: ch.rpc,
        engine: ch.engine.toLowerCase(),
        lens: ch.lens.toLowerCase(),
        fromBlock: ch.fromBlock,
        stablecoin: ch.stablecoin,
        faucet: !!ch.faucet,
        tokenFaucet: ch.tokenFaucet ?? null,
        tokens: ch.tokens,
        crossChain: ch.crossChain ?? null,
        legacyEngines: ch.legacyEngines.map((l) => ({
          engine: l.engine.toLowerCase(),
          lens: l.lens.toLowerCase(),
          fromBlock: l.fromBlock,
          version: l.version,
          tokens: l.tokens,
          crossChain: l.crossChain ?? null,
        })),
        previousCrossChain: ch.previousCrossChain,
      })),
      ai: !!deps.ai,
    }),
  );

  // ---- notes --------------------------------------------------------------------------------------------------

  async function views(rows: Array<{ state: NoteState | string; definition: string; chain: string }>) {
    const out = [];
    for (const r of rows) {
      const s = parseState(r.state);
      const def = await loadDef(db, r.chain, r.definition);
      if (!def) continue;
      out.push({ id: s.id, chain: s.chain, definition: s.definition, view: noteView(def, s, now() / 1000) });
    }
    return out;
  }

  app.get('/api/notes', async (c) => {
    const q = NoteQuery.safeParse(c.req.query());
    if (!q.success) return err(c, 400, q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const f = q.data;
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const t = Math.floor(now() / 1000);
    const book = () => `(status = 0 AND window_open AND (strike_date IS NULL OR strike_date > ${p(t)}))`;
    if (f.chain) where.push(`chain = ${p(f.chain)}`);
    if (f.status === 'redeemed') where.push('status = 1');
    else if (f.status === 'active') where.push('status = 0');
    else if (f.status === 'book') where.push(book());
    else if (f.status === 'live') where.push(`status = 0 AND NOT ${book()}`);
    if (f.underlying) where.push(`${p(f.underlying.toUpperCase())} = ANY(underlyings)`);
    if (f.product === 'custom') where.push('product_type IS NULL');
    else if (f.product) where.push(`product_type = ${p(f.product)}`);
    if (f.q) {
      // Name or anything in the note's captured values (e.g. the ISIN); LIKE wildcards in the query are literal.
      const like = p(`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      where.push(`(name ILIKE ${like} OR (state->'values')::text ILIKE ${like})`);
    }
    if (f.cursor) {
      let cur: { t: number; id: string };
      try {
        cur = JSON.parse(Buffer.from(f.cursor, 'base64url').toString());
      } catch {
        return err(c, 400, 'cursor: not a valid cursor');
      }
      if (typeof cur?.t !== 'number' || typeof cur?.id !== 'string') return err(c, 400, 'cursor: not a valid cursor');
      where.push(`(created_at, id) < (${p(cur.t)}, ${p(cur.id)})`);
    }
    const rows = await db.query<{
      id: string;
      chain: string;
      definition: string;
      state: NoteState;
      created_at: string;
    }>(
      `SELECT id, chain, definition, state, created_at FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ${p(f.limit + 1)}`,
      params,
    );
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    const next =
      rows.length > f.limit && last
        ? Buffer.from(JSON.stringify({ t: Number(last.created_at), id: last.id })).toString('base64url')
        : null;
    return c.json({ notes: await views(page), next });
  });

  app.get('/api/notes/:id', async (c) => {
    const id = c.req.param('id');
    if (!parseNoteId(id)) return err(c, 400, 'Not a note id.');
    const [row] = await db.query<{ state: NoteState; chain: string; definition: string }>(
      'SELECT state, chain, definition FROM notes WHERE id = $1',
      [id],
    );
    if (!row) return err(c, 404, 'No note with this id.');
    const s = parseState(row.state);
    const def = await loadDef(db, row.chain, row.definition);
    if (!def) return err(c, 404, "The note's workflow is not indexed yet.");
    return c.json({ state: s, view: noteView(def, s, now() / 1000) });
  });

  app.get('/api/notes/:id/history', async (c) => {
    const id = c.req.param('id');
    if (!parseNoteId(id)) return err(c, 400, 'Not a note id.');
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200) || 200));
    const rows = await db.query<{ seq: string; name: string; block: string; tx: string; ts: string; data: unknown }>(
      'SELECT seq, name, block, tx, ts, data FROM events WHERE note_id = $1 ORDER BY block DESC, log_index DESC LIMIT $2',
      [id, limit],
    );
    const events = rows.map((r) => ({
      seq: Number(r.seq),
      name: r.name,
      block: Number(r.block),
      tx: r.tx,
      at: Number(r.ts),
      data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Record<string, unknown>,
    }));
    return c.json({ events });
  });

  app.get('/api/definitions/:chain/:id', async (c) => {
    const { chain, id } = c.req.param();
    if (!/^0x[0-9a-f]{64}$/.test(id)) return err(c, 400, 'Not a definition id.');
    const [row] = await db.query<{ bytes: Uint8Array }>('SELECT bytes FROM definitions WHERE chain = $1 AND id = $2', [
      chain,
      id,
    ]);
    if (!row) return err(c, 404, 'No such definition on this chain.');
    c.header('Cache-Control', 'public, max-age=31536000, immutable'); // content-addressed
    return c.json({ id, bytes: `0x${Buffer.from(row.bytes).toString('hex')}` });
  });

  app.get('/api/portfolio/:address', async (c) => {
    const address = c.req.param('address');
    if (!isAddress(address)) return err(c, 400, 'Not an address.');
    const rows = await db.query<{ state: NoteState; chain: string; definition: string }>(
      'SELECT DISTINCT n.id, n.state, n.chain, n.definition, n.created_at FROM holdings h JOIN notes n ON n.id = h.note_id WHERE h.owner = $1 ORDER BY n.created_at DESC',
      [address.toLowerCase()],
    );
    const out = [];
    for (const v of await views(rows)) {
      const s = parseState(rows.find((r) => parseState(r.state).id === v.id)!.state);
      const pos = positionOf(s, address);
      out.push({
        ...v,
        position: {
          units: pos.units,
          cash: pos.cash,
          holdings: s.holdings.filter((h) => h.owner === address.toLowerCase()),
        },
      });
    }
    // Payouts paid to this wallet (FlowEngine v4: its claims, or pushes), newest first, each with its receipt id and transaction.
    const paid = await db.query<{ note_id: string; tx: string; ts: string; data: Record<string, unknown> }>(
      "SELECT note_id, tx, ts, data FROM events WHERE name = 'PayoutPaid' AND data->>'holder' = $1 ORDER BY seq DESC LIMIT 200",
      [address.toLowerCase()],
    );
    const payouts = paid.map((r) => ({
      noteId: r.note_id,
      asset: Number(r.data.asset),
      period: Number(r.data.period),
      amount: String(r.data.amount),
      payoutId: String(r.data.payoutId),
      tx: r.tx,
      at: Number(r.ts),
    }));
    return c.json({ positions: out, payouts });
  });

  // ---- templates ----------------------------------------------------------------------------------------------

  app.get('/api/templates', async (c) => {
    const rows = await db.query<{
      definition: string;
      name: string;
      description: string;
      author: string;
      kind: string;
      label: string;
      created_at: string;
      entry: TemplateEntry | string;
    }>(
      'SELECT definition, name, description, author, kind, label, created_at, entry FROM templates ORDER BY created_at DESC LIMIT 500',
    );
    // Entries saved before the test tokens were retired (tAAPL delivery…) are kept but no longer listed.
    return c.json(
      rows
        .filter((r) => templateOffered(typeof r.entry === 'string' ? JSON.parse(r.entry) : r.entry))
        .map((r) => ({
          definition: r.definition,
          name: r.name,
          description: r.description,
          author: r.author,
          kind: r.kind,
          label: r.label,
          createdAt: Number(r.created_at),
        })),
    );
  });

  app.get('/api/templates/:definition', async (c) => {
    const [row] = await db.query<{ entry: TemplateEntry }>('SELECT entry FROM templates WHERE definition = $1', [
      c.req.param('definition'),
    ]);
    if (!row) return err(c, 404, 'No template with this definition.');
    return c.json(typeof row.entry === 'string' ? JSON.parse(row.entry) : row.entry);
  });

  app.post(
    '/api/templates',
    bodyLimit({ maxSize: 300_000, onError: (c) => err(c, 413, 'The workflow is too large to save as a template.') }),
    async (c) => {
      if (!limiter.take('tpl', ipOf(c), config.limits.templatesPerHour, 3_600_000))
        return err(c, 429, 'Too many templates this hour; try again later.');
      const b = TemplateBody.safeParse(await c.req.json().catch(() => null));
      if (!b.success) return err(c, 400, b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const e = b.data.entry;
      const good = await verifyMessage({
        address: e.author as Hex,
        message: templateMessage(e.definition),
        signature: b.data.signature as Hex,
      }).catch(() => false);
      if (!good) return err(c, 401, 'The wallet signature does not match the author.');
      const entry: TemplateEntry = {
        definition: e.definition,
        name: e.name,
        description: e.description.trim(),
        author: e.author.toLowerCase(),
        createdAt: Math.floor(now() / 1000),
        ...(e.product ? { product: e.product as TemplateEntry['product'] } : {}),
        ...(e.bpmnXml ? { bpmnXml: e.bpmnXml, assets: e.assets as TemplateEntry['assets'] } : {}),
        ...(e.basis ? { basis: e.basis as TemplateEntry['basis'] } : {}),
      };
      // Notes run on Robinhood Chain only: a term sheet naming another chain, collateral held elsewhere, a token that does
      // not exist there (e.g. physical delivery of NVDA) or a retired test token is refused.
      if (!templateOffered(entry))
        return err(
          c,
          400,
          "This note can't be issued: notes run on Robinhood Chain testnet only, every token a note delivers or pledges must exist there, and no retired test token may appear.",
        );
      let id: string;
      try {
        id = definitionId(compileTemplate(entry));
      } catch (x) {
        return err(c, 400, `The workflow does not compile: ${x instanceof Error ? x.message : String(x)}`);
      }
      if (id !== e.definition) return err(c, 400, 'The workflow does not match the definition it names.');
      const s = summarize(entry);
      const r = await db.query(
        'INSERT INTO templates (definition, name, description, author, signature, kind, label, entry, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (definition) DO NOTHING RETURNING definition',
        [
          entry.definition,
          entry.name,
          entry.description,
          entry.author,
          b.data.signature,
          s.kind,
          s.label,
          JSON.stringify(entry),
          entry.createdAt,
        ],
      );
      if (!r.length) return err(c, 409, 'This workflow is already in the library.');
      return c.json(s, 201);
    },
  );

  // ---- AI -----------------------------------------------------------------------------------------------------

  app.post(
    '/api/ai',
    bodyLimit({ maxSize: 200_000, onError: (c) => err(c, 413, 'The request is too large.') }),
    async (c) => {
      if (!deps.ai) return err(c, 503, 'The AI assistant is not configured on this server.');
      if (!limiter.take('ai', ipOf(c), config.limits.aiPerHour, 3_600_000))
        return err(c, 429, 'Too many AI requests this hour; try again later.');
      const b = AiBody.safeParse(await c.req.json().catch(() => null));
      if (!b.success)
        return err(
          c,
          400,
          'Say what you want: a note from terms, a change to the workflow, or a question (up to 4,000 characters).',
        );
      try {
        return c.json(
          await runAi(deps.ai, {
            prompt: b.data.prompt,
            today: new Date(now()).toISOString().slice(0, 10),
            draft: b.data.draft as WorkflowDraft | undefined,
          }),
        );
      } catch (x) {
        return c.json({ kind: 'error', error: x instanceof Error ? x.message : String(x) }, 502);
      }
    },
  );

  // ---- dev faucet ---------------------------------------------------------------------------------------------

  app.post('/api/faucet', async (c) => {
    const b = FaucetBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'Send { "chain": "<chain key>", "address": "0x…" }.');
    const ch = config.chains.find((x) => x.key === b.data.chain);
    if (!ch?.faucet || !deps.faucetKey)
      return err(c, 404, "This chain has no faucet here. Use the network's own faucet for test stablecoins.");
    if (
      !limiter.take(
        `faucet:${ch.key}`,
        `${ipOf(c)}:${b.data.address.toLowerCase()}`,
        config.limits.faucetPerHour,
        3_600_000,
      )
    )
      return err(c, 429, 'Already sent recently; try again later.');
    const w = createWalletClient({ account: privateKeyToAccount(deps.faucetKey), transport: http(ch.rpc) });
    const amount = BigInt(ch.faucet.amount) * 10n ** BigInt(ch.stablecoin.decimals);
    const hash = await w.writeContract({
      address: ch.faucet.token as Hex,
      abi: mockErc20Abi,
      functionName: 'mint',
      args: [b.data.address as Hex, amount],
      chain: null,
      account: privateKeyToAccount(deps.faucetKey),
    });
    return c.json({ tx: hash, amount: ch.faucet.amount, symbol: ch.stablecoin.symbol });
  });

  // ---- live updates -------------------------------------------------------------------------------------------

  app.get('/api/stream', async (c) => {
    const notes = new Set((c.req.query('notes') ?? '').split(',').filter(Boolean).slice(0, 50));
    const chain = c.req.query('chain');
    if (chain && !chainKeys.has(chain)) return err(c, 400, 'Unknown chain.');
    const ip = ipOf(c);
    if ((streams.get(ip) ?? 0) >= config.limits.streamsPerIp) return err(c, 429, 'Too many open live connections.');
    await ensureListening();
    streams.set(ip, (streams.get(ip) ?? 0) + 1);
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const onNotify = (p: { chain: string; notes?: string[]; all?: boolean }) => {
        if (chain && p.chain !== chain) return;
        const hit = p.all
          ? notes.size
            ? [...notes].filter((n) => n.startsWith(`${p.chain}:`))
            : []
          : (p.notes ?? []).filter((n) => !notes.size || notes.has(n));
        if (!p.all && !hit.length) return;
        queue.push(JSON.stringify({ chain: p.chain, notes: p.all && !notes.size ? null : hit }));
        wake?.();
      };
      listeners.add(onNotify);
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      try {
        await stream.writeSSE({ event: 'ready', data: '{}' });
        while (open) {
          if (!queue.length)
            await new Promise<void>((r) => {
              wake = r;
              setTimeout(r, 15_000);
            });
          wake = null;
          if (!open) break;
          if (!queue.length) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
          while (queue.length) await stream.writeSSE({ event: 'notes', data: queue.shift()! });
        }
      } finally {
        listeners.delete(onNotify);
        streams.set(ip, Math.max(0, (streams.get(ip) ?? 1) - 1));
      }
    });
  });

  return app;
}

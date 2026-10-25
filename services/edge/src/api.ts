/**
 * The notes.markets API on the Worker, over D1. A port of services/api/src/app.ts (Hono on Node over Postgres):
 * the same paths, response shapes, validation and origin rules, so the app is unchanged apart from live updates.
 *
 *   GET  /api/health
 *   GET  /api/config
 *   GET  /api/notes?chain&status&underlying&product&q&limit&cursor
 *   GET  /api/notes/:id                  state, view
 *   GET  /api/notes/:id/history?limit
 *   GET  /api/definitions/:chain/:id     the definition's bytes (CORE ‖ META), hex
 *   GET  /api/portfolio/:address
 *   GET  /api/templates  ·  GET /api/templates/:definition  ·  POST /api/templates (EIP-191 signed)
 *   POST /api/faucet                     dev chains only: mint the mock stablecoin
 *   GET  /api/updates?since&notes&chain  live updates by polling (replaces /api/stream's SSE; D1 has no LISTEN)
 *
 * /api/ai stays in the Worker's entry (Workers AI), ahead of this app.
 *
 * Rate limits: per-minute reads use the Workers rate-limiting binding when present (no D1 writes per request);
 * the hourly template and faucet limits are D1 counters (rare writes).
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { createWalletClient, http, isAddress, verifyMessage, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import {
  compileTemplate,
  definitionId,
  summarize,
  templateMessage,
  templateOffered,
  type TemplateEntry,
} from '@sn/core';
import { CHAINS, mockErc20Abi, noteView, parseNoteId, positionOf, type NoteState } from '@sn/sdk';
import type { ApiConfig } from './config';
import type { Store } from './d1';
import { loadDef, parseState } from './project';
import { AlertsStore, alertsRoutes, type AlertsDeps, type EmailSender, type MockSender } from '@sn/notifier';

export interface RateLimitBinding {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface EdgeAppDeps {
  store: () => Store;
  config: ApiConfig;
  /** Whether /api/ai is served (the Worker's Workers AI binding). */
  ai: boolean;
  faucetKey?: Hex;
  /** Per-minute read limiter (Workers rate-limiting binding). */
  readLimit?: RateLimitBinding;
  /** Verified emails and alerts (/api/alerts/*): the sender for codes, the verifier key that signs on-chain
   *  attestations (null: attestations refused), the public origin for links, and a dev mailbox for local e2e. */
  alerts?: {
    sender: EmailSender;
    verifierKey: Hex | null;
    siteUrl: string;
    devMailbox?: MockSender;
    nonceOf?: AlertsDeps['nonceOf'];
  };
  now?: () => number;
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

const FaucetBody = z.object({ chain: z.string(), address: z.string().refine(isAddress) });
const UpdatesQuery = z.object({
  since: z.coerce.number().int().min(0).optional(),
  notes: z.string().max(4000).optional(),
  chain: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
});

const b64url = {
  encode: (s: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''),
  decode: (s: string) =>
    new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0))),
};

/** Fixed-window hourly counter in D1; true when the call is allowed (and counts it). */
async function takeHourly(
  store: Store,
  bucket: string,
  client: string,
  limit: number,
  nowMs: number,
): Promise<boolean> {
  const window = Math.floor(nowMs / 3_600_000) * 3600;
  const r = await store.first<{ n: number }>(
    `INSERT INTO rate_limits (bucket, client, window_start, n) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (bucket, client, window_start) DO UPDATE SET n = n + 1 RETURNING n`,
    [bucket, client, window],
  );
  return (r?.n ?? 1) <= limit;
}

export function createEdgeApp(deps: EdgeAppDeps) {
  const { config } = deps;
  const now = deps.now ?? (() => Date.now());
  const chainKeys = new Set(config.chains.map((c) => c.key));
  const ipOf = (c: Context) => c.req.header('cf-connecting-ip') ?? 'unknown';
  const allowed = (origin: string | undefined, self: string) =>
    !origin || origin === self || config.allowedOrigins.includes(origin);

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
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' && !allowed(c.req.header('origin'), new URL(c.req.url).origin))
      return err(c, 403, 'Not allowed from this origin.');
    if (c.req.method === 'GET' && deps.readLimit && !(await deps.readLimit.limit({ key: `read:${ipOf(c)}` })).success) {
      return err(c, 429, 'Too many requests; slow down.');
    }
    await next();
  });
  app.onError((e, c) => {
    console.error(e);
    return err(c, 500, 'Something went wrong on our side.');
  });

  app.get('/api/health', async (c) => {
    // One row per indexed (chain, engine): `chain` is the indexer's key (e.g. robinhood-testnet-v3 for an earlier engine).
    const rows = await deps
      .store()
      .all<{ chain: string; engine: string; cursor: number; head: number | null; updated_at: string }>(
        'SELECT chain, engine, cursor, head, updated_at FROM chains ORDER BY chain',
      );
    return c.json({
      ok: true,
      chains: rows.map((r) => ({
        chain: r.chain,
        engine: r.engine,
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
      ai: deps.ai,
    }),
  );

  async function views(store: Store, rows: Array<{ state: NoteState | string; definition: string; chain: string }>) {
    const out = [];
    for (const r of rows) {
      const s = parseState(r.state);
      const def = await loadDef(store, r.chain, r.definition);
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
      return `?${params.length}`;
    };
    const t = Math.floor(now() / 1000);
    const book = () => `(status = 0 AND window_open = 1 AND (strike_date IS NULL OR strike_date > ${p(t)}))`;
    if (f.chain) where.push(`chain = ${p(f.chain)}`);
    if (f.status === 'redeemed') where.push('status = 1');
    else if (f.status === 'active') where.push('status = 0');
    else if (f.status === 'book') where.push(book());
    else if (f.status === 'live') where.push(`status = 0 AND NOT ${book()}`);
    if (f.underlying)
      where.push(
        `EXISTS (SELECT 1 FROM note_underlyings u WHERE u.note_id = notes.id AND u.symbol = ${p(f.underlying.toUpperCase())})`,
      );
    if (f.product === 'custom') where.push('product_type IS NULL');
    else if (f.product) where.push(`product_type = ${p(f.product)}`);
    if (f.q) {
      // Name or anything in the note's captured values (e.g. the ISIN); LIKE wildcards in the query are literal.
      // SQLite's LIKE is case-insensitive for ASCII, like Postgres's ILIKE here.
      const like = p(`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      where.push(`(name LIKE ${like} ESCAPE '\\' OR json_extract(state, '$.values') LIKE ${like} ESCAPE '\\')`);
    }
    if (f.cursor) {
      let cur: { t: number; id: string };
      try {
        cur = JSON.parse(b64url.decode(f.cursor));
      } catch {
        return err(c, 400, 'cursor: not a valid cursor');
      }
      if (typeof cur?.t !== 'number' || typeof cur?.id !== 'string') return err(c, 400, 'cursor: not a valid cursor');
      where.push(`(created_at, id) < (${p(cur.t)}, ${p(cur.id)})`);
    }
    const store = deps.store();
    const rows = await store.all<{ id: string; chain: string; definition: string; state: string; created_at: number }>(
      `SELECT id, chain, definition, state, created_at FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ${p(f.limit + 1)}`,
      params,
    );
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    const next =
      rows.length > f.limit && last ? b64url.encode(JSON.stringify({ t: Number(last.created_at), id: last.id })) : null;
    return c.json({ notes: await views(store, page), next });
  });

  app.get('/api/notes/:id', async (c) => {
    const id = c.req.param('id');
    if (!parseNoteId(id)) return err(c, 400, 'Not a note id.');
    const store = deps.store();
    const row = await store.first<{ state: string; chain: string; definition: string }>(
      'SELECT state, chain, definition FROM notes WHERE id = ?1',
      [id],
    );
    if (!row) return err(c, 404, 'No note with this id.');
    const s = parseState(row.state);
    const def = await loadDef(store, row.chain, row.definition);
    if (!def) return err(c, 404, "The note's workflow is not indexed yet.");
    return c.json({ state: s, view: noteView(def, s, now() / 1000) });
  });

  app.get('/api/notes/:id/history', async (c) => {
    const id = c.req.param('id');
    if (!parseNoteId(id)) return err(c, 400, 'Not a note id.');
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200) || 200));
    const rows = await deps
      .store()
      .all<{ seq: number; name: string; block: number; tx: string; ts: number; data: string }>(
        'SELECT seq, name, block, tx, ts, data FROM events WHERE note_id = ?1 ORDER BY block DESC, log_index DESC LIMIT ?2',
        [id, limit],
      );
    const events = rows.map((r) => ({
      seq: Number(r.seq),
      name: r.name,
      block: Number(r.block),
      tx: r.tx,
      at: Number(r.ts),
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
    return c.json({ events });
  });

  app.get('/api/definitions/:chain/:id', async (c) => {
    const { chain, id } = c.req.param();
    if (!/^0x[0-9a-f]{64}$/.test(id)) return err(c, 400, 'Not a definition id.');
    const row = await deps
      .store()
      .first<{ bytes: string }>('SELECT bytes FROM definitions WHERE chain = ?1 AND id = ?2', [chain, id]);
    if (!row) return err(c, 404, 'No such definition on this chain.');
    c.header('Cache-Control', 'public, max-age=31536000, immutable'); // content-addressed
    return c.json({ id, bytes: row.bytes });
  });

  app.get('/api/portfolio/:address', async (c) => {
    const address = c.req.param('address');
    if (!isAddress(address)) return err(c, 400, 'Not an address.');
    const store = deps.store();
    const rows = await store.all<{ id: string; state: string; chain: string; definition: string }>(
      'SELECT DISTINCT n.id, n.state, n.chain, n.definition, n.created_at FROM holdings h JOIN notes n ON n.id = h.note_id WHERE h.owner = ?1 ORDER BY n.created_at DESC',
      [address.toLowerCase()],
    );
    const out = [];
    for (const v of await views(store, rows)) {
      const s = parseState(rows.find((r) => r.id === v.id)!.state);
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
    const paid = await store.all<{ note_id: string; tx: string; ts: number; data: string }>(
      "SELECT note_id, tx, ts, data FROM events WHERE name = 'PayoutPaid' AND json_extract(data, '$.holder') = ?1 ORDER BY seq DESC LIMIT 200",
      [address.toLowerCase()],
    );
    const payouts = paid.map((r) => {
      const d = JSON.parse(r.data) as Record<string, unknown>;
      return {
        noteId: r.note_id,
        asset: Number(d.asset),
        period: Number(d.period),
        amount: String(d.amount),
        payoutId: String(d.payoutId),
        tx: r.tx,
        at: Number(r.ts),
      };
    });
    return c.json({ positions: out, payouts });
  });

  // ---- templates ----------------------------------------------------------------------------------------------

  app.get('/api/templates', async (c) => {
    const rows = await deps.store().all<{
      definition: string;
      name: string;
      description: string;
      author: string;
      kind: string;
      label: string;
      created_at: number;
      entry: TemplateEntry | string;
    }>('SELECT definition, name, description, author, kind, label, created_at, entry FROM templates ORDER BY created_at DESC LIMIT 500');
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
    const row = await deps
      .store()
      .first<{ entry: string }>('SELECT entry FROM templates WHERE definition = ?1', [c.req.param('definition')]);
    if (!row) return err(c, 404, 'No template with this definition.');
    return c.json(JSON.parse(row.entry));
  });

  app.post(
    '/api/templates',
    bodyLimit({ maxSize: 300_000, onError: (c) => err(c, 413, 'The workflow is too large to save as a template.') }),
    async (c) => {
      const store = deps.store();
      if (!(await takeHourly(store, 'tpl', ipOf(c), config.limits.templatesPerHour, now())))
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
      const r = await store.all(
        'INSERT INTO templates (definition, name, description, author, signature, kind, label, entry, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (definition) DO NOTHING RETURNING definition',
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

  // ---- dev faucet ---------------------------------------------------------------------------------------------

  app.post('/api/faucet', async (c) => {
    const b = FaucetBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'Send { "chain": "<chain key>", "address": "0x…" }.');
    const ch = config.chains.find((x) => x.key === b.data.chain);
    if (!ch?.faucet || !deps.faucetKey)
      return err(c, 404, "This chain has no faucet here. Use the network's own faucet for test stablecoins.");
    if (
      !(await takeHourly(
        deps.store(),
        `faucet:${ch.key}`,
        `${ipOf(c)}:${b.data.address.toLowerCase()}`,
        config.limits.faucetPerHour,
        now(),
      ))
    )
      return err(c, 429, 'Already sent recently; try again later.');
    const account = privateKeyToAccount(deps.faucetKey);
    const w = createWalletClient({ account, transport: http(ch.rpc) });
    const amount = BigInt(ch.faucet.amount) * 10n ** BigInt(ch.stablecoin.decimals);
    const hash = await w.writeContract({
      address: ch.faucet.token as Hex,
      abi: mockErc20Abi,
      functionName: 'mint',
      args: [b.data.address as Hex, amount],
      chain: null,
      account,
    });
    return c.json({ tx: hash, amount: ch.faucet.amount, symbol: ch.stablecoin.symbol });
  });

  // ---- live updates -------------------------------------------------------------------------------------------

  /**
   * Polling replacement for /api/stream. `since` is the last `seq` the client saw: the answer lists what changed
   * after it (filtered to `notes` / `chain`) and the new `seq`. Without `since` it only returns the current seq,
   * so a client starts from now. `notes: null` means "everything on that chain may have changed".
   */
  app.get('/api/updates', async (c) => {
    const q = UpdatesQuery.safeParse(c.req.query());
    if (!q.success) return err(c, 400, 'updates: since must be a number');
    const { since, chain } = q.data;
    if (chain && !chainKeys.has(chain)) return err(c, 400, 'Unknown chain.');
    const notes = new Set((q.data.notes ?? '').split(',').filter(Boolean).slice(0, 50));
    const store = deps.store();
    c.header('Cache-Control', 'no-store');
    if (since === undefined) {
      const r = await store.first<{ seq: number | null }>('SELECT max(seq) AS seq FROM changes');
      return c.json({ seq: Number(r?.seq ?? 0), changes: [] });
    }
    const rows = await store.all<{ seq: number; chain: string; note_id: string | null }>(
      'SELECT seq, chain, note_id FROM changes WHERE seq > ?1 ORDER BY seq LIMIT 500',
      [since],
    );
    const latest = rows.length ? Number(rows[rows.length - 1].seq) : since;
    const byChain = new Map<string, Set<string> | null>();
    for (const r of rows) {
      if (chain && r.chain !== chain) continue;
      if (r.note_id === null) {
        byChain.set(r.chain, null);
        continue;
      }
      if (notes.size && !notes.has(r.note_id)) continue;
      const cur = byChain.get(r.chain);
      if (cur === null) continue;
      byChain.set(r.chain, (cur ?? new Set()).add(r.note_id));
    }
    // A full page means the client fell far behind: tell it to refresh everything.
    const truncated = rows.length === 500;
    const changes = truncated
      ? [...new Set(rows.map((r) => r.chain))].map((ch) => ({ chain: ch, notes: null }))
      : [...byChain].map(([ch, set]) => ({ chain: ch, notes: set === null ? null : [...set] }));
    return c.json({ seq: latest, changes });
  });

  app.get('/api/stream', (c) => err(c, 404, 'Live updates moved to /api/updates (polling); reload the app.'));

  if (deps.alerts) {
    // The notifier's store on D1: each statement goes through this request's Store.
    const store = new AlertsStore({
      all: (sql, params = []) => deps.store().all(sql, params),
      run: async (sql, params = []) => {
        await deps.store().run(sql, params);
      },
    });
    alertsRoutes(
      app,
      { ...deps.alerts, store },
      {
        config,
        ipOf,
        now,
        limiter: { take: (bucket, client, limit) => takeHourly(deps.store(), bucket, client, limit, now()) },
      },
    );
  }

  return app;
}

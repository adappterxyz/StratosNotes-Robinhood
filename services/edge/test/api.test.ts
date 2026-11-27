/**
 * The Worker API over a local D1, ported from services/api/test/api.test.ts: the same routes and answers, plus
 * the polling live updates that replace SSE, and the cron (indexing + outbox) end to end on the fake chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex as hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  compile,
  compileTemplate,
  dec,
  definitionId,
  EXAMPLE_PRODUCTS,
  evmCoreLength,
  instantiateProduct,
  parseBpmn,
  templateMessage,
} from '@sn/core';
import { bytesToHex } from '@sn/sdk';
import { FakeChain, type FakeEvent } from '../../indexer/test/fake-chain';
import { createEdgeApp } from '../src/api';
import { ApiConfig, parseEdgeConfig } from '../src/config';
import { Store } from '../src/d1';
import { D1Ingestor } from '../src/ingest';
import type { EmailSender } from '@sn/notifier';
import { alertsStore } from '../src/notify';
import { runCron } from '../src/scheduled';
import { localD1 } from './d1';

const ENGINE = '0x00000000000000000000000000000000000000e1' as const;
const ISSUER = '0x00000000000000000000000000000000000000b1';
const ALICE = '0x00000000000000000000000000000000000000a1';
const ZERO = '0x0000000000000000000000000000000000000000';
const ORIGIN = 'https://app.example';

const prod = instantiateProduct(EXAMPLE_PRODUCTS.phoenix);
const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
const coreLen = evmCoreLength(c.bytes);
const defId = bytesToHex(c.hash);
const field = (n: string) => c.def.fields.findIndex((f) => f.name === n);
const word = (v: bigint) => `0x${BigInt.asUintN(256, v).toString(16).padStart(64, '0')}`;
const NOW = 1_700_000_100;
const ascii = (s: string) =>
  `0x${Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')}`;

function note(pid: bigint, strikeAt: number, status = 0): FakeEvent[] {
  return [
    {
      eventName: 'ProcessStarted',
      args: {
        pid,
        definition: defId,
        creator: ISSUER,
        ref: pid,
        roles: [ISSUER, ISSUER, ZERO],
        assetTokens: [ZERO, '0x00000000000000000000000000000000000000c1'],
      },
    },
    { eventName: 'FieldSet', args: { pid, field: field('notional'), tag: 1, value: word(dec(1000)) } },
    { eventName: 'FieldSet', args: { pid, field: field('strikeDate'), tag: 1, value: word(BigInt(strikeAt)) } },
    { eventName: 'FieldSet', args: { pid, field: field('isin'), tag: 2, value: ascii(`XSTEST${pid}`) } },
    { eventName: 'HoldingChanged', args: { pid, asset: 0, owner: ISSUER, balance: dec(400) } },
    { eventName: 'HoldingChanged', args: { pid, asset: 0, owner: ALICE, balance: dec(600) } },
    {
      eventName: 'TokensUpdated',
      args: { pid, status, stepsRun: 3, tokens: status ? [] : [c.stepIndex.Task_Subscribe] },
    },
  ];
}

let d1: Awaited<ReturnType<typeof localD1>>;
let chain: FakeChain;
let ing: D1Ingestor;
const config = ApiConfig.parse({
  allowedOrigins: [ORIGIN],
  chains: [
    {
      key: 'local',
      rpc: 'http://127.0.0.1:1',
      engine: ENGINE,
      lens: ENGINE,
      stablecoin: { symbol: 'USDC', address: '0x00000000000000000000000000000000000000c1', decimals: 6 },
    },
  ],
  limits: { templatesPerHour: 5 },
});
let app: ReturnType<typeof createEdgeApp>;
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const post = (path: string, body: unknown, origin = ORIGIN) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  d1 = await localD1();
  chain = new FakeChain(NOW - 1000);
  chain.cores.set(defId, hex(c.bytes.subarray(0, coreLen)));
  ing = new D1Ingestor(
    new Store(d1.db),
    { key: 'local', family: 'evm', chainId: 998, rpc: '', engine: ENGINE, startBlock: 1 },
    chain,
  );
  await ing.init();
  chain.mine([
    {
      eventName: 'DefinitionRegistered',
      args: { id: defId, creator: ISSUER, pointer: ZERO, meta: hex(c.bytes.subarray(coreLen)) },
    },
  ]);
  chain.mine(note(1n, NOW + 3600)); // book open
  chain.mine(note(2n, NOW - 3600)); // book closed: live
  chain.mine(note(3n, NOW - 7200, 1)); // redeemed
  await ing.catchUp();
  app = createEdgeApp({ store: () => new Store(d1.db), config, ai: false, now: () => NOW * 1000 });
}, 60_000);
afterAll(async () => {
  await d1.dispose();
});

const id = (pid: number) => `local:${ENGINE}:${pid}`;

describe('notes', () => {
  it('lists notes newest first with filters by status, underlying, product and text', async () => {
    const all = await (await get('/api/notes')).json();
    expect(all.notes.map((n: { id: string }) => n.id)).toEqual([id(3), id(2), id(1)]);
    const book = await (await get('/api/notes?status=book')).json();
    expect(book.notes.map((n: { id: string }) => n.id)).toEqual([id(1)]);
    expect(book.notes[0].view.phase).toBe('book');
    expect((await (await get('/api/notes?status=live')).json()).notes.map((n: { id: string }) => n.id)).toEqual([
      id(2),
    ]);
    expect((await (await get('/api/notes?status=redeemed')).json()).notes.map((n: { id: string }) => n.id)).toEqual([
      id(3),
    ]);
    expect((await (await get('/api/notes?underlying=eth&product=phoenix&status=active')).json()).notes).toHaveLength(2);
    expect((await (await get('/api/notes?underlying=BTC')).json()).notes).toHaveLength(0);
    expect((await (await get('/api/notes?q=XSTEST2')).json()).notes.map((n: { id: string }) => n.id)).toEqual([id(2)]);
    expect((await (await get('/api/notes?q=%25')).json()).notes).toHaveLength(0); // a literal %, not a wildcard
  });

  it('pages with a cursor', async () => {
    const p1 = await (await get('/api/notes?limit=2')).json();
    expect(p1.notes).toHaveLength(2);
    const p2 = await (await get(`/api/notes?limit=2&cursor=${p1.next}`)).json();
    expect(p2.notes.map((n: { id: string }) => n.id)).toEqual([id(1)]);
    expect(p2.next).toBeNull();
  });

  it('validates queries', async () => {
    expect((await get('/api/notes?status=nope')).status).toBe(400);
    expect((await get('/api/notes?limit=1000')).status).toBe(400);
    expect((await get('/api/notes?cursor=junk')).status).toBe(400);
    expect((await get("/api/notes/local:0x00'--:1")).status).toBe(400);
    expect((await get(`/api/notes/${id(99)}`)).status).toBe(404);
  });

  it('serves one note, its history, its definition and a portfolio', async () => {
    const n = await (await get(`/api/notes/${id(1)}`)).json();
    expect(n.view.sold).toBe(600);
    expect(n.view.isin).toBe('XSTEST1');
    const h = await (await get(`/api/notes/${id(1)}/history`)).json();
    expect(h.events[0].name).toBe('TokensUpdated');
    const d = await (await get(`/api/definitions/local/${defId}`)).json();
    expect(d.bytes).toBe(hex(c.bytes));
    const p = await (await get(`/api/portfolio/${ALICE}`)).json();
    expect(p.positions).toHaveLength(3);
    expect(p.positions[0].position.units).toBe(600);
    expect((await get('/api/portfolio/0x123')).status).toBe(400);
  });

  it('answers CORS only for allowed origins, and reports the indexer cursor', async () => {
    const ok = await get('/api/notes', { Origin: ORIGIN });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const no = await get('/api/notes', { Origin: 'https://evil.example' });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
    const h = await (await get('/api/health')).json();
    expect(h.chains[0]).toMatchObject({ chain: 'local', cursor: 4 });
  });
});

describe('templates', () => {
  const author = privateKeyToAccount(generatePrivateKey());
  const product = EXAMPLE_PRODUCTS.snowball;
  const definition = definitionId(compileTemplate({ product }));
  const entry = { definition, name: 'Snowball', description: 'A snowball on ETH', author: author.address, product };

  it('accepts a signed template that compiles to the definition it names, once', async () => {
    const signature = await author.signMessage({ message: templateMessage(definition) });
    const r = await post('/api/templates', { entry, signature });
    expect(r.status).toBe(201);
    expect((await r.json()).kind).toBe('product');
    expect((await post('/api/templates', { entry, signature })).status).toBe(409);
    const list = await (await get('/api/templates')).json();
    expect(list.map((t: { definition: string }) => t.definition)).toContain(definition);
    expect((await (await get(`/api/templates/${definition}`)).json()).product.productType).toBe('snowball');
  });

  it('refuses a note on another chain: notes run on Robinhood Chain and Base only', async () => {
    // A term sheet naming another chain no longer compiles at all; the API refuses it before trying.
    const rh = { ...product, chain: 'ethereum-sepolia' as never };
    const def = definition;
    const signature = await author.signMessage({ message: templateMessage(def) });
    const r = await post('/api/templates', {
      entry: { ...entry, name: 'Snowball elsewhere', product: rh },
      signature,
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/notes run on Robinhood Chain testnet or Base Sepolia/);
    const listed = (await (await get('/api/templates')).json()) as Array<{ definition: string; name: string }>;
    expect(listed.filter((t) => t.definition === def).map((t) => t.name)).toEqual(['Snowball']);
  });

  it('refuses a wrong signature, a mismatched workflow, a foreign origin, and too many saves (D1 counter)', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const bad = await other.signMessage({ message: templateMessage(definition) });
    expect((await post('/api/templates', { entry: { ...entry, name: 'x' }, signature: bad })).status).toBe(401);
    const wrong = `0x${'11'.repeat(32)}`;
    const sig = await author.signMessage({ message: templateMessage(wrong) });
    expect((await post('/api/templates', { entry: { ...entry, definition: wrong }, signature: sig })).status).toBe(400);
    expect((await post('/api/templates', { entry, signature: sig }, 'https://evil.example')).status).toBe(403);
    expect((await post('/api/templates', { entry, signature: sig })).status).toBe(429); // 5 per hour in this config
  });
});

describe('live updates (polling)', () => {
  it('reports the notes the indexer changed after a sequence number', async () => {
    const start = await (await get('/api/updates')).json();
    expect(start.changes).toEqual([]);
    chain.mine([{ eventName: 'HoldingChanged', args: { pid: 1n, asset: 0, owner: ALICE, balance: dec(700) } }]);
    await ing.catchUp();
    const u = await (await get(`/api/updates?since=${start.seq}&notes=${id(1)}`)).json();
    expect(u.seq).toBeGreaterThan(start.seq);
    expect(u.changes).toEqual([{ chain: 'local', notes: [id(1)] }]);
    const other = await (await get(`/api/updates?since=${start.seq}&notes=${id(2)}`)).json();
    expect(other.changes).toEqual([]);
    expect((await get('/api/updates?since=x')).status).toBe(400);
    expect((await get('/api/stream')).status).toBe(404);
  });
});

describe('cron', () => {
  it('indexes within a budget, then sends the due outbox rows to verified emails once', async () => {
    const store = new Store(d1.db);
    const alerts = alertsStore(store);
    // A verified email for Alice (payouts on), and three queued messages: Alice's payout (sent), the same key
    // again (ignored) and one for an address without an email (skipped).
    await alerts.startVerification({
      address: ALICE,
      email: 'alice@example.com',
      categories: ['payouts'],
      codeHash: 'h',
      codeExpires: NOW + 600,
      linkTokenHash: 'l',
      unsubscribeToken: 'tok-a',
      now: NOW,
    });
    await alerts.completeVerification(ALICE, '0x01', '0x02', NOW);
    const item = (dedupe: string, address: string, category: string) => ({
      dedupe,
      address,
      noteId: id(1),
      category,
      payload: { subject: 'Paid', body: 'You were paid.', vars: {} },
      sendAfter: NOW,
      expiresAt: null,
    });
    expect(await alerts.enqueue([item('n1:pay:1:alice', ALICE, 'payouts')], NOW)).toBe(1);
    expect(await alerts.enqueue([item('n1:pay:1:alice', ALICE, 'payouts')], NOW)).toBe(0);
    await alerts.enqueue([item('n1:pay:1:issuer', ISSUER, 'due')], NOW);
    const sent: string[] = [];
    const sender: EmailSender = {
      send: async (m) => {
        sent.push(`${m.to}:${m.subject}`);
        return { messageId: `m${sent.length}` };
      },
    };
    chain.mine([{ eventName: 'HoldingChanged', args: { pid: 2n, asset: 0, owner: ALICE, balance: dec(650) } }]);
    const cfg = parseEdgeConfig({
      api: config,
      indexer: {
        chains: [
          { key: 'local', family: 'evm', chainId: 998, rpc: 'http://127.0.0.1:1', engine: ENGINE, startBlock: 1 },
        ],
      },
    });
    const r = await runCron({
      store: new Store(d1.db),
      config: cfg,
      source: () => chain,
      sender,
      now: () => NOW * 1000,
    });
    expect(r.chains[0].error).toBeUndefined();
    expect(r.chains[0].steps.some((s) => s.notes.includes(id(2)))).toBe(true);
    expect(r.queries).toBeLessThan(800);
    expect(sent).toEqual(['alice@example.com:Paid']);
    const rows = await store.all<{ dedupe: string; status: string }>(
      'SELECT dedupe, status FROM email_outbox ORDER BY dedupe',
    );
    expect(rows).toEqual([
      { dedupe: 'n1:pay:1:alice', status: 'sent' },
      { dedupe: 'n1:pay:1:issuer', status: 'skipped' },
    ]);
    // A second run sends nothing again.
    await runCron({ store: new Store(d1.db), config: cfg, source: () => chain, sender, now: () => NOW * 1000 });
    expect(sent).toHaveLength(1);
  });

  it('without a sender (Email Sending off) leaves the outbox pending', async () => {
    const store = new Store(d1.db);
    await alertsStore(store).enqueue(
      [
        {
          dedupe: 'held',
          address: ALICE,
          noteId: null,
          category: 'payouts',
          payload: { subject: 'S', body: 'B', vars: {} },
          sendAfter: NOW,
          expiresAt: null,
        },
      ],
      NOW,
    );
    const cfg = parseEdgeConfig({ api: config, indexer: { chains: [] } });
    await runCron({ store, config: cfg, sender: null, now: () => NOW * 1000 });
    expect(
      (await store.first<{ status: string }>("SELECT status FROM email_outbox WHERE dedupe = 'held'"))!.status,
    ).toBe('pending');
  });
});

describe('price history for the back-test (CoinMarketCap)', () => {
  const quote = (ts: string, price: number) => ({ timestamp: ts, quote: { USD: { price } } });
  const mk = (calls: string[], key: string | undefined = 'test-key') =>
    createEdgeApp({
      store: () => new Store(d1.db),
      config,
      ai: false,
      now: () => NOW * 1000,
      market: {
        cmcApiKey: key,
        fetch: (async (url: string, init?: { headers?: Record<string, string> }) => {
          calls.push(`${url} ${init?.headers?.['X-CMC_PRO_API_KEY']}`);
          return new Response(
            JSON.stringify({
              status: { error_code: 0 },
              data: {
                40214: { quotes: [quote('2026-06-12T00:00:00.000Z', 398.9), quote('2026-06-13T00:00:00.000Z', 401)] },
                40215: { quotes: [quote('2026-06-12T00:00:00.000Z', 205.2)] },
              },
            }),
          );
        }) as unknown as typeof fetch,
      },
    });

  it("serves the stock tokens' daily prices, asking CoinMarketCap once", async () => {
    const calls: string[] = [];
    const a = mk(calls);
    const res = await a.request('/api/market/history?symbols=TSLAB,NVDAB');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await res.json()).toEqual({
      source: 'CoinMarketCap',
      interval: '1d',
      series: {
        TSLAB: [
          [1781222400, 398.9],
          [1781308800, 401],
        ],
        NVDAB: [[1781222400, 205.2]],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/v3/cryptocurrency/quotes/historical?id=40214,40215&');
    expect(calls[0]).toContain('interval=1d');
    expect(calls[0].endsWith(' test-key')).toBe(true);
    // Kept: a second visitor costs no CoinMarketCap credit.
    expect((await a.request('/api/market/history?symbols=TSLAB')).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('refuses symbols notes cannot be written on, and says when no key is configured', async () => {
    const calls: string[] = [];
    expect((await mk(calls).request('/api/market/history?symbols=DOGE')).status).toBe(400);
    expect((await mk(calls).request('/api/market/history')).status).toBe(400);
    expect((await mk(calls, '').request('/api/market/history?symbols=TSLAB')).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe('live prices (Atlas signed)', () => {
  // A live reply of 2026-11-25, signed by Atlas's reporter key.
  const payload = '0x000003a50013cfee8b7c08206fde00006b071410000003a60007b5d22393eb64b12600006b07140f02';
  const signature =
    '0xd044803627f1fe037aa96d5181bcc94ad73af682d5d263b845a3c8b29e2ddbd434345f719bba89096c6f27261fd7dde2e7bab0ab6dde1f72aecc36642b120ae61b';
  const mk = (reply: object, calls: string[] = []) =>
    createEdgeApp({
      store: () => new Store(d1.db),
      config,
      ai: false,
      now: () => NOW * 1000,
      market: {
        atlasApiKey: 'atlas-key',
        fetch: (async (url: string, init?: { body?: string }) => {
          calls.push(`${url} ${init?.body}`);
          return new Response(JSON.stringify({ data: reply }));
        }) as unknown as typeof fetch,
      },
    });

  it('serves a price only after recovering Atlas as its signer', async () => {
    const calls: string[] = [];
    const a = mk(
      { payload, signature, consensusScores: [{ feedId: '933', consensusScore: 0.9261, consensusStatus: 'HEALTHY' }] },
      calls,
    );
    const res = await a.request('/api/market/atlas?symbols=TSLAB,NVDAB');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      source: 'Atlas',
      signer: '0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600',
      verified: true,
      prices: {
        TSLAB: { price: 365.471203, at: 1795626000, status: 'HEALTHY', score: 0.926 },
        NVDAB: { price: 142.228781, at: 1795625999 },
      },
    });
    expect(calls[0]).toContain('https://api.atlasoracle.io/report/v1/price/latest');
    expect(calls[0]).toContain('"signed":true');
  });

  it('refuses a price somebody else signed, or a payload changed after signing', async () => {
    // One digit of the TSLAB price changed: the signature now recovers to another address.
    const forged = payload.replace('13cfee8b', '13cfee8c');
    expect((await mk({ payload: forged, signature }).request('/api/market/atlas?symbols=TSLAB')).status).toBe(502);
    expect((await mk({ payload }).request('/api/market/atlas?symbols=TSLAB')).status).toBe(502);
    expect((await mk({ payload, signature }).request('/api/market/atlas?symbols=BTC')).status).toBe(400);
  });
});

describe('stock-token DEX markets (CoinMarketCap DEX API)', () => {
  it("serves a token's BNB Chain liquidity, asking CoinMarketCap for its mainnet address once", async () => {
    const calls: string[] = [];
    const a = createEdgeApp({
      store: () => new Store(d1.db),
      config,
      ai: false,
      now: () => NOW * 1000,
      market: {
        cmcApiKey: 'test-key',
        fetch: (async (url: string) => {
          calls.push(url);
          return new Response(
            JSON.stringify({
              status: { error_code: '0' },
              data: {
                liqUsd: '1793494.6',
                ph24h: '386.13',
                pl24h: '357.94',
                pt: '1795626336000',
                sts: [{ tp: '24h', vu: '2221107.8' }],
              },
            }),
          );
        }) as unknown as typeof fetch,
      },
    });
    const res = await a.request('/api/market/liquidity?symbols=TSLAB');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      source: 'CoinMarketCap DEX API (BNB Chain)',
      markets: {
        TSLAB: { liquidityUsd: 1793494.6, volume24hUsd: 2221107.8, low24h: 357.94, high24h: 386.13, at: 1795626336 },
      },
    });
    expect(calls).toEqual([
      'https://pro-api.coinmarketcap.com/v1/dex/token?platform=bsc&address=0x5b1910eaad6450e50f816082aa078c41f10c292f',
    ]);
    await a.request('/api/market/liquidity?symbols=TSLAB');
    expect(calls).toHaveLength(1);
    expect((await a.request('/api/market/liquidity?symbols=ETH')).status).toBe(400);
  });
});

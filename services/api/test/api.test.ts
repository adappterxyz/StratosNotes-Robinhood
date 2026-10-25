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
  type AiRunner,
} from '@sn/core';
import { bytesToHex } from '@sn/sdk';
import { Ingestor, migrate, pgliteDb, type Db } from '@sn/indexer';
import { FakeChain, type FakeEvent } from '../../indexer/test/fake-chain';
import { createApp } from '../src/app';
import { ApiConfig } from '../src/config';

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
    {
      eventName: 'FieldSet',
      args: {
        pid,
        field: field('isin'),
        tag: 2,
        value: `0x${Buffer.from(`XSTEST${pid}`).toString('hex').padEnd(64, '0')}`,
      },
    },
    { eventName: 'HoldingChanged', args: { pid, asset: 0, owner: ISSUER, balance: dec(400) } },
    { eventName: 'HoldingChanged', args: { pid, asset: 0, owner: ALICE, balance: dec(600) } },
    {
      eventName: 'TokensUpdated',
      args: { pid, status, stepsRun: 3, tokens: status ? [] : [c.stepIndex.Task_Subscribe] },
    },
  ];
}

let db: Db;
let chain: FakeChain;
let ing: Ingestor;
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
let app: ReturnType<typeof createApp>;
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const post = (path: string, body: unknown, origin = ORIGIN) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  db = await pgliteDb();
  await migrate(db);
  chain = new FakeChain(NOW - 1000);
  chain.cores.set(defId, hex(c.bytes.subarray(0, coreLen)));
  ing = new Ingestor(db, { key: 'local', family: 'evm', chainId: 998, rpc: '', engine: ENGINE, startBlock: 1 }, chain);
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
  app = createApp({ db, config, ai: null, now: () => NOW * 1000 });
}, 60_000);
afterAll(async () => {
  await db.close();
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

  it('answers CORS only for allowed origins', async () => {
    const ok = await get('/api/notes', { Origin: ORIGIN });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const no = await get('/api/notes', { Origin: 'https://evil.example' });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
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

  it('refuses a note on Robinhood Chain: notes are issued on Arbitrum only', async () => {
    const rh = { ...product, chain: 'robinhood-testnet' as const };
    const def = definitionId(compileTemplate({ product: rh }));
    const signature = await author.signMessage({ message: templateMessage(def) });
    const r = await post('/api/templates', { entry: { ...entry, definition: def, product: rh }, signature });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/issued on Arbitrum Sepolia only/);
    expect((await (await get('/api/templates')).json()).map((t: { definition: string }) => t.definition)).not.toContain(
      def,
    );
  });

  it('refuses a wrong signature, a mismatched workflow, a foreign origin, and too many saves', async () => {
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

describe('ai', () => {
  it('is off without a runner, and validates input with one', async () => {
    expect((await post('/api/ai', { prompt: 'hi' })).status).toBe(503);
    const fake: AiRunner = { decide: async () => ({}), json: async () => ({}) as never, text: async () => 'ok' };
    const withAi = createApp({ db, config, ai: fake });
    const r = await withAi.request('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(r.status).toBe(400);
  });
});

describe('live updates', () => {
  it('streams the notes the indexer changed', async () => {
    const res = await get(`/api/stream?notes=${id(1)}`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const read = async (want: string) => {
      let text = '';
      const deadline = Date.now() + 10_000;
      while (!text.includes(want) && Date.now() < deadline) {
        const { value } = await reader.read();
        text += new TextDecoder().decode(value);
      }
      return text;
    };
    expect(await read('event: ready')).toContain('ready');
    chain.mine([{ eventName: 'HoldingChanged', args: { pid: 1n, asset: 0, owner: ALICE, balance: dec(700) } }]);
    await ing.catchUp();
    expect(await read(id(1))).toContain(`"notes":["${id(1)}"]`);
    await reader.cancel();
  }, 30_000);
});

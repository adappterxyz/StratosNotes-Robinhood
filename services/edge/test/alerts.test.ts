import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex as hex, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compile, dec, EXAMPLE_PRODUCTS, evmCoreLength, instantiateProduct, parseBpmn } from '@sn/core';
import { bytesToHex } from '@sn/sdk';
import { alertsMessage, emailHashOf, mockSender, type MockSender } from '@sn/notifier';
import { FakeChain, type FakeEvent } from '../../indexer/test/fake-chain';
import { createEdgeApp } from '../src/api';
import { ApiConfig } from '../src/config';
import { Store } from '../src/d1';
import { D1Ingestor } from '../src/ingest';
import { alertsStore, notifierTick } from '../src/notify';
import { localD1 } from './d1';

const ENGINE = '0x00000000000000000000000000000000000000e1' as const;
const ZERO = '0x0000000000000000000000000000000000000000';
const ORIGIN = 'https://notes.markets';
const NOW = 1_700_000_100;
const issuerAcct = privateKeyToAccount(generatePrivateKey());
const aliceAcct = privateKeyToAccount(generatePrivateKey());
const bobAcct = privateKeyToAccount(generatePrivateKey());
const ISSUER = issuerAcct.address.toLowerCase(),
  ALICE = aliceAcct.address.toLowerCase(),
  BOB = bobAcct.address.toLowerCase();

const prod = instantiateProduct(EXAMPLE_PRODUCTS.phoenix);
const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
const coreLen = evmCoreLength(c.bytes);
const defId = bytesToHex(c.hash);
const field = (n: string) => c.def.fields.findIndex((f) => f.name === n);
const word = (v: bigint) => `0x${BigInt.asUintN(256, v).toString(16).padStart(64, '0')}` as Hex;
const CASH = c.def.assets.findIndex((a) => a.name === 'USDG');

// The same scenarios as services/api/test/alerts.test.ts, on the Worker's API over a local D1.
let d1: Awaited<ReturnType<typeof localD1>>;
let chain: FakeChain;
let ing: D1Ingestor;
let mail: MockSender;
let verifierKey: Hex;
let app: ReturnType<typeof createEdgeApp>;
const store = () => new Store(d1.db);
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
});
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body),
  });
const get = async (path: string) => (await app.request(path)).json();
const lastCode = (to: string) => /code is (\d{6})/.exec(mail.sent.filter((e) => e.to === to).at(-1)!.text)![1];

async function startFor(acct: typeof aliceAcct, email: string, categories = ['payouts', 'risk', 'due', 'book']) {
  const issuedAt = NOW;
  const signature = await acct.signMessage({
    message: alertsMessage({ action: 'verify', address: acct.address, email, categories, issuedAt }),
  });
  return post('/api/alerts/start', { address: acct.address, email, categories, issuedAt, signature });
}

beforeAll(async () => {
  d1 = await localD1();
  mail = mockSender();
  verifierKey = generatePrivateKey();
  app = createEdgeApp({
    store,
    config,
    ai: false,
    now: () => NOW * 1000,
    alerts: {
      sender: mail,
      verifierKey,
      siteUrl: ORIGIN,
      devMailbox: mail,
      nonceOf: async () => ({ chainId: 46630, nonce: 3n }),
    },
  });
  chain = new FakeChain(NOW - 1000);
  chain.cores.set(defId, hex(c.bytes.subarray(0, coreLen)));
  ing = new D1Ingestor(
    store(),
    { key: 'local', family: 'evm', chainId: 998, rpc: '', engine: ENGINE, startBlock: 1 },
    chain,
  );
  await ing.init();
}, 60_000);
afterAll(async () => {
  await d1.dispose();
});

describe('verified emails', () => {
  it('refuses a signature from another wallet, and bad addresses', async () => {
    const issuedAt = NOW;
    const signature = await bobAcct.signMessage({
      message: alertsMessage({
        action: 'verify',
        address: aliceAcct.address,
        email: 'a@x.co',
        categories: [],
        issuedAt,
      }),
    });
    expect(
      (
        await post('/api/alerts/start', {
          address: aliceAcct.address,
          email: 'a@x.co',
          categories: [],
          issuedAt,
          signature,
        })
      ).status,
    ).toBe(401);
    expect((await startFor(aliceAcct, 'not-an-email')).status).toBe(400);
  });

  it('sends a 6-digit code; a wrong code is refused; the right one verifies and fixes a salted hash', async () => {
    const r = await startFor(aliceAcct, ' Alice@Example.com ');
    expect(r.status).toBe(200);
    expect((await r.json()).to).toBe('a•••@example.com');
    expect((await get(`/api/alerts/status?address=${ALICE}`)).verified).toBe(false);
    const code = lastCode('alice@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await post('/api/alerts/verify', { address: ALICE, code: wrong })).status).toBe(401);
    const ok = await post('/api/alerts/verify', { address: ALICE, code });
    expect(ok.status).toBe(200);
    const st = await get(`/api/alerts/status?address=${ALICE}`);
    expect(st).toMatchObject({ verified: true, email: 'a•••@example.com', pending: null });
    // The code is spent.
    expect((await post('/api/alerts/verify', { address: ALICE, code })).status).toBe(404);
    // The salt (only to the wallet's owner) reproduces the hash.
    const issuedAt = NOW;
    const sig = await aliceAcct.signMessage({
      message: alertsMessage({ action: 'salt', address: aliceAcct.address, issuedAt }),
    });
    const salt = await (await post('/api/alerts/salt', { address: ALICE, issuedAt, signature: sig })).json();
    expect(salt.email).toBe('alice@example.com');
    expect(emailHashOf(salt.salt, 'alice@example.com')).toBe(st.emailHash);
    expect(
      (
        await post('/api/alerts/salt', {
          address: ALICE,
          issuedAt,
          signature: await bobAcct.signMessage({ message: 'x' }),
        })
      ).status,
    ).toBe(401);
  });

  it("signs the on-chain attestation with the verifier key (EIP-712), for the engine's current nonce", async () => {
    const a = await (await post('/api/alerts/attestation', { address: ALICE, chain: 'local' })).json();
    expect(a).toMatchObject({ chainId: 46630, engine: ENGINE, holder: ALICE, nonce: '3' });
    const signer = await recoverTypedDataAddress({
      domain: { name: 'notes.markets', version: '1', chainId: 46630, verifyingContract: ENGINE },
      types: {
        EmailAttestation: [
          { name: 'holder', type: 'address' },
          { name: 'emailHash', type: 'bytes32' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      primaryType: 'EmailAttestation',
      message: { holder: ALICE as Hex, emailHash: a.emailHash, expiry: BigInt(a.expiry), nonce: 3n },
      signature: a.signature,
    });
    expect(signer).toBe(privateKeyToAccount(verifierKey).address);
    expect((await post('/api/alerts/attestation', { address: BOB, chain: 'local' })).status).toBe(403); // not verified
  });

  it('the link in the email verifies too; changing the email verifies the new one before it counts', async () => {
    await startFor(bobAcct, 'bob@example.com', ['risk']);
    const link = /token=([0-9a-f]{64})/.exec(mail.sent.at(-1)!.text)![1];
    expect(await (await app.request(`/api/alerts/confirm?token=${link}`)).json()).toMatchObject({
      verified: true,
      email: 'b•••@example.com',
    });
    await startFor(bobAcct, 'bob2@example.com', ['risk']);
    expect(await get(`/api/alerts/status?address=${BOB}`)).toMatchObject({
      verified: true,
      email: 'b•••@example.com',
      pending: 'b•••@example.com',
    });
    await post('/api/alerts/verify', { address: BOB, code: lastCode('bob2@example.com') });
    const st = await get(`/api/alerts/status?address=${BOB}`);
    expect(st.pending).toBeNull();
    expect((await alertsStore(store()).binding(BOB))!.email).toBe('bob2@example.com');
  });

  it("preferences need the wallet's signature; unsubscribe is one click", async () => {
    const issuedAt = NOW;
    const categories = ['payouts'];
    const signature = await aliceAcct.signMessage({
      message: alertsMessage({ action: 'preferences', address: aliceAcct.address, categories, issuedAt }),
    });
    expect((await post('/api/alerts/preferences', { address: ALICE, categories, issuedAt, signature })).status).toBe(
      200,
    );
    expect((await get(`/api/alerts/status?address=${ALICE}`)).categories).toEqual(['payouts']);
    const token = (await alertsStore(store()).binding(BOB))!.unsubscribeToken;
    expect((await post('/api/alerts/unsubscribe', { token })).status).toBe(200);
    expect((await get(`/api/alerts/status?address=${BOB}`)).unsubscribed).toBe(true);
    expect((await post('/api/alerts/unsubscribe', { token: 'f'.repeat(48) })).status).toBe(404);
  });
});

describe('notifier tick, end to end over the read model', () => {
  it('the issuer\'s "note is live", a subscriber\'s receipt and a payout reach verified emails, once', async () => {
    // Issuer verified with every category; Alice (payouts only) is verified above.
    await startFor(issuerAcct, 'issuer@example.com');
    await post('/api/alerts/verify', { address: ISSUER, code: lastCode('issuer@example.com') });
    const pid = 1n;
    const ev = (e: FakeEvent) => e;
    chain.mine([
      {
        eventName: 'DefinitionRegistered',
        args: { id: defId, creator: ISSUER, pointer: ZERO, meta: hex(c.bytes.subarray(coreLen)) },
      },
    ]);
    chain.mine([
      ev({
        eventName: 'ProcessStarted',
        args: {
          pid,
          definition: defId,
          creator: ISSUER,
          ref: pid,
          roles: [ISSUER, ISSUER, ZERO, '0x000000000000000000000000000000000000e5c0'],
          assetTokens: c.def.assets.map((a, i) =>
            a.kind === 1 ? `0x00000000000000000000000000000000000000c${i}` : ZERO,
          ),
        },
      }),
      ev({ eventName: 'FieldSet', args: { pid, field: field('notional'), tag: 1, value: word(dec(1000)) } }),
      ev({ eventName: 'FieldSet', args: { pid, field: field('strikeDate'), tag: 1, value: word(BigInt(NOW + 3600)) } }),
      ev({ eventName: 'HoldingChanged', args: { pid, asset: 0, owner: ISSUER, balance: dec(1000) } }),
      ev({ eventName: 'TokensUpdated', args: { pid, status: 0, stepsRun: 3, tokens: [c.stepIndex.Task_Subscribe] } }),
    ]);
    chain.mine([
      ev({ eventName: 'StepRun', args: { pid, step: c.stepIndex.Task_Subscribe, kind: 2, actor: ALICE } }),
      ev({ eventName: 'HoldingChanged', args: { pid, asset: 0, owner: ISSUER, balance: dec(400) } }),
      ev({ eventName: 'HoldingChanged', args: { pid, asset: 0, owner: ALICE, balance: dec(600) } }),
    ]);
    chain.mine([
      ev({ eventName: 'StepRun', args: { pid, step: c.stepIndex.Task_Pay1, kind: 3, actor: ZERO } }),
      ev({ eventName: 'HoldingChanged', args: { pid, asset: CASH, owner: ALICE, balance: dec(15) } }),
    ]);
    await ing.catchUp();
    const before = mail.sent.length;
    const tick = (now: number) => notifierTick(store(), { sender: mail, siteUrl: ORIGIN, now, chainLabel: (k) => k });
    const r1 = await tick(NOW);
    const sent = mail.sent.slice(before);
    expect(sent.map((e) => [e.to, e.subject])).toEqual(
      expect.arrayContaining([
        ['issuer@example.com', expect.stringMatching(/^Your note is live/)],
        ['alice@example.com', expect.stringMatching(/^You subscribed to 600 units/)],
        ['alice@example.com', 'You were paid $15.00 on 12M Phoenix (memory) on ETH'],
      ]),
    );
    expect(r1.sent).toBe(sent.length);
    // Again: nothing new.
    const r2 = await tick(NOW + 30);
    expect(r2.queued).toBe(0);
    expect(mail.sent.length).toBe(before + sent.length);
  });
});

describe('emails sent (Alerts → Emails sent)', () => {
  const emailsFor = async (
    acct: typeof aliceAcct,
    body: Record<string, unknown> = {},
    address: string = acct.address,
  ) => {
    const issuedAt = NOW;
    const signature = await acct.signMessage({ message: alertsMessage({ action: 'emails', address, issuedAt }) });
    return post('/api/alerts/emails', { address, issuedAt, signature, ...body });
  };

  it('returns a copy of every alert sent to the wallet, as it was sent, newest first', async () => {
    const r = await emailsFor(aliceAcct);
    expect(r.status).toBe(200);
    const j = await r.json();
    const mine = mail.sent.filter((e) => e.to === 'alice@example.com' && !/notes\.markets code/.test(e.subject));
    expect(j.emails.map((e: { subject: string }) => e.subject).sort()).toEqual(mine.map((e) => e.subject).sort());
    const paid = j.emails.find((e: { subject: string }) => e.subject.startsWith('You were paid'));
    expect(paid).toMatchObject({
      status: 'sent',
      to: 'a•••@example.com',
      note: '12M Phoenix (memory) on ETH',
      category: 'payouts',
      at: NOW,
    });
    expect(paid.noteId).toMatch(/^local:/);
    expect(paid.html).toBe(mine.find((e) => e.subject === paid.subject)!.html);
    expect(paid.text).toContain('Stop these emails');
    // Never the salt or anyone else's mail; no code emails.
    expect(JSON.stringify(j)).not.toMatch(/salt|issuer@example\.com|code is/);
    expect(j.emails.every((e: { to: string }) => e.to === 'a•••@example.com')).toBe(true);
  });

  it('only the wallet itself can read its mail: another signer, a signature for another action or a stale one is refused', async () => {
    // Bob signs for Alice's address.
    expect((await emailsFor(bobAcct, {}, aliceAcct.address)).status).toBe(401);
    // A signature for a different action.
    const issuedAt = NOW;
    const salt = await aliceAcct.signMessage({
      message: alertsMessage({ action: 'salt', address: aliceAcct.address, issuedAt }),
    });
    expect((await post('/api/alerts/emails', { address: ALICE, issuedAt, signature: salt })).status).toBe(401);
    // Too old.
    const old = NOW - 3600;
    const stale = await aliceAcct.signMessage({
      message: alertsMessage({ action: 'emails', address: aliceAcct.address, issuedAt: old }),
    });
    expect((await post('/api/alerts/emails', { address: ALICE, issuedAt: old, signature: stale })).status).toBe(401);
    // No address at all, or a wallet with no verified email.
    expect((await post('/api/alerts/emails', {})).status).toBe(400);
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect((await emailsFor(stranger)).status).toBe(404);
    // The issuer sees only the issuer's mail.
    const iss = await (await emailsFor(issuerAcct)).json();
    expect(iss.emails.length).toBeGreaterThan(0);
    expect(iss.emails.every((e: { to: string }) => e.to === 'i•••@example.com')).toBe(true);
  });

  it('pages with a cursor, and shows what is still queued on the first page', async () => {
    const all = (await (await emailsFor(aliceAcct)).json()).emails as Array<{ id: string }>;
    expect(all.length).toBeGreaterThanOrEqual(2);
    const p1 = await (await emailsFor(aliceAcct, { limit: 1 })).json();
    expect(p1.emails.map((e: { id: string }) => e.id)).toEqual([all[0].id]);
    expect(p1.next).toEqual({ at: NOW, id: all[0].id });
    const p2 = await (await emailsFor(aliceAcct, { limit: 1, before: p1.next })).json();
    expect(p2.emails.map((e: { id: string }) => e.id)).toEqual([all[1].id]);
    expect(p2.queued).toEqual([]);

    await alertsStore(store()).enqueue(
      [
        {
          dedupe: `later|${ALICE}`,
          address: ALICE,
          noteId: 'local:0xe1:1',
          category: 'payouts',
          sendAfter: NOW + 86_400,
          expiresAt: null,
          payload: {
            template: 'payment-made',
            vars: { note: 'Later note', amount: '$2.00', period: '2', link: 'https://notes.markets/app/note/x' },
          },
        },
      ],
      NOW,
    );
    const q = await (await emailsFor(aliceAcct)).json();
    expect(q.queued).toEqual([
      expect.objectContaining({
        id: `later|${ALICE}`,
        status: 'queued',
        subject: 'You were paid $2.00 on Later note',
        at: NOW + 86_400,
        note: 'Later note',
      }),
    ]);
    expect(q.queued[0].html).toContain('/alerts/unsubscribe?token=');
  });
});

describe('migration 0005 (email_messages)', () => {
  it('backfills what the outbox knows about emails sent before it, without bodies', async () => {
    const { MIGRATIONS } = await import('./d1');
    const pre = await localD1(MIGRATIONS.filter((m) => m.name < '0005'));
    try {
      await pre.db
        .prepare(
          `INSERT INTO email_outbox (dedupe, address, note_id, category, payload, send_after, status, next_at, created_at, sent_at)
        VALUES ('d1', '0xa1', 'n1', 'payouts', '{"template":"payment-made","vars":{"note":"N1"}}', 10, 'sent', 10, 10, 11),
               ('d2', '0xa1', NULL, 'payouts', '{"template":"payment-made","vars":{}}', 10, 'skipped', 10, 10, 11),
               ('d3', '0xa1', 'n1', 'due', '{"template":"payment-due","vars":{"note":"N1"}}', 99, 'pending', 99, 10, NULL)`,
        )
        .run();
      const { applyMigrations } = await import('../src/d1');
      await applyMigrations(pre.db, MIGRATIONS);
      const rows = (
        await pre.db.prepare('SELECT dedupe, subject, status, note_label, sent_at FROM email_messages').all()
      ).results;
      expect(rows).toEqual([
        { dedupe: 'd1', subject: 'You were paid: N1', status: 'sent', note_label: 'N1', sent_at: 11 },
      ]);
    } finally {
      await pre.dispose();
    }
  });
});

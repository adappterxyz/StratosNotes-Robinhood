import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile, EXAMPLE_PRODUCTS, instantiateProduct, parseBpmn, type WorkflowDef } from '@sn/core';
import type { NoteState, NoteView } from '@sn/sdk';
import { pgliteDb, type Db } from '@sn/indexer';
import {
  AlertsStore,
  drain,
  EmailNotConfigured,
  EmailRejected,
  mockSender,
  pgSql,
  planNote,
  render,
  TEMPLATES,
  txDeltas,
  when,
  type NoteEvent,
  type Planned,
} from '../src';

const prod = instantiateProduct(EXAMPLE_PRODUCTS.phoenix);
const def: WorkflowDef = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params }).def;
const step = (id: string) => def.steps.findIndex((s) => s.id === id);
const asset = (name: string) => def.assets.findIndex((a) => a.name === name);
const ISSUER = '0x00000000000000000000000000000000000000b1';
const PA = '0x00000000000000000000000000000000000000c1';
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000a2';
const ZERO = '0x0000000000000000000000000000000000000000';
const ESCROW = '0x000000000000000000000000000000000000e5c0';
const NOW = 1_800_000_000;
const DAY = 86_400;
const fx = (n: number) => (BigInt(Math.round(n * 1e4)) * 1_000_000n).toString(); // engine fixed point (10 decimals)
const CASH = asset('USDG');

function state(over: Partial<NoteState> = {}): NoteState {
  return {
    id: 'local:0xe1:1',
    chain: 'local',
    engine: '0xe1',
    pid: '1',
    definition: '0xdef',
    creator: ISSUER,
    ref: '1',
    roles: [ISSUER, PA, ZERO, ESCROW],
    assetTokens: [],
    status: 0,
    tokens: [],
    stepsRun: 0,
    values: {},
    holdings: [
      { asset: 0, owner: ALICE, balance: fx(600) },
      { asset: 0, owner: BOB, balance: fx(400) },
    ],
    createdAt: NOW - DAY,
    updatedAt: NOW,
    reports: { cre: 0, fallback: 0, last: null },
    ...over,
  };
}
function view(over: Partial<NoteView> = {}): NoteView {
  return {
    name: 'Phoenix on ETH',
    issuer: ISSUER,
    phase: 'live',
    strikeDate: NOW - DAY,
    obsDates: [NOW + DAY],
    economics: null,
    ...over,
  } as NoteView;
}
let seq = 0;
const ev = (tx: string, name: string, data: Record<string, unknown>, ts = NOW - 60): NoteEvent => ({
  seq: ++seq,
  tx,
  ts,
  name,
  data,
});
const plan = (s: NoteState, v: NoteView, events: NoteEvent[] = [], now = NOW) =>
  planNote({
    noteId: s.id,
    chainLabel: 'Robinhood Chain testnet',
    link: 'https://notes.markets/app/note/x',
    def,
    state: s,
    view: v,
    events,
    now,
  });

describe('templates', () => {
  it('fills placeholders, escapes HTML and links URLs; every alert carries an unsubscribe link', () => {
    const r = render(
      TEMPLATES['payment-made'],
      { note: '<script>x</script>', amount: '$25.00', period: '1', link: 'https://notes.markets/app/note/1' },
      'https://notes.markets/app/alerts/unsubscribe?token=t',
    );
    expect(r.subject).toBe('You were paid $25.00 on <script>x</script>');
    expect(r.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('<a href="https://notes.markets/app/note/1"');
    expect(r.html).toContain('Stop these emails');
    expect(r.text).toContain('Stop these emails: https://notes.markets/app/alerts/unsubscribe?token=t');
    expect(render(TEMPLATES.code, { code: '123456', link: 'https://x' }).text).not.toContain('Stop these emails');
  });
});

describe('planning (pure)', () => {
  const econ = (status: 'due' | 'paid', funded = false) =>
    ({
      state: 'active',
      ratio: 0.5,
      required: 500,
      coverage: 600,
      coveragePct: 1.2,
      collateral: [{ symbol: 'ETH', asset: 2, amount: 1, haircut: 0.7, price: 2500, value: 1750 }],
      escrowCash: 0,
      lag: 3600,
      grace: 2 * DAY,
      marginCall: null,
      inGrace: null,
      periods: [
        { k: 1, obsDate: NOW - 60, payDate: NOW + 3 * DAY, graceEnd: NOW + 5 * DAY, perUnit: 0.025, total: 25, status },
      ],
      nextCall: { period: 1, total: 25, payDate: NOW + 3 * DAY, graceEnd: NOW + 5 * DAY, funded },
      milestones: [],
      defaultRule: 'cap-at-owed',
    }) as unknown as NoteView['economics'];

  it('a funding call: the issuer now, plus reminders a day and two hours before the payment date', () => {
    const out = plan(state({ tokens: [step('Task_Fund1')] }), view({ economics: econ('due') }));
    const due = out.filter((p) => p.template === 'payment-due');
    expect(due.map((p) => p.address)).toEqual([ISSUER, ISSUER, ISSUER]);
    expect(due.map((p) => p.sendAfter)).toEqual([NOW, NOW + 3 * DAY - DAY, NOW + 3 * DAY - 7200]);
    expect(due[0].vars).toMatchObject({
      amount: '$25.00',
      period: '1',
      deadline: when(NOW + 3 * DAY),
      graceEnds: when(NOW + 5 * DAY),
    });
    expect(due.every((p) => p.expiresAt === NOW + 3 * DAY)).toBe(true);
    // Same inputs, same keys: planning again never queues twice.
    expect(
      plan(state({ tokens: [step('Task_Fund1')] }), view({ economics: econ('due') })).map((p) => p.dedupe),
    ).toEqual(out.map((p) => p.dedupe));
  });

  it('no call before the observation fixes an amount, nor once the issuer has funded it', () => {
    expect(
      plan(
        state({ tokens: [step('Task_Fund1')] }),
        view({ economics: { ...econ('due')!, periods: [] } as never }),
      ).filter((p) => p.template === 'payment-due'),
    ).toEqual([]);
    expect(
      plan(state({ tokens: [step('Task_Fund1')] }), view({ economics: econ('due', true) })).filter(
        (p) => p.template === 'payment-due',
      ),
    ).toEqual([]);
  });

  it("a payment made: each holder is told what they were paid (from the transaction's balance changes)", () => {
    const events = [
      ev('0xt1', 'HoldingChanged', { asset: CASH, owner: ALICE, balance: fx(0) }, NOW - DAY),
      ev('0xt2', 'StepRun', { step: step('Task_Pay1'), kind: 3, actor: ZERO }),
      ev('0xt2', 'HoldingChanged', { asset: CASH, owner: ALICE, balance: fx(15) }),
      ev('0xt2', 'HoldingChanged', { asset: CASH, owner: BOB, balance: fx(10) }),
      ev('0xt2', 'HoldingChanged', { asset: CASH, owner: ESCROW, balance: fx(0) }),
    ];
    expect(txDeltas(events, '0xt2').get(ALICE)?.get(CASH)).toBeCloseTo(15);
    const paid = plan(state(), view(), events).filter((p) => p.template === 'payment-made');
    expect(paid.map((p) => [p.address, p.vars.amount])).toEqual([
      [ALICE, '$15.00'],
      [BOB, '$10.00'],
    ]);
  });

  it('a payment made on an accumulator engine (v4): one DistributionRecorded tells each holder its share', () => {
    const events = [
      ev('0xt1', 'HoldingChanged', { asset: 0, owner: ALICE, balance: fx(600) }, NOW - DAY),
      ev('0xt1', 'HoldingChanged', { asset: 0, owner: BOB, balance: fx(400) }, NOW - DAY),
      ev('0xt2', 'StepRun', { step: step('Task_Pay1'), kind: 3, actor: ZERO }),
      ev('0xt2', 'DistributionRecorded', {
        asset: CASH,
        period: 1,
        holding: 0,
        step: step('Task_Pay1'),
        payer: ESCROW,
        perUnit: fx(0.025),
        total: fx(25),
        supply: fx(1000),
        retire: false,
        hash: '0x',
      }),
      ev('0xt2', 'HoldingChanged', { asset: CASH, owner: ESCROW, balance: fx(0) }),
    ];
    expect(txDeltas(events, '0xt2').get(ALICE)?.get(CASH)).toBeCloseTo(15);
    const paid = plan(state(), view(), events).filter((p) => p.template === 'payment-made');
    expect(paid.map((p) => [p.address, p.vars.amount])).toEqual([
      [ALICE, '$15.00'],
      [BOB, '$10.00'],
    ]);
  });

  it('a default: holders get what they received, the issuer is told too', () => {
    const events = [
      ev('0xt3', 'StepRun', { step: step('Task_Default'), kind: 3, actor: ZERO }),
      ev('0xt3', 'HoldingChanged', { asset: CASH, owner: ALICE, balance: fx(615) }),
    ];
    const out = plan(state(), view(), events);
    expect(out.filter((p) => p.template === 'default-holder').map((p) => [p.address, p.vars.amount])).toEqual([
      [ALICE, '$615.00'],
    ]);
    expect(out.filter((p) => p.template === 'default-issuer').map((p) => p.address)).toEqual([ISSUER]);
  });

  it('receipts: the issuer when the book opens, a subscriber for their units', () => {
    const book = plan(state(), view({ phase: 'book', economics: econ('due') }));
    expect(book.filter((p) => p.template === 'issued').map((p) => p.address)).toEqual([ISSUER]);
    expect(book.find((p) => p.template === 'issued')!.vars.collateral).toContain('50% of units sold');
    const events = [
      ev('0xt4', 'StepRun', { step: step('Task_Subscribe'), kind: 2, actor: ALICE }),
      ev('0xt4', 'HoldingChanged', { asset: 0, owner: ALICE, balance: fx(600) }),
    ];
    const sub = plan(state(), view({ economics: econ('due') }), events).filter((p) => p.template === 'subscribed');
    expect(sub.map((p) => [p.address, p.vars.units, p.category])).toEqual([[ALICE, '600', 'account']]);
    expect(sub[0].vars.protection).toContain('the missed payment plus par');
  });

  it("old events are ignored, so a newly verified email is not sent a note's whole history", () => {
    const events = [
      ev('0xt5', 'StepRun', { step: step('Task_Pay1'), kind: 3, actor: ZERO }, NOW - 10 * DAY),
      ev('0xt5', 'HoldingChanged', { asset: CASH, owner: ALICE, balance: fx(1) }, NOW - 10 * DAY),
    ];
    expect(plan(state(), view(), events).filter((p) => p.template === 'payment-made')).toEqual([]);
  });

  it('an event the indexer re-inserts (new seq, same transaction) keeps its dedupe key: no second email', () => {
    const run = (seq: number) => [
      { ...ev('0xt7', 'StepRun', { step: step('Task_Pay1'), kind: 3, actor: ZERO }), seq },
      { ...ev('0xt7', 'HoldingChanged', { asset: CASH, owner: ALICE, balance: fx(5) }), seq: seq + 1 },
    ];
    const keys = (seq: number) =>
      plan(state(), view(), run(seq))
        .filter((p) => p.template === 'payment-made')
        .map((p) => p.dedupe);
    expect(keys(100)).toEqual(keys(9_000));
    expect(keys(100).length).toBe(1);
  });

  it('an event older than a few hours is not planned (a rewind re-inserting it cannot re-send it)', () => {
    const events = [
      ev('0xt8', 'StepRun', { step: step('Task_Pay1'), kind: 3, actor: ZERO }, NOW - 4 * 3600),
      ev('0xt8', 'HoldingChanged', { asset: CASH, owner: ALICE, balance: fx(1) }, NOW - 4 * 3600),
    ];
    expect(plan(state(), view(), events).filter((p) => p.template === 'payment-made')).toEqual([]);
  });

  it('a funding call still goes out in the grace period (a short schedule can pass the payment date before indexing)', () => {
    const inGrace = NOW + 3 * DAY + 60; // past the payment date, before the grace period ends
    const out = plan(state({ tokens: [step('Task_Fund1')] }), view({ economics: econ('due') }), [], inGrace).filter(
      (p) => p.sendAfter <= inGrace,
    );
    expect(out.map((p) => p.template)).toEqual(['payment-missed']);
    expect(
      plan(state({ tokens: [step('Task_Fund1')] }), view({ economics: econ('due') }), [], NOW + 5 * DAY + 1),
    ).toEqual([]);
  });

  it("a definition's own declarations replace the defaults", () => {
    const own: WorkflowDef = {
      ...def,
      meta: JSON.stringify({
        notify: {
          Task_Pay1: [
            {
              on: 'done',
              audience: 'role:Paying Agent',
              category: 'payouts',
              subject: 'Paid {{period}}',
              body: 'On {{note}}',
            },
          ],
        },
      }),
    };
    const events = [ev('0xt6', 'StepRun', { step: step('Task_Pay1'), kind: 3, actor: ZERO })];
    const out = planNote({
      noteId: 'n',
      chainLabel: 'x',
      link: 'l',
      def: own,
      state: state(),
      view: view(),
      events,
      now: NOW,
    });
    expect(out.map((p) => [p.address, p.subject])).toEqual([[PA, 'Paid {{period}}']]);
  });
});

describe('outbox (SQLite-compatible SQL, run here on PGlite)', () => {
  let db: Db;
  let store: AlertsStore;
  beforeAll(async () => {
    db = await pgliteDb();
    store = new AlertsStore(pgSql(db));
    await store.migrate();
    await store.migrate(); // idempotent
    for (const [a, email, cats] of [
      [ALICE, 'alice@example.com', 'payouts,risk'],
      [BOB, 'bob@example.com', 'risk'],
    ] as const) {
      await store.startVerification({
        address: a,
        email,
        categories: cats.split(','),
        codeHash: 'h',
        codeExpires: NOW + 600,
        linkTokenHash: `l${a}`,
        unsubscribeToken: `u${a}`,
        now: NOW,
      });
      await store.completeVerification(a, '0xsalt', '0xhash', NOW);
    }
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  const item = (p: Partial<Planned> & { dedupe: string; address: string }) => ({
    noteId: 'n',
    category: 'payouts',
    payload: { template: 'payment-made', vars: { note: 'N', amount: '$1.00', period: '1', link: 'https://x' } },
    sendAfter: NOW,
    expiresAt: null,
    ...p,
  });

  it('queues once per dedupe key and sends only what each person wants', async () => {
    expect(await store.enqueue([item({ dedupe: 'a', address: ALICE }), item({ dedupe: 'b', address: BOB })], NOW)).toBe(
      2,
    );
    expect(await store.enqueue([item({ dedupe: 'a', address: ALICE })], NOW)).toBe(0);
    const mail = mockSender();
    const r = await drain(store, mail, { now: NOW, unsubscribeUrl: (t) => `https://u/${t}` });
    expect(r).toMatchObject({ sent: 1, skipped: 1 }); // Bob turned payouts off
    expect(mail.sent.map((e) => e.to)).toEqual(['alice@example.com']);
    expect(mail.sent[0].text).toContain(`https://u/u${ALICE}`);
    expect(await store.counts()).toMatchObject({ sent: 1, skipped: 1 });
  });

  it('holds the outbox while Email Sending is not set up, and sends later', async () => {
    await store.enqueue([item({ dedupe: 'c', address: ALICE })], NOW);
    const down = {
      send: async () => {
        throw new EmailNotConfigured('not onboarded');
      },
    };
    expect(await drain(store, down, { now: NOW, unsubscribeUrl: (t) => t })).toMatchObject({
      held: 1,
      notConfigured: true,
    });
    const mail = mockSender();
    expect((await drain(store, mail, { now: NOW + 601, unsubscribeUrl: (t) => t })).sent).toBe(1);
  });

  it('keeps a copy of each email as sent (and of one that failed for good), never of skipped ones', async () => {
    const copies = await store.messages(ALICE, { limit: 50 });
    expect(copies.map((m) => [m.dedupe, m.status])).toEqual(
      expect.arrayContaining([
        ['a', 'sent'],
        ['c', 'sent'],
      ]),
    );
    const a = copies.find((m) => m.dedupe === 'a')!;
    expect(a).toMatchObject({
      recipient: 'a•••@example.com',
      noteId: 'n',
      noteLabel: 'N',
      category: 'payouts',
      subject: 'You were paid $1.00 on N',
    });
    expect(a.html).toContain('has been paid');
    expect(await store.messages(BOB, { limit: 50 })).toEqual([]); // Bob's was skipped
    await store.enqueue([item({ dedupe: 'f', address: ALICE })], NOW);
    const bounce = {
      send: async () => {
        throw new EmailRejected('bad address');
      },
    };
    expect((await drain(store, bounce, { now: NOW + 1, unsubscribeUrl: (t) => t })).failed).toBe(1);
    expect((await store.messages(ALICE, { limit: 50 })).find((m) => m.dedupe === 'f')).toMatchObject({
      dedupe: 'f',
      status: 'failed',
      sentAt: NOW + 1,
    });
  });

  it('a reminder past its moment is dropped; an unsubscribed person gets nothing', async () => {
    await store.enqueue([item({ dedupe: 'd', address: ALICE, expiresAt: NOW + 10 })], NOW);
    expect((await drain(store, mockSender(), { now: NOW + 20, unsubscribeUrl: (t) => t })).skipped).toBe(1);
    expect(await store.unsubscribe(`u${ALICE}`, NOW)).toBe(true);
    await store.enqueue([item({ dedupe: 'e', address: ALICE })], NOW);
    expect((await drain(store, mockSender(), { now: NOW + 30, unsubscribeUrl: (t) => t })).sent).toBe(0);
  });

  it('keeps the newest copies per address, pages them, and a store without the table still sends once', async () => {
    const W = '0x00000000000000000000000000000000000000d1';
    for (let i = 0; i < 7; i++) {
      await store.record({
        dedupe: `w${i}`,
        address: W,
        noteId: null,
        noteLabel: null,
        category: 'payouts',
        recipient: 'w•••@x.co',
        subject: `s${i}`,
        html: '',
        text: '',
        status: 'sent',
        createdAt: i,
        sentAt: 100 + (i >> 1),
      });
    }
    await store.trimMessages(W, 5);
    const all = await store.messages(W, { limit: 50 });
    expect(all.map((m) => m.dedupe)).toEqual(['w6', 'w5', 'w4', 'w3', 'w2']);
    const p1 = await store.messages(W, { limit: 2 });
    const p2 = await store.messages(W, { limit: 2, before: { at: p1[1].sentAt, id: p1[1].dedupe } });
    expect([...p1, ...p2].map((m) => m.dedupe)).toEqual(['w6', 'w5', 'w4', 'w3']);

    // Deployed before the email_messages migration: the copy fails, the email is still settled (never resent).
    const broken = new AlertsStore({
      all: (q, p) => pgSql(db).all(q, p),
      run: async (q, p) => {
        if (/email_messages/.test(q)) throw new Error('no such table: email_messages');
        await pgSql(db).run(q, p);
      },
    });
    await broken.setCategories(ALICE, ['payouts'], NOW);
    await broken.enqueue([item({ dedupe: 'g', address: ALICE })], NOW);
    const mail = mockSender();
    expect((await drain(broken, mail, { now: NOW + 40, unsubscribeUrl: (t) => t })).sent).toBe(1);
    expect((await drain(broken, mail, { now: NOW + 50, unsubscribeUrl: (t) => t })).sent).toBe(0);
    expect(mail.sent).toHaveLength(1);
  });
});

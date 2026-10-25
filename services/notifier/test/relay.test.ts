import { describe, expect, it } from 'vitest';
import { relayEmail } from '../../../web/worker';
import { EmailNotConfigured, relaySender } from '../src';

const req = (body: unknown, secret?: string) =>
  new Request('https://notes.markets/internal/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Email-Relay-Secret': secret } : {}) },
    body: JSON.stringify(body),
  });
const email = { to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

describe('the Worker email relay (/internal/email)', () => {
  it('refuses requests without the shared secret', async () => {
    expect((await relayEmail(req(email), { EMAIL_RELAY_SECRET: 's3cret' })).status).toBe(401);
    expect((await relayEmail(req(email, 'wrong!'), { EMAIL_RELAY_SECRET: 's3cret' })).status).toBe(401);
    expect((await relayEmail(req(email, 's3cret'), {})).status).toBe(401); // no secret configured: closed
  });

  it('answers 503 until Email Sending is bound or onboarded, so the API holds its outbox', async () => {
    expect((await relayEmail(req(email, 's3cret'), { EMAIL_RELAY_SECRET: 's3cret' })).status).toBe(503);
    const notOnboarded = {
      send: async () => {
        throw new Error('E_SENDER_DOMAIN_NOT_AVAILABLE: Domain not available for sending');
      },
    };
    expect((await relayEmail(req(email, 's3cret'), { EMAIL_RELAY_SECRET: 's3cret', EMAIL: notOnboarded })).status).toBe(
      503,
    );
  });

  it('sends from alerts@notes.markets as "notes.markets" and returns the message id; the API client maps errors', async () => {
    const seen: unknown[] = [];
    const env = {
      EMAIL_RELAY_SECRET: 's3cret',
      EMAIL: {
        send: async (m: unknown) => {
          seen.push(m);
          return { messageId: 'm-1' };
        },
      },
    };
    const ok = await relayEmail(req(email, 's3cret'), env);
    expect(await ok.json()).toEqual({ messageId: 'm-1' });
    expect(seen[0]).toMatchObject({
      to: 'a@example.com',
      from: { email: 'alerts@notes.markets', name: 'notes.markets' },
    });
    expect((await relayEmail(req({ ...email, to: 'nope' }, 's3cret'), env)).status).toBe(400);

    const viaWorker = (e: typeof env | Record<string, unknown>) =>
      relaySender('https://notes.markets/internal/email', 's3cret', (async (_u: unknown, init?: RequestInit) =>
        relayEmail(new Request('https://notes.markets/internal/email', init), e as never)) as typeof fetch);
    expect(await viaWorker(env).send(email)).toEqual({ messageId: 'm-1' });
    await expect(viaWorker({ EMAIL_RELAY_SECRET: 's3cret' }).send(email)).rejects.toBeInstanceOf(EmailNotConfigured);
  });
});

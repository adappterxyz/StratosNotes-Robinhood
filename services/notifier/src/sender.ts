/**
 * Sending email. Production: the notes.markets Worker's POST /internal/email (Cloudflare Email Service, the
 * `EMAIL` send_email binding), authenticated with a shared secret. Local dev and tests: an in-memory sender that
 * keeps what it "sent" (the e2e reads the verification code from it).
 */
export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
}
export interface EmailSender {
  send(e: Email): Promise<{ messageId: string }>;
}

/** Email Sending is not set up yet (the domain is not onboarded, or the Worker has no EMAIL binding). */
export class EmailNotConfigured extends Error {}
/** The relay refused this email for good (bad address, rejected): don't retry. */
export class EmailRejected extends Error {}

export function relaySender(url: string, secret: string, fetchImpl: typeof fetch = fetch): EmailSender {
  return {
    async send(e) {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Email-Relay-Secret': secret },
        body: JSON.stringify(e),
      });
      const body = (await r.json().catch(() => ({}))) as { messageId?: string; error?: string };
      if (r.status === 503) throw new EmailNotConfigured(body.error ?? 'email sending is not configured');
      if (r.status === 400 || r.status === 422) throw new EmailRejected(body.error ?? `rejected (${r.status})`);
      if (!r.ok || !body.messageId) throw new Error(body.error ?? `relay answered ${r.status}`);
      return { messageId: body.messageId };
    },
  };
}

export interface MockSender extends EmailSender {
  sent: Email[];
}

export function mockSender(): MockSender {
  const sent: Email[] = [];
  let n = 0;
  return {
    sent,
    async send(e) {
      sent.push(e);
      return { messageId: `mock-${++n}` };
    },
  };
}

/** The API's verified-email and alerts endpoints (services/api/src/alerts.ts). */
export interface AlertStatus {
  address: string;
  verified: boolean;
  email: string | null;
  emailHash: string | null;
  pending: string | null;
  categories: string[];
  unsubscribed: boolean;
}
/** One email from Alerts → Emails sent (POST /api/alerts/emails). `at`: when it was sent, or is due (queued). */
export interface SentEmail {
  id: string;
  at: number;
  status: 'sent' | 'queued' | 'failed';
  subject: string;
  noteId: string | null;
  note: string | null;
  category: string;
  to: string;
  html: string;
  text: string;
}
export interface EmailsPage {
  address: string;
  emails: SentEmail[];
  queued: SentEmail[];
  next: { at: number; id: string } | null;
  kept: number;
}
export interface Attestation {
  chain: string;
  chainId: number;
  engine: string;
  holder: string;
  emailHash: string;
  expiry: number;
  nonce: string;
  signature: string;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    path,
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok) throw new Error(j?.error ?? `The API answered ${r.status}.`);
  return j as T;
}

export const alertsApi = {
  status: (address: string) => call<AlertStatus>(`/api/alerts/status?address=${address}`),
  start: (b: { address: string; email: string; categories: string[]; issuedAt: number; signature: string }) =>
    call<{ sent: boolean; to: string }>('/api/alerts/start', b),
  verify: (address: string, code: string) =>
    call<{ verified: boolean; email: string }>('/api/alerts/verify', { address, code }),
  confirm: (token: string) =>
    call<{ verified: boolean; address: string; email: string }>(
      `/api/alerts/confirm?token=${encodeURIComponent(token)}`,
    ),
  attestation: (address: string, chain: string) => call<Attestation>('/api/alerts/attestation', { address, chain }),
  preferences: (b: { address: string; categories: string[]; issuedAt: number; signature: string }) =>
    call<{ ok: boolean }>('/api/alerts/preferences', b),
  salt: (b: { address: string; issuedAt: number; signature: string }) =>
    call<{ email: string; salt: string; emailHash: string; formula: string }>('/api/alerts/salt', b),
  emails: (b: {
    address: string;
    issuedAt: number;
    signature: string;
    before?: { at: number; id: string };
    limit?: number;
  }) => call<EmailsPage>('/api/alerts/emails', b),
  unsubscribe: (token: string) => call<{ ok: boolean }>('/api/alerts/unsubscribe', { token }),
};

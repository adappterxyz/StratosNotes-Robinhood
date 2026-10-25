/**
 * Email text: the built-in templates a definition names (core notify.ts), the transactional emails (sign-in
 * code, "your note is live", "you subscribed"), and rendering into a subject, an HTML body and a plain-text body.
 *
 * Pure functions, no Node or database: they run the same in the API, a test, or a Worker cron.
 */

export type Vars = Record<string, string | undefined>;
export interface Rendered {
  subject: string;
  html: string;
  text: string;
}
export interface TemplateText {
  subject: string;
  body: string;
}

/** Built-in templates (core NOTIFY_TEMPLATE_NAMES), plus the transactional ones. */
export const TEMPLATES: Record<string, TemplateText> = {
  'payment-due': {
    subject: 'Payment {{period}} due on {{note}}: {{amount}}',
    body: 'Payment {{period}} on {{note}} is {{amount}}, due by {{deadline}}.\n\nFund it before then. If it is still unfunded, a grace period runs until {{graceEnds}}; after that the note defaults and your collateral goes to the holders.\n\nFund the payment: {{link}}',
  },
  'payment-missed': {
    subject: 'Payment {{period}} missed on {{note}}: grace ends {{graceEnds}}',
    body: 'Payment {{period}} on {{note}} was not funded by its payment date.\n\nYou can still fund it until {{graceEnds}}. If it is unfunded then, the note defaults and your collateral goes to the holders.\n\nFund the payment: {{link}}',
  },
  'margin-call': {
    subject: 'Margin call on {{note}}',
    body: 'Your collateral on {{note}} now covers {{coverage}} of what the note requires.\n\nTop it up by {{deadline}}. If it is still short then, the note defaults and the collateral goes to the holders.\n\nTop up: {{link}}',
  },
  'payment-made': {
    subject: 'You were paid {{amount}} on {{note}}',
    body: 'Payment {{period}} on {{note}} has been paid: {{amount}} is now in your balance on the note.\n\nClaim it whenever you like: {{link}}',
  },
  'default-holder': {
    subject: '{{note}} defaulted: you received {{amount}}',
    body: 'The issuer of {{note}} did not fund a payment in time, so the note has defaulted.\n\nYou received {{amount}} from the collateral the issuer pledged. It is in your balance on the note; withdraw it whenever you like: {{link}}',
  },
  'default-issuer': {
    subject: '{{note}} defaulted',
    body: 'A payment on {{note}} was not funded in time, so the note has defaulted. The holders have been paid from your collateral; anything left over was returned to you.\n\nDetails: {{link}}',
  },
  'collateral-released': {
    subject: 'Collateral released on {{note}}',
    body: 'Every payment on {{note}} has been made, so your collateral has been released: {{amount}} is back in your balance on the note.\n\nWithdraw it: {{link}}',
  },
  'strike-fixed': {
    subject: '{{note}}: strike fixed, the book is closed',
    body: 'Chainlink has fixed the strike on {{note}} and the book is closed. Observations now run on schedule.\n\nFollow the note: {{link}}',
  },
  issued: {
    subject: 'Your note is live: {{note}}',
    body: '{{note}} is live on {{chain}} and the book is open.\n\nYour funding schedule (you fund each payment before its date):\n{{schedule}}\n\nCollateral: {{collateral}}\n\nManage the note: {{link}}',
  },
  subscribed: {
    subject: 'You subscribed to {{units}} units of {{note}}',
    body: 'You subscribed to {{units}} units of {{note}} on {{chain}}.\n\nSchedule:\n{{schedule}}\n\nProtection: {{protection}}\n\nFollow the note: {{link}}',
  },
  code: {
    subject: 'Your notes.markets code: {{code}}',
    body: 'Your notes.markets verification code is {{code}}. It expires in 10 minutes.\n\nOr verify with this link: {{link}}\n\nIf you did not ask for this, ignore this email.',
  },
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Fill {{placeholders}} (unknown ones become empty). `html`: values are HTML-escaped and URLs become links. */
export function fill(text: string, vars: Vars, html = false): string {
  if (!html) return text.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
  // Escape the template text and every value separately, then turn http(s) values into links.
  const parts = text.split(/(\{\{\s*[A-Za-z]+\s*\}\})/);
  return parts
    .map((p) => {
      const m = /^\{\{\s*([A-Za-z]+)\s*\}\}$/.exec(p);
      if (!m) return escapeHtml(p);
      const v = vars[m[1]] ?? '';
      if (/^https?:\/\/[^\s"<>]+$/.test(v))
        return `<a href="${escapeHtml(v)}" style="color:#0B7A52">${escapeHtml(v)}</a>`;
      return escapeHtml(v);
    })
    .join('')
    .replace(/\n/g, '<br>');
}

/**
 * The brand frame (docs/brand/logo-guide.pdf): Paper ground, a white card with 1px lines, the text lockup ("notes" in
 * Ink, bold; a Signal-green square dot; "markets" in Slate) so it shows even with images blocked, Ink text and the
 * darker Signal for links. Inline styles only (email clients ignore <style>).
 */
function frame(bodyHtml: string, footerHtml: string): string {
  const font = "'Geist',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const lockup = `<span style="font-family:${font};font-size:20px;letter-spacing:-0.5px;white-space:nowrap"><b style="color:#0E1116;font-weight:700">notes</b><span style="display:inline-block;width:4px;height:4px;background:#12A971;margin:0 1px 0 1px;vertical-align:baseline"></span><span style="color:#4A5060;font-weight:400">markets</span></span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;700&display=swap" rel="stylesheet"></head><body style="margin:0;padding:0;background:#F4F5F7;font-family:${font};color:#0E1116">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E3E5EA;border-radius:10px;overflow:hidden">
<tr><td style="padding:18px 24px;border-bottom:1px solid #E3E5EA">${lockup}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6;color:#0E1116">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #E3E5EA;font-size:12px;line-height:1.5;color:#6B7280">${footerHtml}</td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * Render a template (a built-in name, or a definition's own subject + body) for one recipient. `unsubscribe`:
 * the one-click link every alert carries (codes do not: they are what the person asked for just now).
 */
export function render(t: TemplateText, vars: Vars, unsubscribe?: string): Rendered {
  const subject = fill(t.subject, vars).replace(/\s+/g, ' ').trim().slice(0, 200);
  const text =
    fill(t.body, vars) + (unsubscribe ? `\n\n--\nStop these emails: ${unsubscribe}` : '') + '\n\nnotes.markets';
  const footer = unsubscribe
    ? `You get this because you turned on email alerts for your wallet on notes.markets. <a href="${escapeHtml(unsubscribe)}" style="color:#0B7A52">Stop these emails</a>.`
    : 'You get this because someone asked to verify this address on notes.markets.';
  return { subject, html: frame(fill(t.body, vars, true), footer), text };
}

export function templateFor(name: string | undefined, own?: { subject?: string; body?: string }): TemplateText | null {
  if (name) return TEMPLATES[name] ?? null;
  if (own?.subject && own.body) return { subject: own.subject, body: own.body };
  return null;
}

/** a•••@x.com: enough for a person to recognise their own address, not enough to read someone else's. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '•••';
  return `${user.slice(0, 1)}•••@${domain}`;
}

/** Lowercase and trimmed: the form that is hashed on-chain (keccak256(abi.encode(salt, email))). */
export const normEmail = (e: string) => e.trim().toLowerCase();
export const isEmail = (e: string) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(e) && e.length <= 254;

/**
 * What a wallet signs (EIP-191) to bind an email to it, change its alert preferences, or read its salt. The app
 * builds the same text; `issuedAt` (unix seconds) must be within ten minutes of the server's clock.
 */
export function alertsMessage(a: {
  action: 'verify' | 'preferences' | 'salt' | 'emails';
  address: string;
  email?: string;
  categories?: string[];
  issuedAt: number;
}): string {
  const what = {
    verify: 'Verify my email for notes.markets',
    preferences: 'Change my notes.markets email alerts',
    salt: 'Show my notes.markets email salt',
    emails: 'Show the emails notes.markets sent me',
  }[a.action];
  return [
    what,
    '',
    `Wallet: ${a.address.toLowerCase()}`,
    ...(a.email !== undefined ? [`Email: ${normEmail(a.email)}`] : []),
    ...(a.categories ? [`Alerts: ${a.categories.length ? [...a.categories].sort().join(', ') : 'none'}`] : []),
    `Issued at: ${a.issuedAt}`,
  ].join('\n');
}

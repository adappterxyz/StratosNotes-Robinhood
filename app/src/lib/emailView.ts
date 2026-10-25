/**
 * Showing a copy of an email inside the app (Alerts → Emails sent). The HTML goes into a sandboxed iframe's srcdoc
 * with no scripts and no same-origin access; on top of that this adds a CSP that blocks scripts, forms, frames and
 * remote images (tracking pixels), and makes links open in a new tab.
 */
const CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; form-action 'none'; base-uri 'none'";

export function emailSrcDoc(html: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><base target="_blank"><style>a{overflow-wrap:anywhere;word-break:break-word}</style>`;
  // Remove anything that could run even though the sandbox already forbids scripts.
  const clean = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|form)\b[\s\S]*?(<\/\1\s*>|\/>)/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  if (/<head[^>]*>/i.test(clean)) return clean.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${clean}</body></html>`;
}

/** The iframe's sandbox: links may open in a new tab (escaping the sandbox); nothing else is allowed. */
export const EMAIL_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/** A signature may be reused for "load more" while it is comfortably inside the API's ten-minute window. */
export const SIGNATURE_REUSE_SEC = 8 * 60;

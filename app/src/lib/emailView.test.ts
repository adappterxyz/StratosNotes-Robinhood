import { describe, expect, it } from 'vitest';
import { render, TEMPLATES } from '@sn/notifier';
import { EMAIL_SANDBOX, emailSrcDoc } from './emailView';

describe('emailSrcDoc', () => {
  it('adds a CSP and target=_blank links to a rendered email, keeping its content', () => {
    const r = render(
      TEMPLATES['payment-made'],
      { note: 'Phoenix', amount: '$12.00', period: '1', link: 'https://notes.markets/app/note/x' },
      'https://notes.markets/app/alerts/unsubscribe?token=t',
    );
    const doc = emailSrcDoc(r.html);
    expect(doc).toMatch(
      /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*"><base target="_blank">/,
    );
    expect(doc).toContain('has been paid');
    expect(doc).toContain('href="https://notes.markets/app/note/x"');
  });

  it('strips scripts, frames, forms and any CSP or base the email brings', () => {
    const doc = emailSrcDoc(
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><base href="https://evil"></head><body><script>alert(1)</script><iframe src="https://x"></iframe><form action="https://x"><input></form>hi</body></html>',
    );
    expect(doc).not.toMatch(/<script|<iframe|<form|default-src \*|https:\/\/evil/i);
    expect(doc).toContain('hi');
  });

  it('wraps a fragment in a document', () => {
    expect(emailSrcDoc('<p>x</p>')).toMatch(/^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv/);
  });

  it('never grants scripts or same-origin', () => {
    expect(EMAIL_SANDBOX).not.toMatch(/allow-scripts|allow-same-origin/);
  });
});

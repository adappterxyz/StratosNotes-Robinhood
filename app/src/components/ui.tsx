/** Small shared pieces: a copyable short address, a local date with UTC on hover, and a step list for multi-transaction flows. */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { fmtDate, short } from '../lib/format';

/** 0x1234…abcd with a copy button; the full address on hover. Links to the explorer when given one. */
export function Addr({ value, href }: { value: string; href?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <span className="addr" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {short(value)}
        </a>
      ) : (
        short(value)
      )}
      <button type="button" onClick={copy} aria-label={copied ? 'Copied' : `Copy ${value}`}>
        {copied ? <Check className="i ic-13" /> : <Copy className="i ic-13" />}
      </button>
    </span>
  );
}

/** A date in the reader's own time zone, with UTC on hover. */
export function When({ t }: { t: number }) {
  if (!t) return <>—</>;
  const utc = new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return (
    <time dateTime={new Date(t * 1000).toISOString()} title={utc}>
      {fmtDate(t)}
    </time>
  );
}

export type StepState = 'todo' | 'now' | 'done' | 'err';

/** The steps of one action ("Approve USDG", "Subscribe"), each with its state. */
export function Steps({ items }: { items: Array<{ label: string; state: StepState }> }) {
  return (
    <ol className="steps" aria-label="Progress">
      {items.map((s, i) => (
        <li key={s.label} className={s.state} aria-current={s.state === 'now' ? 'step' : undefined}>
          <span className="n">{s.state === 'done' ? '✓' : i + 1}</span>
          <span>
            {s.label}
            {s.state === 'now' ? '…' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The AI assistant (Flow's AiChatPanel): a term sheet in plain language
 * becomes a product (opened in the term-sheet dialog to review); a change to
 * the open workflow comes back as a validated patch, highlighted on the canvas.
 * Missing terms come back as a question, never a guess.
 */
import { useEffect, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import type { ProductParams, WorkflowDraft } from '@sn/core';

export type AiResult =
  | {
      kind: 'product';
      params: ProductParams;
      schedule?: { every: number; unit: 'months' | 'days' | 'minutes'; count: number; size?: number };
      notes?: string[];
    }
  | { kind: 'workflow'; bpmnXml: string; changed: string[]; warnings?: string[] }
  | { kind: 'clarify' | 'reply' | 'error'; reply?: string; error?: string };

type Msg = { who: 'you' | 'ai'; text: string; notes?: string[] };

const EXAMPLES = [
  '12M phoenix on the worst of ETH and BTC, 10% p.a. quarterly, 70% coupon barrier with memory, autocall 100% from Q2, knock-in 60%',
  'Snowball on SOL, 9% p.a. quarterly, autocall 100%, KI 65%, 1 year, 25k USDG',
  'Pay the paying agent a 0.1% servicing fee after each coupon',
];

export default function AiPanel({
  draft,
  onResult,
  onClose,
}: {
  draft: () => Promise<WorkflowDraft | undefined>;
  onResult: (r: AiResult) => Promise<string>;
  onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [msgs, busy]);

  const ask = async (text = prompt.trim()) => {
    if (!text || busy) return;
    setMsgs((m) => [...m, { who: 'you', text }]);
    setPrompt('');
    setBusy(true);
    try {
      const r = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, draft: await draft() }),
      });
      const j = (await r.json()) as AiResult & { error?: string };
      if (!r.ok && j.error) throw new Error(j.error);
      const said = await onResult(j);
      const notes = j.kind === 'product' ? j.notes : j.kind === 'workflow' ? j.warnings : undefined;
      setMsgs((m) => [...m, { who: 'ai', text: said, notes }]);
    } catch (e) {
      setMsgs((m) => [...m, { who: 'ai', text: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="ws-ai" aria-label="AI assistant">
      <div className="ws-bar justify-between">
        <span className="row small fw-600">
          <Sparkles className="i text-accent" />
          AI assistant
        </span>
        <button className="btn" onClick={onClose} aria-label="Hide the AI assistant">
          <X className="i" />
        </button>
      </div>
      <div className="chat">
        {msgs.length === 0 && (
          <div className="stack gap-8">
            <p className="xs muted">
              Describe a note, paste a term sheet, or ask for a change to the open workflow. The answer is checked by
              the validator and compiler before it reaches the canvas.
            </p>
            {EXAMPLES.map((x) => (
              <button key={x} className="msg ai btn-bare" onClick={() => ask(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.who}`}>
            {m.text}
            {m.notes?.length ? (
              <ul>
                {m.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        {busy && <div className="msg ai muted">Thinking…</div>}
        <div ref={end} />
      </div>
      <div className="chat-in">
        <textarea
          aria-label="Ask the AI"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. a worst-of phoenix on ETH and SOL…"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <button className="btn primary" disabled={busy || !prompt.trim()} onClick={() => ask()}>
          <Sparkles className="i" />
          {busy ? 'Thinking…' : 'Send'}
        </button>
      </div>
    </aside>
  );
}

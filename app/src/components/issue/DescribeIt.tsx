/**
 * "Describe it": a note in plain words or a pasted term sheet. A note the AI can read as one of the note types opens
 * the guided flow with its terms filled in; a workflow change goes to the studio; a missing term comes back here as
 * a question, never a guess.
 */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { AiResult } from '../AiPanel';
import type { AiReading } from '../../lib/readymade';

const EXAMPLES = [
  'Snowball on SOL, 9% p.a. quarterly, autocall 100%, KI 65%, 1 year, 25k USDG',
  '12M phoenix on the worst of ETH and BTC, 10% p.a. quarterly, 70% coupon barrier with memory, knock-in 60%',
];

export default function DescribeIt({
  onProduct,
  onWorkflow,
}: {
  onProduct: (r: AiReading) => void;
  onWorkflow: (bpmnXml: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ kind: 'ask' | 'err'; text: string } | null>(null);

  const ask = async (text = prompt.trim()) => {
    if (!text || busy) return;
    setPrompt(text);
    setBusy(true);
    setSaid(null);
    try {
      const r = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      });
      let j: AiResult & { error?: string };
      try {
        j = await r.json();
      } catch {
        throw new Error(`The AI is not available right now (${r.status}).`);
      }
      if (!r.ok && j.error) throw new Error(j.error);
      if (j.kind === 'product') onProduct({ params: j.params, schedule: j.schedule, notes: j.notes });
      else if (j.kind === 'workflow') onWorkflow(j.bpmnXml);
      else if (j.kind === 'error') setSaid({ kind: 'err', text: j.error ?? j.reply ?? 'The AI could not read that.' });
      else setSaid({ kind: 'ask', text: j.reply ?? 'No answer.' });
    } catch (e) {
      setSaid({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card dz"
      onSubmit={(e) => {
        e.preventDefault();
        ask();
      }}
    >
      <label htmlFor="dz-prompt" className="small">
        Describe the note, or paste a term sheet. You review every term before anything is issued.
      </label>
      <textarea
        id="dz-prompt"
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. a 12-month phoenix on Tesla paying 10% a year…"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            ask();
          }
        }}
      />
      <div className="row dz-row">
        <div className="row gap-6">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="chip dz-ex" title={x} onClick={() => ask(x)} disabled={busy}>
              {x.split(',')[0]}
            </button>
          ))}
        </div>
        <button type="submit" className="btn primary" disabled={busy || !prompt.trim()}>
          <Sparkles className="i" />
          {busy ? 'Reading it…' : 'Fill in the note'}
        </button>
      </div>
      {said && (
        <div className={`notice ${said.kind === 'err' ? 'err' : 'info'}`} role="status">
          {said.text}
        </div>
      )}
    </form>
  );
}

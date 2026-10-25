/**
 * Steps waiting for the connected wallet: any user task whose role this wallet holds (or that is open to
 * anyone), and unconditioned decisions it makes. The form is built from the step's input fields; a step that
 * takes a deposit pulls it from the wallet (approved for exactly that amount). Works for every workflow.
 */
import { useState } from 'react';
import { isAddress, zeroAddress } from 'viem';
import { dec, FKIND, KIND, OP, SRC, type WorkflowDef } from '@sn/core';
import type { InputValue, NoteState } from '@sn/sdk';
import { useAddress, useNoteChain, useSigner } from '../lib/chains';
import { errText } from '../lib/format';

const KIND_NAME: Record<number, string> = Object.fromEntries(Object.entries(FKIND).map(([k, v]) => [v, k]));

export default function TasksPanel({
  state,
  def,
  onDone,
  hide = [],
}: {
  state: NoteState;
  def: WorkflowDef;
  onDone: () => void;
  hide?: string[];
}) {
  const me = useAddress();
  const engine = useNoteChain(state);
  const signer = useSigner();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  if (!me || state.status !== 0 || !engine) return null;
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(def.meta).names ?? {};
  } catch {
    /* ids */
  }

  const mine = [...new Set(state.tokens)]
    .map((i) => ({ i, s: def.steps[i] }))
    .filter(({ s }) => s && !hide.includes(s.id))
    .filter(({ s }) => {
      const holder = state.roles[s.role];
      const myRole = holder === me || holder === zeroAddress;
      const decision = s.kind === KIND.XOR && s.next.every((e) => e.cond === 0xffff) && s.next.length > 1;
      return myRole && (s.kind === KIND.USER || decision);
    });
  if (!mine.length) return null;

  const run = async (i: number, choice?: number) => {
    const s = def.steps[i];
    setBusy(s.id);
    setMsg(null);
    try {
      const inputs: Record<number, InputValue> = {};
      for (const c of s.captures.filter((x) => x.source === SRC.INPUT)) {
        const f = def.fields[c.field];
        const raw = (values[`${s.id}.${f.name}`] ?? '').trim();
        if (!raw) throw new Error(`Enter ${f.name}.`);
        if (f.kind === FKIND.Text) inputs[c.field] = { kind: 'text', value: raw };
        else if (f.kind === FKIND.Party) {
          if (!isAddress(raw)) throw new Error(`${f.name}: enter an address.`);
          inputs[c.field] = { kind: 'party', value: raw };
        } else if (f.kind === FKIND.Date)
          inputs[c.field] = { kind: 'number', value: BigInt(Math.floor(new Date(raw).getTime() / 1000)) };
        else if (f.kind === FKIND.Bool) inputs[c.field] = { kind: 'number', value: raw === 'true' ? 1n : 0n };
        else if (f.kind === FKIND.Int) inputs[c.field] = { kind: 'number', value: BigInt(raw) };
        else inputs[c.field] = { kind: 'number', value: dec(raw) };
      }
      const w = await signer(state.chain);
      await engine.adapter.executeStep(w, state.id, i, inputs, choice, (t) => setMsg({ kind: 'ok', text: `${t}…` }));
      setMsg({ kind: 'ok', text: `${names[s.id] ?? s.id}: done.` });
      onDone();
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) });
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="card">
      <h3>Waiting for you</h3>
      {mine.map(({ i, s }) => {
        const ins = s.captures.filter((c) => c.source === SRC.INPUT).map((c) => def.fields[c.field]);
        const decision = s.kind === KIND.XOR;
        const dep = s.ops.some((op) => op.kind === OP.DEPOSIT);
        return (
          <div key={s.id} className="stack gap-8 divider-top">
            <div className="spread">
              <strong>{names[s.id] ?? s.id}</strong>
              <span className="xs muted">
                {def.roles[s.role]}
                {s.until ? ' · repeatable' : ''}
              </span>
            </div>
            {ins.map((f) => (
              <div key={f.name} className="field">
                <label htmlFor={`t-${s.id}-${f.name}`}>
                  {f.name} <span className="muted">({KIND_NAME[f.kind]})</span>
                </label>
                <input
                  id={`t-${s.id}-${f.name}`}
                  type={f.kind === FKIND.Date ? 'datetime-local' : 'text'}
                  value={values[`${s.id}.${f.name}`] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [`${s.id}.${f.name}`]: e.target.value }))}
                />
              </div>
            ))}
            {dep && <span className="small muted">This step takes a deposit from your wallet.</span>}
            {decision ? (
              <div className="row">
                {s.next.map((e, k) => (
                  <button key={k} className="btn" disabled={!!busy} onClick={() => run(i, k)}>
                    {names[def.steps[e.target].id] ?? def.steps[e.target].id}
                  </button>
                ))}
              </div>
            ) : (
              <button className="btn primary" disabled={!!busy} onClick={() => run(i)}>
                {busy === s.id ? 'Sending…' : 'Complete'}
              </button>
            )}
          </div>
        );
      })}
      {msg && (
        <div className={`notice ${msg.kind}`} role="status">
          {msg.text}
        </div>
      )}
    </section>
  );
}

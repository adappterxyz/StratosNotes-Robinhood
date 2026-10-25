import { useState } from 'react';
import { signMessage } from 'wagmi/actions';
import { definitionId, templateMessage, type TemplateSummary } from '@sn/core';
import { api } from '../../lib/api';
import { useAddress, useChains } from '../../lib/chains';
import { errText, short } from '../../lib/format';
import { Head } from './Head';
import type { Built, DocInfo } from './types';

/** Save the open workflow as a ready-made note (signed by the author, keyed by its compiled definition). */
export function TemplatePanel({
  doc,
  build,
  onSaved,
  bare = false,
}: {
  doc: DocInfo;
  build: () => Promise<Built>;
  onSaved: (t: TemplateSummary) => void;
  bare?: boolean;
}) {
  const me = useAddress();
  const { wagmi } = useChains();
  const [name, setName] = useState(doc.template && !doc.edited ? doc.template.name : doc.name);
  const [description, setDescription] = useState(doc.template && !doc.edited ? doc.template.description : '');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const save = async () => {
    if (!me) return;
    setMsg(null);
    try {
      setBusy('Compiling…');
      const { c, source } = await build();
      const definition = definitionId(c);
      setBusy('Sign it with your wallet…');
      const signature = await signMessage(wagmi, { message: templateMessage(definition) });
      setBusy('Saving to the ready-made notes…');
      const j = await api.saveTemplate(
        { ...source, definition, name: name.trim(), description, author: me },
        signature,
      );
      setMsg({
        kind: 'ok',
        text: `Saved "${j.name}". Any issuer can now start from it under Issue → Ready-made notes, on any network.`,
      });
      onSaved(j);
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) });
    } finally {
      setBusy('');
    }
  };
  return (
    <>
      {!bare && (
        <Head
          title="Save as ready-made note"
          sub="Publish this note so that you, or any issuer, can start from it again under Issue → Ready-made notes."
        />
      )}
      <div className="section">
        {doc.template && !doc.edited && (
          <div className="notice info">
            Started from the ready-made note "{doc.template.name}" by {short(doc.template.author)}. Saving it again
            under a new name lists it separately.
          </div>
        )}
        <div className="field">
          <label htmlFor="tp-name">Name</label>
          <input id="tp-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tp-desc">Description</label>
          <textarea
            id="tp-desc"
            rows={3}
            maxLength={280}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Who it is for, what is special about it"
          />
        </div>
        <p className="xs muted">
          A ready-made note is identified by the hash of its compiled workflow, the same on every network. The library
          checks your signature, recompiles the workflow and accepts it only if it lands on that hash. It goes on-chain
          the first time someone issues it.
        </p>
        <button className="btn primary lg" disabled={!me || !!busy || !name.trim()} onClick={save}>
          {!me ? 'Connect a wallet' : busy || 'Save as ready-made note'}
        </button>
        {msg && (
          <div className={`notice ${msg.kind}`} role="status">
            {msg.text}
          </div>
        )}
      </div>
    </>
  );
}

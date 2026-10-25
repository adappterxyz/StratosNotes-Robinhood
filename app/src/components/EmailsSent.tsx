/**
 * Alerts → Emails sent: a copy of every alert email sent to this wallet's verified address, newest first, with what
 * is still queued on top. Reading them needs a wallet signature (POST /api/alerts/emails), so nobody can read
 * another wallet's mail by its address; one signature serves "load more" for a few minutes.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Inbox } from 'lucide-react';
import { alertsMessage } from '@sn/notifier';
import { alertsApi, type SentEmail } from '../lib/alerts';
import { useSigner } from '../lib/chains';
import { EMAIL_SANDBOX, emailSrcDoc, SIGNATURE_REUSE_SEC } from '../lib/emailView';
import { errText, fmtDate } from '../lib/format';

const PAGE = 20;
const STATUS: Record<SentEmail['status'], { label: string; cls: string }> = {
  sent: { label: 'Sent', cls: 'live' },
  queued: { label: 'Queued', cls: 'fixing' },
  failed: { label: 'Failed', cls: 'defaulted' },
};

export function EmailsSent({ address, chainKey }: { address: string; chainKey: string }) {
  const signer = useSigner();
  const sig = useRef<{ issuedAt: number; signature: string } | null>(null);
  const [emails, setEmails] = useState<SentEmail[] | null>(null);
  const [queued, setQueued] = useState<SentEmail[]>([]);
  const [next, setNext] = useState<{ at: number; id: string } | null>(null);
  const [kept, setKept] = useState(200);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different wallet: forget the signature and what it showed.
  useEffect(() => {
    sig.current = null;
    setEmails(null);
    setQueued([]);
    setNext(null);
    setOpen(null);
    setError(null);
  }, [address]);

  const proof = async () => {
    const now = Math.floor(Date.now() / 1000);
    if (sig.current && now - sig.current.issuedAt < SIGNATURE_REUSE_SEC) return sig.current;
    const w = await signer(chainKey);
    const signature = await w.signMessage({
      account: w.account!,
      message: alertsMessage({ action: 'emails', address, issuedAt: now }),
    });
    return (sig.current = { issuedAt: now, signature });
  };

  const load = async (more: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const p = await alertsApi.emails({
        address,
        ...(await proof()),
        ...(more && next ? { before: next } : {}),
        limit: PAGE,
      });
      setEmails((x) => (more && x ? [...x, ...p.emails] : p.emails));
      if (!more) setQueued(p.queued);
      setNext(p.next);
      setKept(p.kept);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const all = [...queued, ...(emails ?? [])];
  return (
    <section className="card stack gap-10" data-emails-sent>
      <div className="spread">
        <h3>
          <Inbox className="i" /> Emails sent
        </h3>
        {emails && (
          <button className="btn" disabled={busy} onClick={() => void load(false)}>
            Refresh
          </button>
        )}
      </div>
      {emails === null ? (
        <>
          <p className="xs muted">
            A copy of every alert we email you: what it said, when, and the note it was about. Sign with your wallet to
            show them (no gas), so only this wallet can read its mail.
          </p>
          <button className="btn" disabled={busy} onClick={() => void load(false)}>
            {busy ? 'Waiting for your wallet…' : 'Show my emails'}
          </button>
        </>
      ) : all.length === 0 ? (
        <div className="empty">
          <strong>No emails yet.</strong>
          <span className="xs">Alerts about the notes you issue or hold will show up here.</span>
        </div>
      ) : (
        <ul className="mails">
          {all.map((m) => (
            <EmailRow
              key={`${m.status}:${m.id}`}
              m={m}
              open={open === m.id}
              onToggle={() => setOpen((o) => (o === m.id ? null : m.id))}
            />
          ))}
        </ul>
      )}
      {next && (
        <button className="btn" disabled={busy} onClick={() => void load(true)}>
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
      {emails !== null && (
        <span className="xs muted">We keep your newest {kept} emails. Verification codes are not kept.</span>
      )}
      {error && (
        <div className="notice err" role="status">
          {error}
        </div>
      )}
    </section>
  );
}

function EmailRow({ m, open, onToggle }: { m: SentEmail; open: boolean; onToggle: () => void }) {
  const [view, setView] = useState<'html' | 'text'>(m.html ? 'html' : 'text');
  const st = STATUS[m.status];
  const bodyId = `mail-${m.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (
    <li className={`mail${open ? ' open' : ''}`}>
      <button className="mail-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="mail-subj">{m.subject}</span>
        <span className={`pill ${st.cls}`}>{st.label}</span>
        <ChevronDown className="i mail-chev" aria-hidden />
      </button>
      <div className="mail-meta xs muted">
        <span>{m.status === 'queued' ? `Due ${fmtDate(m.at)}` : fmtDate(m.at)}</span>
        {m.to && <span>to {m.to}</span>}
        {m.noteId && <Link to={`/note/${encodeURIComponent(m.noteId)}`}>{m.note ?? 'Open the note'}</Link>}
      </div>
      {open && (
        <div className="mail-body" id={bodyId}>
          {m.status === 'failed' && <div className="notice err xs">This email could not be delivered.</div>}
          {m.status === 'queued' && <div className="notice warn xs">Not sent yet: this is what it will say.</div>}
          {m.html && (
            <div className="seg mail-views" role="tablist" aria-label="Show as">
              <button
                role="tab"
                aria-selected={view === 'html'}
                className={view === 'html' ? 'active' : ''}
                onClick={() => setView('html')}
              >
                Formatted
              </button>
              <button
                role="tab"
                aria-selected={view === 'text'}
                className={view === 'text' ? 'active' : ''}
                onClick={() => setView('text')}
              >
                Text
              </button>
            </div>
          )}
          {view === 'html' && m.html ? (
            <iframe
              className="mail-frame"
              title={`Email: ${m.subject}`}
              sandbox={EMAIL_SANDBOX}
              referrerPolicy="no-referrer"
              srcDoc={emailSrcDoc(m.html)}
            />
          ) : (
            <pre className="mail-text">{m.text}</pre>
          )}
        </div>
      )}
    </li>
  );
}

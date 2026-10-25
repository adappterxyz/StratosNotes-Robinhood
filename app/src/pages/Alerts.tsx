/**
 * Email alerts: the connected wallet's verified email, what it gets emails about, the proof of the on-chain
 * binding (the salt), and a copy of every email sent (EmailsSent). Also the two pages emails link to: /alerts/confirm (verify by link instead of the code) and
 * /alerts/unsubscribe (one click).
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Mail } from 'lucide-react';
import { NOTIFY_CATEGORIES, NOTIFY_CATEGORY_LABEL } from '@sn/core';
import { alertsMessage } from '@sn/notifier';
import { alertsApi, type AlertStatus } from '../lib/alerts';
import { useAddress, useChains, useSigner } from '../lib/chains';
import { useVerifiedEmail } from '../components/VerifiedEmail';
import { EmailsSent } from '../components/EmailsSent';

export default function AlertsPage() {
  const address = useAddress();
  const { config } = useChains();
  const signer = useSigner();
  const { require, dialog } = useVerifiedEmail();
  const [status, setStatus] = useState<AlertStatus | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const chainKey = config.chains[0]?.key ?? '';

  const load = () => {
    if (address)
      alertsApi
        .status(address)
        .then((s) => {
          setStatus(s);
          setCats(s.categories);
        })
        .catch(() => setStatus(null));
  };
  useEffect(load, [address]); // eslint-disable-line react-hooks/exhaustive-deps

  const signed = async (action: 'preferences' | 'salt', categories?: string[]) => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const w = await signer(chainKey);
    const signature = await w.signMessage({
      account: w.account!,
      message: alertsMessage({ action, address: address!, ...(categories ? { categories } : {}), issuedAt }),
    });
    return { address: address!, issuedAt, signature };
  };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ kind: 'ok', text: await fn() });
      load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!address)
    return (
      <main className="page">
        <div className="empty">
          <strong>Connect a wallet to set up email alerts.</strong>
        </div>
      </main>
    );
  return (
    <main className={`page alerts-page${status?.verified ? ' two' : ''}`} data-alerts>
      <div className="alerts-head">
        <h1>
          <Mail className="i" /> Email alerts
        </h1>
        <p className="muted small">
          Payment calls, payouts, margin calls and defaults on the notes you issue or hold, by email. Issuing and
          subscribing need a verified email.
        </p>
      </div>
      <div className="alerts-config stack gap-12">
        <section className="card stack gap-12">
          {status?.verified ? (
            <div className="notice ok">
              Alerts go to {status.email}
              {status.unsubscribed ? ' (paused: you unsubscribed)' : ''}.
              {status.pending ? ` Waiting for you to verify ${status.pending}.` : ''}
            </div>
          ) : (
            <div className="notice info">No verified email for this wallet yet.</div>
          )}
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void require(chainKey, () => {
                load();
                setMsg({ kind: 'ok', text: 'Your email is verified.' });
              })
            }
          >
            {status?.verified ? 'Change email' : 'Verify an email'}
          </button>
        </section>
        {status?.verified && (
          <section className="card stack gap-10">
            <h3>Email me about</h3>
            {NOTIFY_CATEGORIES.map((c) => (
              <label key={c} className="row small gap-8 min-h-40">
                <input
                  type="checkbox"
                  checked={cats.includes(c)}
                  onChange={(e) => setCats((x) => (e.target.checked ? [...x, c] : x.filter((y) => y !== c)))}
                />
                {NOTIFY_CATEGORY_LABEL[c]}
              </label>
            ))}
            <span className="xs muted">
              Receipts of your own actions (a note you issue, a subscription you make) always come.
            </span>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await alertsApi.preferences({ ...(await signed('preferences', cats)), categories: cats });
                  return 'Saved.';
                })
              }
            >
              Save
            </button>
            <h3 className="mt-8">Proof of your binding</h3>
            <p className="xs muted">
              On-chain there is only keccak256(abi.encode(salt, your email)). Download the salt to prove later which
              email this wallet bound.
            </p>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const s = await alertsApi.salt(await signed('salt'));
                  const blob = new Blob([JSON.stringify({ address, ...s }, null, 2)], { type: 'application/json' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = `notes-markets-email-${address.slice(2, 8)}.json`;
                  a.click();
                  return 'Downloaded.';
                })
              }
            >
              <Download className="i" /> Download salt
            </button>
          </section>
        )}
        {msg && (
          <div className={`notice ${msg.kind === 'ok' ? 'ok' : 'err'}`} role="status">
            {msg.text}
          </div>
        )}
      </div>
      {status?.verified && (
        <div className="alerts-mail">
          <EmailsSent address={address} chainKey={chainKey} />
        </div>
      )}
      {dialog}
    </main>
  );
}

export function AlertsConfirm() {
  const [params] = useSearchParams();
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    alertsApi
      .confirm(params.get('token') ?? '')
      .then((r) =>
        setState({
          ok: true,
          text: `Verified: alerts go to ${r.email}. Go back to the tab you came from and press Continue.`,
        }),
      )
      .catch((e) => setState({ ok: false, text: e instanceof Error ? e.message : String(e) }));
  }, [params]);
  return (
    <main className="page page-narrow">
      <h1>Verify your email</h1>
      {state ? (
        <div className={`notice ${state.ok ? 'ok' : 'err'}`}>{state.text}</div>
      ) : (
        <p className="muted">Checking…</p>
      )}
    </main>
  );
}

export function AlertsUnsubscribe() {
  const [params] = useSearchParams();
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <main className="page page-narrow">
      <h1>Stop email alerts</h1>
      {state ? (
        <div className={`notice ${state.ok ? 'ok' : 'err'}`}>{state.text}</div>
      ) : (
        <button
          className="btn primary"
          onClick={() =>
            alertsApi
              .unsubscribe(params.get('token') ?? '')
              .then(() =>
                setState({
                  ok: true,
                  text: 'Done: no more alerts. Your email stays verified for issuing and subscribing; turn alerts back on under Email alerts.',
                }),
              )
              .catch((e) => setState({ ok: false, text: e instanceof Error ? e.message : String(e) }))
          }
        >
          Stop all alert emails
        </button>
      )}
      <p className="xs muted mt-12">
        <Link to="/alerts">Email alerts</Link>
      </p>
    </main>
  );
}

/**
 * A verified email is required to issue and to subscribe (docs/NOTIFICATIONS.md). `useVerifiedEmail()` wraps an
 * action: if the connected wallet already has a verified email (and, where the chain's engine requires it, a
 * current on-chain attestation) the action runs at once; otherwise a dialog verifies the email inline, without
 * leaving the flow:
 *
 *   1. enter an email and choose alerts, sign a message with the wallet (EIP-191) -> we email a 6-digit code;
 *   2. type the code -> verified (the email's link works too, from another tab);
 *   3. where the engine requires it, submit the verifier's attestation on-chain (the salted hash only);
 *   4. the original action continues.
 *
 * The contracts are permissionless, so this gate is the app's (and the API's); with requireEmail on, the engine
 * also refuses unverified issuers, subscribers and unit recipients itself.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Mail, X } from 'lucide-react';
import type { Address, Hex } from 'viem';
import { NOTIFY_CATEGORIES, NOTIFY_CATEGORY_LABEL, type NotifyCategory } from '@sn/core';
import { flowEngineAbi } from '@sn/sdk';
import { alertsMessage } from '@sn/notifier';
import { alertsApi, type AlertStatus } from '../lib/alerts';
import { useAddress, useChains, useSigner } from '../lib/chains';

type Step = 'email' | 'code' | 'attest' | 'done';

/** Whether this chain's engine wants an on-chain attestation for `address`, and whether one is current. */
async function onchainNeed(
  client: ReturnType<typeof useChains>['byKey'][string]['client'],
  engine: Address,
  address: Address,
) {
  try {
    const [verifier, required, email] = await Promise.all([
      client.readContract({ address: engine, abi: flowEngineAbi, functionName: 'verifier' }) as Promise<Address>,
      client.readContract({ address: engine, abi: flowEngineAbi, functionName: 'requireEmail' }) as Promise<boolean>,
      client.readContract({ address: engine, abi: flowEngineAbi, functionName: 'emailOf', args: [address] }) as Promise<
        readonly [Hex, bigint, bigint]
      >,
    ]);
    const enabled = verifier !== '0x0000000000000000000000000000000000000000';
    return { enabled, required, current: Number(email[1]) > Date.now() / 1000 + 300 };
  } catch {
    return { enabled: false, required: false, current: false }; // an engine without attestations
  }
}

export function useVerifiedEmail() {
  const address = useAddress();
  const { byKey } = useChains();
  const signer = useSigner();
  const [open, setOpen] = useState<{ chain: string; step: Step } | null>(null);
  const pending = useRef<(() => void | Promise<void>) | null>(null);

  const finish = useCallback(async () => {
    setOpen(null);
    const run = pending.current;
    pending.current = null;
    await run?.();
  }, []);

  /** Run `action` once the connected wallet has a verified email (and its attestation on `chainKey`). */
  const require = useCallback(
    async (chainKey: string, action: () => void | Promise<void>) => {
      if (!address) return action(); // the action itself asks to connect a wallet
      pending.current = action;
      const target = byKey[chainKey];
      const [status, chain] = await Promise.all([
        alertsApi.status(address).catch(() => null),
        target
          ? onchainNeed(target.client, target.cfg.engine, address as Address)
          : Promise.resolve({ enabled: false, required: false, current: false }),
      ]);
      const needAttest = chain.enabled && !chain.current;
      if (status?.verified && !needAttest) return finish();
      setOpen({ chain: chainKey, step: status?.verified ? 'attest' : 'email' });
    },
    [address, byKey, finish],
  );

  const dialog: ReactNode =
    open && address ? (
      <VerifyDialog
        address={address}
        chainKey={open.chain}
        start={open.step}
        onDone={finish}
        onClose={() => {
          pending.current = null;
          setOpen(null);
        }}
        signer={signer}
      />
    ) : null;
  return { require, dialog };
}

function VerifyDialog({
  address,
  chainKey,
  start,
  onDone,
  onClose,
  signer,
}: {
  address: string;
  chainKey: string;
  start: Step;
  onDone: () => void;
  onClose: () => void;
  signer: ReturnType<typeof useSigner>;
}) {
  const { byKey } = useChains();
  const [step, setStep] = useState<Step>(start);
  const [email, setEmail] = useState('');
  const [cats, setCats] = useState<NotifyCategory[]>([...NOTIFY_CATEGORIES]);
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AlertStatus | null>(null);

  useEffect(() => {
    alertsApi
      .status(address)
      .then(setStatus)
      .catch(() => {});
  }, [address]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : String(e));
    } finally {
      setBusy('');
    }
  };

  const sendCode = () =>
    act('Sending the code…', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const w = await signer(chainKey);
      const signature = await w.signMessage({
        account: w.account!,
        message: alertsMessage({ action: 'verify', address, email, categories: cats, issuedAt }),
      });
      const r = await alertsApi.start({ address, email, categories: cats, issuedAt, signature });
      setSentTo(r.to);
      setStep('code');
    });

  const attest = async () => {
    const target = byKey[chainKey];
    if (!target) return onDone();
    const need = await onchainNeed(target.client, target.cfg.engine, address as Address);
    if (!need.enabled || need.current) return onDone();
    setStep('attest');
    await act('Recording your verified email on-chain…', async () => {
      const a = await alertsApi.attestation(address, chainKey);
      const w = await signer(chainKey);
      const hash = await w.writeContract({
        account: w.account!,
        chain: target.chain,
        address: target.cfg.engine,
        abi: flowEngineAbi,
        functionName: 'attestEmail',
        args: [address as Address, a.emailHash as Hex, BigInt(a.expiry), a.signature as Hex],
      });
      await target.client.waitForTransactionReceipt({ hash });
      onDone();
    });
  };

  const verify = () =>
    act('Checking the code…', async () => {
      await alertsApi.verify(address, code.trim());
      setStep('attest');
      await attest();
    });

  useEffect(() => {
    if (start === 'attest') void attest();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="scrim" role="presentation" onClick={onClose}>
      <div
        className="modal dialog-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ve-title"
        onClick={(e) => e.stopPropagation()}
        data-verify-email
      >
        <div className="modal-head">
          <div>
            <h2 id="ve-title">
              <Mail className="i" /> Verify your email
            </h2>
            <p className="xs muted">
              Issuing and subscribing need a verified email, so payment calls, payouts and defaults reach you.
            </p>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close">
            <X className="i" />
          </button>
        </div>
        <div className="stack p-16 gap-12">
          {status?.verified && step === 'email' && (
            <div className="notice info">Alerts go to {status.email}. Enter a new address to change it.</div>
          )}
          {step === 'email' && (
            <>
              <div className="field">
                <label htmlFor="ve-email">Email</label>
                <input
                  id="ve-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
                <span className="hint">
                  We store it off-chain. On-chain there is only a salted hash of it, and you can download the salt to
                  prove which email you bound.
                </span>
              </div>
              <fieldset className="field fieldset-bare">
                <legend className="lbl">Email me about</legend>
                {NOTIFY_CATEGORIES.map((c) => (
                  <label key={c} className="row small gap-8 min-h-32">
                    <input
                      type="checkbox"
                      checked={cats.includes(c)}
                      onChange={(e) => setCats((x) => (e.target.checked ? [...x, c] : x.filter((y) => y !== c)))}
                    />
                    {NOTIFY_CATEGORY_LABEL[c]}
                  </label>
                ))}
              </fieldset>
              <button
                className="btn primary"
                disabled={!!busy || !/^\S+@\S+\.\S+$/.test(email.trim())}
                onClick={sendCode}
                data-send-code
              >
                {busy || 'Sign and send the code'}
              </button>
              <span className="xs muted">Your wallet asks you to sign a message (no transaction, no gas).</span>
            </>
          )}
          {step === 'code' && (
            <>
              <div className="notice ok">We sent a 6-digit code to {sentTo}. It expires in 10 minutes.</div>
              <div className="field">
                <label htmlFor="ve-code">Code</label>
                <input
                  id="ve-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                />
                <span className="hint">You can also open the link in the email, then press Continue.</span>
              </div>
              <div className="row gap-8 flex-wrap">
                <button
                  className="btn primary"
                  disabled={!!busy || code.length !== 6}
                  onClick={verify}
                  data-verify-code
                >
                  {busy || 'Verify and continue'}
                </button>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() =>
                    act('Checking…', async () => {
                      const s = await alertsApi.status(address);
                      if (!s.verified || s.pending)
                        throw new Error('Not verified yet: enter the code, or open the link in the email first.');
                      await attest();
                    })
                  }
                >
                  Continue
                </button>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() => {
                    setStep('email');
                    setCode('');
                  }}
                >
                  Use another email
                </button>
              </div>
            </>
          )}
          {step === 'attest' && (
            <div className="notice info">{busy || 'Verified. Recording it on-chain (one transaction)…'}</div>
          )}
          {error && (
            <div className="notice err" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

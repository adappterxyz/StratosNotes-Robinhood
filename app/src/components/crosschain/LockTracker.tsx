import { useEffect, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Clock, ExternalLink } from 'lucide-react';
import { formatUnits } from 'viem';
import type { ChainConfig } from '../../lib/api';
import { ccipLink, receiptLabel, type Leg } from './shared';
import { useMyLocks } from './useMyLocks';

/** The wallet's recent locks, step by step: locked, Chainlink CCIP delivering, credited, then pledged or sent back. */
export function LockTracker({ leg, address, tick }: { leg: Leg; address: string | null; tick: number }) {
  const locks = useMyLocks(leg, address, tick);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 5_000);
    return () => clearInterval(t);
  }, []);
  if (!locks?.length) return null;
  const symOf = (token: string) =>
    receiptLabel(
      Object.entries(leg.receipts).find(([, r]) => r.token.toLowerCase() === token.toLowerCase())?.[0] ?? 'tokens',
    );
  const decOf = (token: string) =>
    Object.values(leg.receipts).find((r) => r.token.toLowerCase() === token.toLowerCase())?.decimals ?? 18;
  const ex = (c: ChainConfig, tx: string) => (c.explorer ? `${c.explorer}/tx/${tx}` : undefined);
  const mins = (s: number) => `${Math.max(0, Math.floor(s / 60))} min`;
  return (
    <div className="xc-track stack" aria-label="Your recent locks">
      {locks.map((l) => {
        const done = !!l.credited;
        return (
          <ol
            key={l.lockId}
            className={`xc-steps${l.fate ? ' spent' : ''}`}
            data-lock-state={l.fate ? l.fate.kind : done ? 'credited' : 'in-flight'}
          >
            <li className="done">
              <CheckCircle2 className="i" />
              <span>
                <b>Locked on {leg.asset.name}</b> · {formatUnits(l.amount, decOf(l.token))} {symOf(l.token)} ·{' '}
                {new Date(l.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {ex(leg.asset, l.tx) && (
                  <>
                    {' '}
                    ·{' '}
                    <a href={ex(leg.asset, l.tx)} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  </>
                )}
              </span>
            </li>
            <li className={done ? 'done' : 'active'}>
              {done ? <CheckCircle2 className="i" /> : <Clock className="i" />}
              <span>
                <b>{done ? 'Delivered by Chainlink CCIP' : 'Chainlink CCIP delivering'}</b>
                {done ? '' : ` · ${mins(now - l.at)} so far, usually 15–25`} ·{' '}
                <a href={ccipLink(l.messageId)} target="_blank" rel="noreferrer">
                  Follow on CCIP <ExternalLink className="i ic-11" />
                </a>
              </span>
            </li>
            <li className={done ? 'done' : ''}>
              {done ? <CheckCircle2 className="i" /> : <ArrowRightLeft className="i" />}
              <span>
                <b>
                  {done
                    ? l.fate
                      ? `Credited on ${leg.home.name}`
                      : `Credited on ${leg.home.name}: ready to pledge`
                    : `Credited on ${leg.home.name}`}
                </b>
                {done && ex(leg.home, l.credited!) && (
                  <>
                    {' '}
                    ·{' '}
                    <a href={ex(leg.home, l.credited!)} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  </>
                )}
              </span>
            </li>
            {l.fate && (
              <li className="done used">
                <CheckCircle2 className="i" />
                <span>
                  <b>
                    {l.fate.kind === 'pledged'
                      ? 'Pledged into a note'
                      : `Sent back to ${leg.asset.name}: not available to pledge`}
                  </b>
                  {ex(leg.home, l.fate.tx) && (
                    <>
                      {' '}
                      ·{' '}
                      <a href={ex(leg.home, l.fate.tx)} target="_blank" rel="noreferrer">
                        tx
                      </a>
                    </>
                  )}
                </span>
              </li>
            )}
          </ol>
        );
      })}
    </div>
  );
}

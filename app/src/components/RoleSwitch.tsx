/**
 * Dev builds with the test wallet only: switch between anvil test accounts (issuer, two investors) in one
 * click, so one person, or the e2e test, can issue a note and then subscribe to it.
 */
import { useState } from 'react';
import { TEST_ROLES, type TestWallet } from '../lib/testWallet';

let wallet: TestWallet | null = null;
export const setTestWallet = (w: TestWallet) => {
  wallet = w;
};

export default function RoleSwitch() {
  const [role, setRole] = useState(() => wallet?.role ?? 0);
  if (!wallet) return null;
  return (
    <div
      className="seg role-switch"
      role="group"
      aria-label="Test account"
      title="Dev build: anvil test accounts in the test wallet"
    >
      <span className="xs muted pad-0-6">Test</span>
      {TEST_ROLES.map((r, i) => (
        <button
          key={r.label}
          className={role === i ? 'active' : ''}
          aria-pressed={role === i}
          onClick={() => {
            wallet!.setRole(i);
            setRole(i);
          }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

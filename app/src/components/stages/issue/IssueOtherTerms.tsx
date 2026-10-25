import type { Dispatch, SetStateAction } from 'react';
import { FKIND } from '@sn/core';
import { fieldLabel } from '@sn/sdk';

const KIND_NAME: Record<number, string> = Object.fromEntries(Object.entries(FKIND).map(([k, v]) => [v, k]));

/** Inputs the workflow asks for that the issue panel has no dedicated control for. */
export function IssueOtherTerms({
  generic,
  sym,
  valueOf,
  setValues,
}: {
  generic: Array<{ name: string; kind: number }>;
  sym: string;
  valueOf: (name: string) => string;
  setValues: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  return (
    <div className="section">
      <span className="label">Other terms</span>
      <div className="form-grid">
        {generic.map((f) => (
          <div key={f.name} className="field">
            <label htmlFor={`is-${f.name}`}>
              {fieldLabel(f.name).replace('USDC', sym)} <span className="dim">({KIND_NAME[f.kind]})</span>
            </label>
            <input
              id={`is-${f.name}`}
              type={f.kind === FKIND.Date ? 'datetime-local' : 'text'}
              value={valueOf(f.name)}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

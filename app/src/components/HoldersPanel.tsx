/** Who holds what in a note: note units, cash owed and delivered tokens, per holder. */
import { NOTE_ASSET, type NoteState } from '@sn/sdk';
import type { WorkflowDef } from '@sn/core';
import { SCALE } from '@sn/core';
import { useAddress } from '../lib/chains';
import { fmtMoney, short } from '../lib/format';

export default function HoldersPanel({
  state,
  def,
  explorer,
  issuer,
}: {
  state: NoteState;
  def: WorkflowDef;
  explorer?: string;
  issuer: string;
}) {
  const me = useAddress();
  const owners = [...new Set(state.holdings.map((h) => h.owner))].sort(
    (a, b) => Number(a === issuer) - Number(b === issuer),
  );
  if (!owners.length) return null;
  const label = (asset: number) => (asset === NOTE_ASSET ? 'units' : (def.assets[asset]?.name ?? `asset ${asset}`));
  return (
    <section className="card">
      <div className="spread">
        <h3>Holders</h3>
        <span className="xs muted">
          {owners.length} account{owners.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="scroll-x">
        <table className="t">
          <thead>
            <tr>
              <th>Holder</th>
              <th className="r">Balances</th>
            </tr>
          </thead>
          <tbody>
            {owners.map((o) => (
              <tr key={o}>
                <td>
                  {explorer ? (
                    <a href={`${explorer}/address/${o}`} target="_blank" rel="noreferrer" className="num">
                      {short(o)}
                    </a>
                  ) : (
                    <span className="num">{short(o)}</span>
                  )}
                  <div className="xs muted">
                    {o === issuer ? 'Issuer' : 'Investor'}
                    {me === o ? ' · you' : ''}
                  </div>
                </td>
                <td className="r">
                  {state.holdings
                    .filter((h) => h.owner === o)
                    .map((h) => (
                      <div key={h.asset} className="num small">
                        {fmtMoney(Number(BigInt(h.balance)) / Number(SCALE), h.asset === NOTE_ASSET ? 0 : 4)}{' '}
                        {label(h.asset)}
                      </div>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

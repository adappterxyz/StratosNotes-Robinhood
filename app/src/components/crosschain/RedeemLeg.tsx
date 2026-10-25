import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { formatUnits } from 'viem';
import { homeGatewayAbi } from '@sn/sdk';
import { useAddress, useChains, useSigner } from '../../lib/chains';
import { errText } from '../../lib/format';
import { CcipStatus } from './CcipStatus';
import { useReceiptBalances } from './legs';
import { messageIdOf, receiptLabel, type Leg } from './shared';

/** Receipts held in the wallet (locked, never pledged; or paid out by an earlier gateway), sent back by hand. */
export function RedeemLeg({ leg }: { leg: Leg }) {
  const address = useAddress();
  const signer = useSigner();
  const { byKey } = useChains();
  const [tick, setTick] = useState(0);
  const syms = leg ? Object.keys(leg.receipts) : [];
  const bal = useReceiptBalances(leg, syms, tick);
  const [state, setState] = useState<{ busy: string; text: string; bad?: boolean; msg?: string }>({
    busy: '',
    text: '',
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!leg || !address) return null;
  const held = syms.filter((s) => (bal[s] ?? 0n) > 0n);
  if (!held.length) return null;

  const redeem = async (s: string) => {
    const r = leg.receipts[s];
    setState({ busy: s, text: `Switching to ${leg.home.name}…` });
    try {
      const w = await signer(leg.home.key);
      const client = byKey[leg.home.key].client;
      const amount = bal[s];
      const fee = (await client.readContract({
        address: leg.gateway,
        abi: homeGatewayAbi,
        functionName: 'quoteRedeem',
        args: [r.receipt, amount, address as `0x${string}`],
      })) as bigint;
      setState({
        busy: s,
        text: `Release ${formatUnits(amount, r.decimals)} ${receiptLabel(s)} on ${leg.asset.name} (CCIP fee ${formatUnits(fee, 18).slice(0, 10)} ETH)…`,
      });
      const hash = await w.writeContract({
        address: leg.gateway,
        abi: homeGatewayAbi,
        functionName: 'redeem',
        args: [r.receipt, amount, address as `0x${string}`],
        value: fee,
        account: w.account!,
        chain: w.chain,
      });
      const rc = await client.waitForTransactionReceipt({ hash });
      setState({
        busy: '',
        text: `Sent. Chainlink CCIP releases your ${receiptLabel(s)} on ${leg.asset.name} in about 15–25 minutes.`,
        msg: messageIdOf(rc.logs),
      });
      setTick((t) => t + 1);
    } catch (e) {
      setState({ busy: '', text: errText(e), bad: true });
    }
  };

  return (
    <section className="card stack">
      <div className="row gap-8">
        <ArrowRightLeft className="i" />
        <h3 className="m-0">Collateral receipts{leg.version ? ` (earlier engine, v${leg.version})` : ''}</h3>
      </div>
      <p className="xs muted">
        Tokens you locked on {leg.asset.name}
        {leg.version ? ' for notes on the earlier engine' : ''} and have not pledged into a note
        {leg.version ? ', or a payout from an earlier note' : ''}. To use them as collateral, pledge them when you
        issue. Send them back only if you no longer want to issue with them.
      </p>
      {held.map((s) => (
        <div key={s} className="row justify-between gap-8">
          <span>
            {formatUnits(bal[s], leg.receipts[s].decimals)} {receiptLabel(s)} locked on {leg.asset.name}
          </span>
          {confirming === s ? (
            <span className="row gap-6">
              <button className="btn" onClick={() => setConfirming(null)}>
                Keep locked
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  setConfirming(null);
                  void redeem(s);
                }}
                disabled={!!state.busy}
              >
                Yes, send back
              </button>
            </span>
          ) : (
            <button className="btn" onClick={() => setConfirming(s)} disabled={!!state.busy}>
              {state.busy === s ? 'Sending back…' : `Send back to ${leg.asset.name}`}
            </button>
          )}
        </div>
      ))}
      {confirming && (
        <div className="notice warn xs" role="alert">
          This unlocks your {receiptLabel(confirming)} and sends it back to your wallet on {leg.asset.name} (about 15–25
          minutes). You can't pledge it to a note afterwards without locking it again.
        </div>
      )}
      <CcipStatus state={state} />
    </section>
  );
}

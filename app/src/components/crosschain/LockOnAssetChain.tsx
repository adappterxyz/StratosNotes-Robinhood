import { useState } from 'react';
import { Lock } from 'lucide-react';
import { erc20Abi, formatUnits, parseUnits } from 'viem';
import { remoteVaultAbi } from '@sn/sdk';
import { useAddress, useChains, useSigner } from '../../lib/chains';
import { errText } from '../../lib/format';
import { CcipStatus } from './CcipStatus';
import { useCrossChain, useReceiptBalances } from './legs';
import { LockTracker } from './LockTracker';
import { messageIdOf, receiptLabel } from './shared';

/** Issue flow: lock collateral on its own (asset) chain so its receipts can be pledged into the note on Robinhood Chain. */
export function LockOnAssetChain({ needed }: { needed: Array<{ receipt: string; amount: number }> }) {
  const leg = useCrossChain();
  const address = useAddress();
  const signer = useSigner();
  const { byKey } = useChains();
  const [tick, setTick] = useState(0);
  const [sym, setSym] = useState(needed[0]?.receipt ?? '');
  const [amount, setAmount] = useState(String(needed[0]?.amount ?? ''));
  const [state, setState] = useState<{ busy: boolean; text: string; bad?: boolean; msg?: string }>({
    busy: false,
    text: '',
  });
  const bal = useReceiptBalances(
    leg,
    needed.map((n) => n.receipt),
    tick,
  );
  if (!leg) return null;
  const r = leg.receipts[sym];

  const lock = async () => {
    if (!r || !address) return;
    setState({ busy: true, text: `Switching to ${leg.asset.name}…` });
    try {
      const w = await signer(leg.asset.key);
      const client = byKey[leg.asset.key].client;
      const units = parseUnits(amount || '0', r.decimals);
      if (units <= 0n) throw new Error('Enter an amount to lock.');
      const allowance = await client.readContract({
        address: r.token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address as `0x${string}`, leg.vault],
      });
      if (allowance < units) {
        setState({ busy: true, text: `Approve ${receiptLabel(sym)} for the vault…` });
        const h = await w.writeContract({
          address: r.token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [leg.vault, units],
          account: w.account!,
          chain: w.chain,
        });
        await client.waitForTransactionReceipt({ hash: h });
      }
      const fee = (await client.readContract({
        address: leg.vault,
        abi: remoteVaultAbi,
        functionName: 'quoteLock',
        args: [r.token, units, address as `0x${string}`],
      })) as bigint;
      setState({
        busy: true,
        text: `Lock ${amount} ${receiptLabel(sym)} (CCIP fee ${formatUnits(fee, 18).slice(0, 10)} ETH)…`,
      });
      const hash = await w.writeContract({
        address: leg.vault,
        abi: remoteVaultAbi,
        functionName: 'lock',
        args: [r.token, units, address as `0x${string}`],
        value: fee,
        account: w.account!,
        chain: w.chain,
      });
      const rc = await client.waitForTransactionReceipt({ hash });
      const msg = messageIdOf(rc.logs);
      setState({
        busy: false,
        text: `Locked on ${leg.asset.name}. Chainlink CCIP is delivering it to ${leg.home.name}: usually 15–25 minutes, then it shows here, ready to pledge.`,
        msg,
      });
      setTick((t) => t + 1);
    } catch (e) {
      setState({ busy: false, text: errText(e), bad: true });
    }
  };

  return (
    <div className="xc-panel stack">
      <div className="row gap-8">
        <Lock className="i" />
        <strong>Lock collateral on {leg.asset.name}</strong>
      </div>
      <p className="xs muted">
        This note's collateral stays on {leg.asset.name}: lock it in the vault there, and Chainlink CCIP credits
        receipts to you on {leg.home.name} to pledge at Approve Terms. The tokens never leave {leg.asset.name}. Delivery
        takes about 15–25 minutes, so lock well before the strike.
      </p>
      <div className="row gap-8 flex-wrap">
        <label className="field" htmlFor="xc-token">
          <span className="lbl">Token</span>
          <select id="xc-token" value={sym} onChange={(e) => setSym(e.target.value)}>
            {needed.map((n) => (
              <option key={n.receipt} value={n.receipt}>
                {receiptLabel(n.receipt)}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="xc-amount">
          <span className="lbl">Amount</span>
          <input id="xc-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button className="btn primary" onClick={lock} disabled={state.busy || !address}>
          Lock on {leg.asset.name}
        </button>
      </div>
      <ul className="xs m-0 pl-18">
        {needed.map((n) => (
          <li key={n.receipt}>
            {receiptLabel(n.receipt)} locked on {leg.asset.name}, ready to pledge:{' '}
            <strong>
              {leg.receipts[n.receipt] ? formatUnits(bal[n.receipt] ?? 0n, leg.receipts[n.receipt].decimals) : '—'}
            </strong>
            {n.amount ? ` (this issuance needs ${n.amount})` : ''}
          </li>
        ))}
      </ul>
      <CcipStatus state={state} />
      <LockTracker leg={leg} address={address} tick={tick} />
    </div>
  );
}

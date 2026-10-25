import { useEffect, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Clock, ExternalLink } from 'lucide-react';
import { formatUnits } from 'viem';
import { homeGatewayAbi } from '@sn/sdk';
import { useAddress, useChains, useSigner } from '../../lib/chains';
import { errText } from '../../lib/format';
import { CcipStatus } from './CcipStatus';
import { useGatewayVersion } from './legs';
import { ccipLink, messageIdOf, receiptLabel, type Leg } from './shared';

type ReleaseRow = {
  index: bigint;
  sym: string;
  decimals: number;
  amount: bigint;
  to: string;
  sent?: { messageId: string; tx: string };
};

/** Releases queued for you at a v2 gateway (from its events), and their CCIP messages once sent. */
export function AutoReleases({ leg }: { leg: Leg }) {
  const address = useAddress();
  const signer = useSigner();
  const { byKey } = useChains();
  const version = useGatewayVersion(leg);
  const [rows, setRows] = useState<ReleaseRow[]>([]);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ busy: string; text: string; bad?: boolean; msg?: string }>({
    busy: '',
    text: '',
  });
  useEffect(() => {
    if (version !== 2 || !address) return;
    let live = true;
    const client = byKey[leg.home.key].client;
    const bySym = new Map(
      Object.entries(leg.receipts).map(([sym, r]) => [r.receipt.toLowerCase(), { sym, decimals: r.decimals }]),
    );
    const read = async () => {
      // The gateway is deployed after the engine: the engine's first block bounds the scan.
      const fromBlock = BigInt(leg.home.fromBlock ?? 0);
      const queued = await client.getContractEvents({
        address: leg.gateway,
        abi: homeGatewayAbi,
        eventName: 'ReleaseQueued',
        args: { account: address as `0x${string}` },
        fromBlock,
      });
      const byIndex = new Map<bigint, ReleaseRow>();
      for (const l of queued) {
        const a = l.args as { index: bigint; receipt: string; to: string; amount: bigint };
        const r = bySym.get(a.receipt.toLowerCase());
        byIndex.set(a.index, {
          index: a.index,
          sym: r?.sym ?? 'receipt',
          decimals: r?.decimals ?? 18,
          amount: a.amount,
          to: a.to,
        }); // later events: the joined total
      }
      if (byIndex.size) {
        const sent = await client.getContractEvents({
          address: leg.gateway,
          abi: homeGatewayAbi,
          eventName: 'ReleaseSent',
          args: { index: [...byIndex.keys()] },
          fromBlock,
        });
        for (const l of sent) {
          const a = l.args as { index: bigint; messageId: string };
          const row = byIndex.get(a.index);
          if (row) row.sent = { messageId: a.messageId, tx: l.transactionHash ?? '' };
        }
      }
      if (live) setRows([...byIndex.values()].sort((x, y) => Number(y.index - x.index)));
    };
    read().catch(() => {});
    const t = setInterval(() => read().catch(() => {}), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [leg, address, version, tick, byKey]);
  if (version !== 2 || !address || !rows.length) return null;

  // Anyone may send a queued release now, paying its CCIP fee (it does not have to wait for the next flush).
  const sendNow = async (row: ReleaseRow) => {
    setState({ busy: String(row.index), text: `Switching to ${leg.home.name}…` });
    try {
      const w = await signer(leg.home.key);
      const client = byKey[leg.home.key].client;
      const r = leg.receipts[row.sym];
      const fee = (await client.readContract({
        address: leg.gateway,
        abi: homeGatewayAbi,
        functionName: 'quoteRedeem',
        args: [r.receipt, row.amount, row.to as `0x${string}`],
      })) as bigint;
      setState({ busy: String(row.index), text: `Send now (CCIP fee ${formatUnits(fee, 18).slice(0, 10)} ETH)…` });
      const hash = await w.writeContract({
        address: leg.gateway,
        abi: homeGatewayAbi,
        functionName: 'sendQueued',
        args: [row.index],
        value: fee,
        account: w.account!,
        chain: w.chain,
      });
      const rc = await client.waitForTransactionReceipt({ hash });
      setState({
        busy: '',
        text: `Sent. Chainlink CCIP pays your ${receiptLabel(row.sym)} on ${leg.asset.name} in about 15–25 minutes.`,
        msg: messageIdOf(rc.logs),
      });
      setTick((t) => t + 1);
    } catch (e) {
      setState({ busy: '', text: errText(e), bad: true });
    }
  };

  return (
    <section className="card stack" data-auto-releases>
      <div className="row gap-8">
        <ArrowRightLeft className="i" />
        <h3 className="m-0">Collateral released to {leg.asset.name}</h3>
      </div>
      <p className="xs muted">
        Collateral a note paid you (your share after a default, or an issuer's collateral back at maturity) stays on{' '}
        {leg.asset.name}: the receipts are burned on {leg.home.name} and the vault there pays the real token to your
        address, over Chainlink CCIP. Nothing to redeem.
      </p>
      {rows.map((row) => (
        <div key={String(row.index)} className="row justify-between gap-8 flex-wrap">
          <span>
            {formatUnits(row.amount, row.decimals)} {receiptLabel(row.sym)}
            {row.to.toLowerCase() !== address.toLowerCase() ? (
              <span className="xs muted">
                {' '}
                to {row.to.slice(0, 6)}…{row.to.slice(-4)}
              </span>
            ) : null}
          </span>
          {row.sent ? (
            <span className="xs">
              <CheckCircle2 className="i ic-12" /> Released to your wallet on {leg.asset.name}{' '}
              <a href={ccipLink(row.sent.messageId)} target="_blank" rel="noreferrer">
                CCIP msg {row.sent.messageId.slice(0, 10)}… <ExternalLink className="i ic-11" />
              </a>
            </span>
          ) : (
            <span className="row xs gap-8">
              <Clock className="i ic-12" /> Queued: goes out with the next release run
              <button className="btn sm" onClick={() => sendNow(row)} disabled={!!state.busy}>
                {state.busy === String(row.index) ? 'Sending…' : 'Send now'}
              </button>
            </span>
          )}
        </div>
      ))}
      <CcipStatus state={state} />
    </section>
  );
}

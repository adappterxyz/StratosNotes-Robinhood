import { useEffect, useState } from 'react';
import { parseAbiItem } from 'viem';
import { useChains } from '../../lib/chains';
import type { Leg } from './shared';

const lockedEvent = parseAbiItem(
  'event Locked(bytes32 indexed lockId, address indexed from, address indexed beneficiary, address token, uint256 amount, bytes32 messageId, uint256 fee)',
);
const creditedEvent = parseAbiItem(
  'event LockCredited(bytes32 indexed lockId, uint64 indexed chainSelector, address indexed account, address receipt, uint256 amount, bytes32 messageId)',
);
const redeemSentEvent = parseAbiItem(
  'event RedeemSent(bytes32 indexed redeemId, uint64 indexed chainSelector, address indexed from, address to, address receipt, uint256 amount, bytes32 messageId, uint256 fee)',
);
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
export type TrackedLock = {
  lockId: `0x${string}`;
  token: string;
  amount: bigint;
  messageId: string;
  tx: string;
  at: number;
  credited: string | null;
  creditedBlock?: bigint;
  receipt?: string;
  fate?: { kind: 'sent-back' | 'pledged'; tx: string };
};

/**
 * The wallet's recent locks, read from both chains (so it survives a reload): locked in the vault on the asset chain,
 * Chainlink CCIP on the way, credited on the home chain and ready to pledge. Re-read every 15 s.
 */
export function useMyLocks(leg: Leg, address: string | null, tick: number) {
  const { byKey } = useChains();
  const [locks, setLocks] = useState<TrackedLock[] | null>(null);
  useEffect(() => {
    if (!address) return;
    let live = true;
    const asset = byKey[leg.asset.key]?.client,
      home = byKey[leg.home.key]?.client;
    if (!asset || !home) return;
    const read = async () => {
      try {
        const head = await asset.getBlockNumber();
        const found: TrackedLock[] = [];
        // Recent history in a few ranges (the asset chain makes several blocks a second).
        for (let i = 0n; i < 4n && found.length < 3; i++) {
          const to = head - i * 50_000n,
            from = to - 49_999n;
          const logs = await asset.getLogs({
            address: leg.vault,
            event: lockedEvent,
            args: { beneficiary: address as `0x${string}` },
            fromBlock: from > 0n ? from : 0n,
            toBlock: to,
          });
          for (const l of logs.reverse()) {
            const b = await asset.getBlock({ blockNumber: l.blockNumber! });
            found.push({
              lockId: l.args.lockId!,
              token: l.args.token!,
              amount: l.args.amount!,
              messageId: l.args.messageId!,
              tx: l.transactionHash!,
              at: Number(b.timestamp),
              credited: null,
            });
          }
        }
        const recent = found.filter((x) => Date.now() / 1000 - x.at < 86_400).slice(0, 3);
        if (recent.length) {
          const hHead = await home.getBlockNumber();
          for (let i = 0n; i < 6n; i++) {
            const to = hHead - i * 10_000n,
              from = to - 9_999n;
            const logs = await home.getLogs({
              address: leg.gateway,
              event: creditedEvent,
              args: { lockId: recent.map((x) => x.lockId) },
              fromBlock: from,
              toBlock: to,
            });
            for (const l of logs) {
              const x = recent.find((y) => y.lockId === l.args.lockId);
              if (x) {
                x.credited = l.transactionHash!;
                x.creditedBlock = l.blockNumber!;
                x.receipt = l.args.receipt!;
              }
            }
            if (recent.every((x) => x.credited)) break;
          }
          // What became of each credited lock: sent back (RedeemSent) or pledged into a note (receipt moved to the
          // engine), matched oldest first; otherwise it is still in the wallet, ready to pledge.
          const credited = recent
            .filter((x) => x.creditedBlock)
            .sort((a, b) => Number(a.creditedBlock! - b.creditedBlock!));
          if (credited.length) {
            const since = credited[0].creditedBlock!;
            const outs: Array<{
              kind: 'sent-back' | 'pledged';
              receipt: string;
              amount: bigint;
              block: bigint;
              tx: string;
            }> = [];
            const engine = leg.home.engine as `0x${string}` | undefined;
            for (let from = since; from <= hHead; from += 10_000n) {
              const to = from + 9_999n > hHead ? hHead : from + 9_999n;
              const sent = await home.getLogs({
                address: leg.gateway,
                event: redeemSentEvent,
                args: { from: address as `0x${string}` },
                fromBlock: from,
                toBlock: to,
              });
              for (const l of sent)
                outs.push({
                  kind: 'sent-back',
                  receipt: l.args.receipt!.toLowerCase(),
                  amount: l.args.amount!,
                  block: l.blockNumber!,
                  tx: l.transactionHash!,
                });
              if (engine) {
                const pl = await home.getLogs({
                  address: Object.values(leg.receipts).map((r) => r.receipt),
                  event: transferEvent,
                  args: { from: address as `0x${string}`, to: engine },
                  fromBlock: from,
                  toBlock: to,
                });
                for (const l of pl)
                  outs.push({
                    kind: 'pledged',
                    receipt: l.address.toLowerCase(),
                    amount: l.args.value!,
                    block: l.blockNumber!,
                    tx: l.transactionHash!,
                  });
              }
            }
            outs.sort((a, b) => Number(a.block - b.block));
            for (const x of credited) {
              const i = outs.findIndex(
                (o) => o.receipt === x.receipt!.toLowerCase() && o.block >= x.creditedBlock! && o.amount >= x.amount,
              );
              if (i >= 0) {
                x.fate = { kind: outs[i].kind, tx: outs[i].tx };
                outs.splice(i, 1);
              }
            }
          }
        }
        if (live) setLocks(recent);
      } catch {
        /* a slow RPC: keep the last reading */
      }
    };
    void read();
    const t = setInterval(read, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
    // A leg is static deployment config identified by its home/asset keys; engine and receipts come with it.
  }, [leg.vault, leg.gateway, leg.asset.key, leg.home.key, address, tick, byKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return locks;
}

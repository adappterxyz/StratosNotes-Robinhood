/**
 * Wrap ETH: the engine holds ERC-20s only, so ETH collateral (or ETH delivered below the barrier) is the chain's
 * canonical WETH. An issuer with native ETH but not enough WETH wraps it here in one transaction (WETH.deposit with
 * the ETH as value), from their own wallet on the note's chain.
 */
import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, formatEther, parseAbi, parseEther } from 'viem';
import { CHAIN_TOKENS, type NoteChain } from '@sn/core';
import { useAddress, useChains, useSigner } from '../lib/chains';
import { errText, fmtMoney } from '../lib/format';

const wethAbi = parseAbi(['function deposit() payable']);

/** The canonical WETH of a chain, if it has one here. */
export const wethOf = (chainKey: string): `0x${string}` | undefined =>
  CHAIN_TOKENS[chainKey as NoteChain]?.WETH?.address;

export default function WrapEth({ chainKey }: { chainKey: string }) {
  const me = useAddress();
  const { byKey } = useChains();
  const signer = useSigner();
  const weth = wethOf(chainKey);
  const entry = byKey[chainKey];
  const [bal, setBal] = useState<{ eth: number; weth: number } | null>(null);
  const [amount, setAmount] = useState('0.01');
  const [state, setState] = useState<{ busy: boolean; text: string; bad?: boolean }>({ busy: false, text: '' });
  const read = useCallback(async () => {
    if (!me || !weth || !entry) return;
    try {
      const [eth, w] = await Promise.all([
        entry.client.getBalance({ address: me as `0x${string}` }),
        entry.client.readContract({
          address: weth,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [me as `0x${string}`],
        }),
      ]);
      setBal({ eth: Number(formatEther(eth)), weth: Number(formatEther(w)) });
    } catch {
      setBal(null);
    }
  }, [me, weth, entry]);
  useEffect(() => {
    void read();
  }, [read]);
  if (!me || !weth || !entry) return null;
  const wrap = async () => {
    let value: bigint;
    try {
      value = parseEther(amount);
    } catch {
      setState({ busy: false, bad: true, text: 'Enter an amount of ETH.' });
      return;
    }
    if (value <= 0n) {
      setState({ busy: false, bad: true, text: 'Enter an amount of ETH.' });
      return;
    }
    setState({ busy: true, text: `Wrapping ${amount} ETH on ${entry.cfg.name}: confirm in your wallet…` });
    try {
      const w = await signer(chainKey);
      const hash = await w.writeContract({
        address: weth,
        abi: wethAbi,
        functionName: 'deposit',
        value,
        account: w.account!,
        chain: w.chain,
      });
      await entry.client.waitForTransactionReceipt({ hash });
      setState({ busy: false, text: `${amount} WETH received.` });
      void read();
    } catch (e) {
      const t = errText(e);
      setState({
        busy: false,
        bad: true,
        text: /insufficient funds/i.test(t) ? 'Not enough ETH (keep some for gas).' : t,
      });
    }
  };
  return (
    <div className="row gap-8 items-center flex-wrap" data-wrap-eth>
      <span className="xs muted">
        ETH collateral is pledged as WETH.
        {bal ? ` You hold ${fmtMoney(bal.eth, 4)} ETH and ${fmtMoney(bal.weth, 4)} WETH on ${entry.cfg.name}.` : ''}
      </span>
      <input
        className="w-96"
        aria-label="ETH to wrap"
        type="number"
        min={0}
        step="any"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button className="btn" disabled={state.busy} onClick={() => void wrap()}>
        {state.busy ? 'Wrapping…' : 'Wrap ETH into WETH'}
      </button>
      {state.text && (
        <span className={`xs ${state.bad ? 'err' : 'muted'}`} role="status">
          {state.text}
        </span>
      )}
    </div>
  );
}

/**
 * The network a note is issued on: Robinhood Chain testnet or Base Sepolia (whichever this deployment serves). Each
 * runs its own engine; the cash token follows the chain (USDG on Robinhood Chain, USDC on Base).
 */
import { CHAIN_CASH, isNoteChain, NOTE_CHAIN_SHORT } from '@sn/core';

export function ChainPicker({
  chains,
  value,
  onPick,
}: {
  chains: ReadonlyArray<{ key: string; name: string }>;
  value: string;
  onPick: (key: string) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label="Network" data-chain-picker>
      {chains.map((c) => (
        <button
          key={c.key}
          type="button"
          role="radio"
          aria-checked={c.key === value}
          className={c.key === value ? 'active' : ''}
          data-chain={c.key}
          onClick={() => c.key !== value && onPick(c.key)}
          title={`${c.name}${isNoteChain(c.key) ? `: paid in ${CHAIN_CASH[c.key].token}` : ''}`}
        >
          {isNoteChain(c.key) ? NOTE_CHAIN_SHORT[c.key] : c.name}
        </button>
      ))}
    </div>
  );
}

/** What a note on `key` can deliver and pledge, in one line for the network field's hint. */
export function chainHint(key: string): string {
  if (key === 'base-sepolia')
    return "Notes on Base are issued and paid in USDC there. Below the knock-in a note can deliver WETH; stocks, BTC and the rest settle in cash. Collateral is USDC or WETH pledged into the note, or Robinhood's stock tokens (TSLA, AMZN, AMD, PLTR), USDG or WETH locked on Robinhood Chain via Chainlink CCIP.";
  return "Notes on Robinhood Chain are issued and paid in USDG there. Below the knock-in a note can deliver Robinhood's TSLA, AMZN, AMD or PLTR token, or WETH; every other underlying (BTC, other stocks, forex, commodities) settles in cash. Collateral is pledged into the note, or USDC or WETH locked on Base via Chainlink CCIP.";
}

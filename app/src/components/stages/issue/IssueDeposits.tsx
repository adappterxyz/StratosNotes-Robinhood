import { CASH_FAUCETS, CHAIN_CASH, CHAIN_TOKENS, isNoteChain, STOCK_TOKEN_FAUCETS } from '@sn/core';
import type { IssuePlan } from '@sn/sdk';
import type { Built } from '../types';

const CASH_ISSUER: Record<string, string> = { USDG: 'Paxos', USDC: 'Circle' };

/** Which steps deposit collateral from the wallet, and where the testnet tokens come from (by the note's chain). */
export function IssueDeposits({
  deposits,
  built,
  chainKey,
}: {
  deposits: IssuePlan['steps'];
  built: Built;
  chainKey: string;
}) {
  const chain = isNoteChain(chainKey) ? chainKey : null;
  const cash = chain ? CHAIN_CASH[chain].token : null;
  const stocks =
    chain === 'robinhood-testnet' &&
    built.ir.assets.some((a) => a.token && CHAIN_TOKENS['robinhood-testnet'][a.token]?.issuer === 'Robinhood');
  const receipts = built.ir.assets.some((a) => a.token?.includes('.'));
  return (
    <p className="xs muted">
      {deposits.map((s) => s.name).join(', ')} {deposits.length > 1 ? 'deposit' : 'deposits'} the collateral from your
      wallet; the wallet asks you to approve exactly each amount first.
      {chain && cash ? (
        <>
          {' '}
          {cash} comes from{' '}
          <a href={CASH_FAUCETS[chain]} target="_blank" rel="noreferrer">
            {CASH_ISSUER[cash] ?? cash}'s faucet
          </a>
        </>
      ) : (
        ''
      )}
      {stocks ? (
        <>
          ; Robinhood Chain's stock tokens from{' '}
          <a href={STOCK_TOKEN_FAUCETS['robinhood-testnet']} target="_blank" rel="noreferrer">
            Robinhood's faucet
          </a>
        </>
      ) : (
        ''
      )}
      {receipts ? '; receipts of collateral locked on the other chain arrive by Chainlink CCIP (lock them above)' : ''}
      {built.ir.assets.some((a) => a.token === 'WETH') ? '; WETH by wrapping testnet ETH (below)' : ''}.
    </p>
  );
}

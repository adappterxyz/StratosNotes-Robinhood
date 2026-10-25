import { CASH_FAUCET, CHAIN_TOKENS, STOCK_TOKEN_FAUCETS } from '@sn/core';
import type { IssuePlan } from '@sn/sdk';
import type { Built } from '../types';

/** Which steps deposit collateral from the wallet, and where the testnet tokens come from. */
export function IssueDeposits({ deposits, built }: { deposits: IssuePlan['steps']; built: Built }) {
  return (
    <p className="xs muted">
      {deposits.map((s) => s.name).join(', ')} {deposits.length > 1 ? 'deposit' : 'deposits'} the collateral from your
      wallet; the wallet asks you to approve exactly each amount first. USDG comes from{' '}
      <a href={CASH_FAUCET} target="_blank" rel="noreferrer">
        Paxos's faucet
      </a>
      {built.ir.assets.some((a) => a.token && CHAIN_TOKENS['robinhood-testnet'][a.token]?.issuer === 'Robinhood') ? (
        <>
          ; Robinhood Chain's stock tokens from{' '}
          <a href={STOCK_TOKEN_FAUCETS['robinhood-testnet']} target="_blank" rel="noreferrer">
            Robinhood's faucet
          </a>
        </>
      ) : (
        ''
      )}
      {built.ir.assets.some((a) => a.token === 'WETH') ? '; WETH by wrapping testnet ETH (below)' : ''}.
    </p>
  );
}

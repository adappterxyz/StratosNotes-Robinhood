import { AutoReleases } from './AutoReleases';
import { useCrossChainLegs } from './legs';
import { RedeemLeg } from './RedeemLeg';

/**
 * Portfolio: collateral paid to you out of a note is released automatically to your wallet on Robinhood Chain
 * (AutoReleases); receipts in your wallet (locked, never pledged; or paid out by an earlier gateway) are redeemed.
 */
export function RedeemOnRobinhood() {
  const legs = useCrossChainLegs();
  return (
    <>
      {legs.map((l) => (
        <AutoReleases key={`a${l.gateway}`} leg={l} />
      ))}
      {legs.map((l) => (
        <RedeemLeg key={l.gateway} leg={l} />
      ))}
    </>
  );
}

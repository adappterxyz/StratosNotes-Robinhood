/**
 * Collateral held on another chain (docs/CROSS-CHAIN.md). The issuer locks USDG, TSLA or AMZN in the vault on
 * Robinhood Chain; Chainlink CCIP tells the gateway on Arbitrum, which mints the same amount of receipts (USDG.rh,
 * TSLA.rh…) to the issuer. The receipts are what the note's escrow holds. With the v2 gateway, receipts never rest
 * in a wallet after the note: whatever the note pays out of them (a holder's share after a default, the issuer's
 * collateral at maturity) is burned on the way out and released automatically to the same address on Robinhood,
 * where the vault pays the real token (AutoReleases). Only receipts locked and never pledged are redeemed by hand.
 * Every message waits for the source chain to be final, so each direction takes roughly 15–25 minutes.
 */
export { LockOnRobinhood } from './crosschain/LockOnRobinhood';
export { RedeemOnRobinhood } from './crosschain/RedeemOnRobinhood';
export { useAutoReleased, useCrossChain, useCrossChainLegs, useGatewayVersion } from './crosschain/legs';

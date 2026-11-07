/**
 * Collateral locked on the other note chain (docs/CROSS-CHAIN.md; nothing renders for a chain until its config carries
 * `crossChain`), both directions: Robinhood's stock tokens, USDG or WETH locked on Robinhood Chain behind a Base note,
 * USDC or WETH locked on Base behind a Robinhood Chain note. The issuer locks a token in the vault on its asset chain;
 * Chainlink CCIP tells the gateway on the note's chain (the home chain), which mints the same amount of receipts. The
 * receipts are what the note's escrow holds. With the v2 gateway, receipts never rest in a wallet after the note:
 * whatever the note pays out of them (a holder's share after a default, the issuer's collateral at maturity) is
 * burned on the way out and released automatically to the same address on the asset chain, where the vault pays the
 * real token (AutoReleases). Only receipts locked and never pledged are redeemed by hand.
 * Every message waits for the source chain to be final, so each direction takes roughly 15–25 minutes.
 */
export { LockOnAssetChain } from './crosschain/LockOnAssetChain';
export { RedeemOnAssetChain } from './crosschain/RedeemOnAssetChain';
export { useAutoReleased, useCrossChain, useCrossChainLegs, useGatewayVersion } from './crosschain/legs';

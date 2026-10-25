/**
 * Collateral held on another chain (planned, docs/CROSS-CHAIN.md; dormant: nothing renders until a chain config carries
 * `crossChain`). The issuer locks a token in the vault on its asset chain; Chainlink CCIP tells the gateway on
 * Robinhood Chain (the home chain, where notes run), which mints the same amount of receipts to the issuer. The
 * receipts are what the note's escrow holds. With the v2 gateway, receipts never rest in a wallet after the note:
 * whatever the note pays out of them (a holder's share after a default, the issuer's collateral at maturity) is
 * burned on the way out and released automatically to the same address on the asset chain, where the vault pays the
 * real token (AutoReleases). Only receipts locked and never pledged are redeemed by hand.
 * Every message waits for the source chain to be final, so each direction takes roughly 15–25 minutes.
 */
export { LockOnAssetChain } from './crosschain/LockOnAssetChain';
export { RedeemOnAssetChain } from './crosschain/RedeemOnAssetChain';
export { useAutoReleased, useCrossChain, useCrossChainLegs, useGatewayVersion } from './crosschain/legs';

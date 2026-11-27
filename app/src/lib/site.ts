/**
 * Whether the app is served as the BNB Chain build (bnb.notes.markets): the same app, with BNB Chain and its stock
 * tokens shown first. Everywhere else every network is equal.
 */
export const isBnbSite = typeof window !== 'undefined' && window.location.hostname.startsWith('bnb.');

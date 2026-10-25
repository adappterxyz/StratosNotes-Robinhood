/** Story beats on the scroll-progress axis (0..1), shared by the scene and the captions. The story branches
 * at maturity: first the price holds (principal back in USDG), then the other ending (knocked in: final ÷ strike in USDG). */
export const BEATS = [
  { from: 0.12, to: 0.24 }, // issue: collateral locked
  { from: 0.24, to: 0.37 }, // subscribe: atomic settlement, USDG in, units out
  { from: 0.37, to: 0.55 }, // observe: Chainlink checks each date
  { from: 0.55, to: 0.68 }, // pay: coupons in USDG to every holder
  { from: 0.68, to: 0.84 }, // ending A: price holds, principal back in USDG, collateral released
  { from: 0.84, to: 1.0 }, // ending B: knocked in, holders repaid final ÷ strike in USDG (the cash-settled form; a physical note delivers TSLA)
] as const;

/** The story before the endings ran on 0..0.8 of the original scene timeline; endings use their own clock. */
export const STORY_END = 0.68;
export const ENDING_SPLIT = 0.84;

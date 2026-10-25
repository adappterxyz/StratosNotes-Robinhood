/**
 * ProductParams: the typed term sheet of a structured product (Flow's
 * products/params.ts, for Solana). A product is instantiated into a BPMN
 * workflow from these parameters, never authored free-hand, so every issued
 * note runs one of a small set of tested payoff engines.
 *
 * Units: one note unit has a face value of 1 unit of the cash token (USDG, Paxos' Global Dollar).
 * Percentages are of face (coupons, protection) or of the strike (barriers,
 * autocall level). Settlement is in cash: below the knock-in barrier a holder
 * receives final / strike per unit.
 *
 * Several underlyings make a worst-of note: every barrier, autocall and
 * redemption looks at the worst performer, min(level_i / strike_i).
 *
 * Economics (docs/NOTE-ECONOMICS.md): a note raises funds for the issuer against
 * pledged collateral. Subscriptions go to the issuer, withdrawable at once. The
 * issuer pledges collateral into the note's escrow at Approve Terms (stablecoin,
 * or tokens valued by Chainlink feeds after a haircut), at least
 * `collateralRatioPct` % of the outstanding notional, checked at the strike and at
 * every observation (margin call, then default if not cured within the grace
 * period). Each observation fixes what is owed; the issuer funds it into escrow
 * before the payment date (observation + settlement lag) or within the grace
 * period after it; unfunded at the end of grace, the note defaults and the escrow
 * (collateral and any partial funding) goes to the holders pro rata. After the
 * final payment the collateral is released to the issuer.
 */

export type ProductType = 'fcn' | 'reverse-convertible' | 'phoenix' | 'snowball' | 'ppn';

export interface Underlying {
  symbol: string;
  /** Chainlink price feed (EVM AggregatorV3) the CRE workflow reads. */
  feed: string;
  /** CRE chain selector name of the feed's chain. */
  feedChain: string;
  /** Bounds every observed price must sit in (checked on-chain). */
  minPrice: number;
  maxPrice: number;
  /** Oldest acceptable round, seconds: the feed's heartbeat (default 3600). */
  staleness?: number;
}

/**
 * A collateral asset the issuer may pledge: the stablecoin (USD) or a real token valued by its Chainlink feed (ETH as
 * the chain's WETH, TSLA, AMZN, AMD and PLTR as Robinhood Chain's stock tokens). Which ones a note can use depends on
 * its chain (CHAIN_TOKENS, REMOTE_COLLATERAL). BTC is synthetic for now: an underlying, cash-settled, never pledged.
 */
export type CollateralSymbol = 'USD' | 'ETH' | 'TSLA' | 'AMZN' | 'AMD' | 'PLTR';
export interface CollateralTerm {
  symbol: CollateralSymbol;
  /** Value counted toward coverage, % of market value (USD 100; volatile tokens lower). Per issuance, 0–100. */
  haircutPct: number;
}

export interface ProductParams {
  productType: ProductType;
  name: string;
  /** Subscription price in % of face (100 = par). */
  issuePricePct: number;
  /** One underlying, or a worst-of basket (up to MAX_UNDERLYINGS). */
  underlyings: Underlying[];
  /**
   * Below the knock-in barrier: `cash` pays final / strike in USDG; `physical`
   * delivers units / strike of the (worst) underlying's token instead, from a
   * delivery reserve the issuer deposits at pre-trade. Default cash.
   */
  settlement?: 'cash' | 'physical';
  /** Number of observations per issuance; the last one is maturity. Dates are set per issuance at pre-trade. */
  observations: number;
  couponRatePct?: number;
  couponBarrierPct?: number;
  memory?: boolean;
  autocallLevelPct?: number;
  autocallFromPeriod?: number;
  knockInBarrierPct?: number;
  protectionPct?: number;
  participationPct?: number;
  /** What the issuer may pledge (up to MAX_COLLATERAL assets). Default: the stablecoin at 100%. */
  collateral?: CollateralTerm[];
  /** Required collateral value, % of the outstanding notional (default for the issue form; set per issuance). */
  collateralRatioPct?: number;
  /** Days from an observation to its payment date (default; set per issuance, in seconds, at Approve Terms). */
  settlementLagDays?: number;
  /** Days of grace after a missed payment date or margin call, 0–7 (default; set per issuance). */
  gracePeriodDays?: number;
  /**
   * DEFAULT RULE: what the holders get from escrow when the note defaults.
   *  'cap-at-owed' (default): what they are owed (the missed payment plus par, valued at the last oracle
   *    prices, stablecoin first), and the rest of the escrow back to the issuer.
   *  'all-to-holders': everything in escrow, whatever it is worth.
   */
  defaultRule?: DefaultRule;
  /**
   * The chain the note is issued on (default and, for new issuance, the only choice: Arbitrum Sepolia, HOME_CHAIN).
   * It decides which real tokens a physically settled note delivers and which the issuer can pledge (CHAIN_TOKENS):
   * token symbols and decimals are compiled into the definition. 'robinhood-testnet' appears only in legacy term
   * sheets (notes issued on Robinhood Chain before it became a collateral-only chain); validateProductParams refuses it.
   */
  chain?: NoteChain;
  /**
   * Where the collateral is held (docs/CROSS-CHAIN.md). Absent or 'note': the tokens are pledged into the note on
   * its own chain. 'robinhood': the issuer locks USDG, TSLA or AMZN in the vault on Robinhood Chain and pledges the
   * receipts (USDG.rh, TSLA.rh, AMZN.rh) that Chainlink CCIP mints on Arbitrum; they are valued with the same Chainlink
   * feed and haircut as the token itself. Only for notes on Arbitrum Sepolia.
   */
  collateralChain?: CollateralChain;
  /**
   * How holders receive their payouts once the note has been paid (docs/ERC20-NOTES.md, "Why claim by default").
   * Either way Chainlink CRE pays each coupon and the redemption INTO the note on its payment date; this is only the
   * last hop, from the note to the holder's wallet.
   *  'claim' (default, also when absent): holders claim from their portfolio whenever they like and pay their own
   *    gas. Payouts accrue until then; one claim collects everything, with a receipt (PayoutPaid) per claim.
   *  'push': the issuer's bot sends each payout to every holder's wallet (pushPayouts), and the issuer pays the gas
   *    (about 55k gas per holder per payment). Holders can still claim at any time.
   * It is read by people and bots only (the term sheet travels in the definition's META), never by the engine.
   */
  payouts?: PayoutMethod;
}

export type PayoutMethod = 'claim' | 'push';
export const PAYOUT_METHODS: readonly PayoutMethod[] = ['claim', 'push'];
/** The note's payout method: 'claim' unless its terms opt in to 'push'. */
export const payoutMethodOf = (p: Pick<ProductParams, 'payouts'> | null | undefined): PayoutMethod =>
  p?.payouts === 'push' ? 'push' : 'claim';

export type CollateralChain = 'note' | 'robinhood';

/**
 * The chains a term sheet can name: Arbitrum Sepolia (home: every note's lifecycle runs there) and Robinhood Chain
 * testnet (the asset chain: a collateral chain only, where TSLA, AMZN, AMD, PLTR and USDG are locked in the vault
 * behind an Arbitrum note, collateralChain 'robinhood'). Notes issued on Robinhood Chain before 2026-10-24 are
 * legacy: their term sheets still read and display, but nothing new is issued there (ISSUANCE_CHAINS).
 */
export type NoteChain = 'arbitrum-sepolia' | 'robinhood-testnet';
export const HOME_CHAIN: NoteChain = 'arbitrum-sepolia';
export const ASSET_CHAIN: NoteChain = 'robinhood-testnet';
/** Every chain a stored term sheet may name (for reading old notes). */
export const NOTE_CHAINS: readonly NoteChain[] = [HOME_CHAIN, ASSET_CHAIN];
/** Where new notes are issued: Arbitrum Sepolia only. */
export const ISSUANCE_CHAINS: readonly NoteChain[] = [HOME_CHAIN];
/** A term sheet that names a chain notes are no longer issued on (a legacy Robinhood Chain note). */
export const isLegacyChainTerms = (p: Pick<ProductParams, 'chain'> | null | undefined) =>
  !ISSUANCE_CHAINS.includes(noteChainOf(p));
export const NOTE_CHAIN_LABELS: Record<NoteChain, string> = {
  'arbitrum-sepolia': 'Arbitrum Sepolia',
  'robinhood-testnet': 'Robinhood Chain testnet',
};
/** The note's chain: its terms' `chain`, else the home chain. */
export const noteChainOf = (p: Pick<ProductParams, 'chain'> | null | undefined): NoteChain =>
  p?.chain && NOTE_CHAINS.includes(p.chain) ? p.chain : HOME_CHAIN;

/** A real token on one of the note chains. */
export interface ChainToken {
  /** The symbol notes.markets uses for it (in definitions and the app). */
  token: string;
  decimals: number;
  address: `0x${string}`;
  /** Full name, for labels and tooltips. */
  name: string;
  issuer: string;
  /** What it is priced as (its Chainlink feed), or null when no feed CRE can read exists: held, not used. */
  valuedAs: CollateralSymbol | null;
}

/**
 * The real tokens on each chain; notes.markets mints none of them. Checked on-chain on 2026-10-24 with eth_call
 * (symbol, name, decimals, supply; WETH's deposit() simulated with value; no transaction sent):
 *  - USDG: Paxos's Global Dollar testnet deployment (docs.paxos.com/guides/stablecoin/usdg/testnet), 6 decimals.
 *  - WETH on Arbitrum Sepolia: the Arbitrum token bridge's WETH (l1Address() = Sepolia WETH 0x7b79…E7f9, the WETH
 *    gateway's calculateL2TokenAddress(Sepolia WETH) returns it).
 *  - WETH on Robinhood Chain testnet: the chain's own token-bridge WETH (aeWETH proxy; l1Address() = Sepolia WETH, the
 *    gateway router's WETH gateway 0x5A8F…E413 maps Sepolia WETH to it). The other "Wrapped ETH" there
 *    (0x33e4…0B94, a plain WETH9) is not the bridge's.
 *  - No wrapped BTC: Robinhood Chain testnet has only user-deployed mocks, and the one issuer-run token on Arbitrum
 *    Sepolia (Threshold's tBTC v2, 0xb8f3…7Cd0, minted only from Bitcoin testnet) is not used. BTC is synthetic: an
 *    underlying priced by Chainlink BTC/USD, settled in cash.
 *  - TSLA, AMZN, AMD, PLTR, NFLX: Robinhood's testnet stock tokens (18 decimals; one deployer, BeaconProxy). TSLA,
 *    AMZN, AMD and PLTR are priced by Robinhood Chain mainnet's Chainlink feeds (FEEDS); NFLX has no feed CRE reads,
 *    so it is held and shown, never pledged or delivered.
 */
export const CHAIN_TOKENS: Record<NoteChain, Record<string, ChainToken>> = {
  'arbitrum-sepolia': {
    USDG: {
      token: 'USDG',
      decimals: 6,
      address: '0xFFC95faa3d63Cde504a05B567C600B78C0b41892',
      name: 'Global Dollar',
      issuer: 'Paxos',
      valuedAs: 'USD',
    },
    WETH: {
      token: 'WETH',
      decimals: 18,
      address: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
      name: 'Wrapped Ether',
      issuer: 'Arbitrum token bridge',
      valuedAs: 'ETH',
    },
  },
  'robinhood-testnet': {
    USDG: {
      token: 'USDG',
      decimals: 6,
      address: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
      name: 'Global Dollar',
      issuer: 'Paxos',
      valuedAs: 'USD',
    },
    WETH: {
      token: 'WETH',
      decimals: 18,
      address: '0x7943e237c7F95DA44E0301572D358911207852Fa',
      name: 'Wrapped Ether',
      issuer: 'Robinhood Chain token bridge',
      valuedAs: 'ETH',
    },
    TSLA: {
      token: 'TSLA',
      decimals: 18,
      address: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E',
      name: 'Tesla',
      issuer: 'Robinhood',
      valuedAs: 'TSLA',
    },
    AMZN: {
      token: 'AMZN',
      decimals: 18,
      address: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02',
      name: 'Amazon',
      issuer: 'Robinhood',
      valuedAs: 'AMZN',
    },
    AMD: {
      token: 'AMD',
      decimals: 18,
      address: '0x71178BAc73cBeb415514eB542a8995b82669778d',
      name: 'AMD',
      issuer: 'Robinhood',
      valuedAs: 'AMD',
    },
    PLTR: {
      token: 'PLTR',
      decimals: 18,
      address: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0',
      name: 'Palantir Technologies',
      issuer: 'Robinhood',
      valuedAs: 'PLTR',
    },
    NFLX: {
      token: 'NFLX',
      decimals: 18,
      address: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93',
      name: 'Netflix',
      issuer: 'Robinhood',
      valuedAs: null,
    },
  },
};

/** Robinhood's stock tokens with no Chainlink feed CRE can read: shown as held, never offered as collateral or delivery. */
export const UNPRICED_STOCKS = Object.values(CHAIN_TOKENS['robinhood-testnet'])
  .filter((t) => t.valuedAs === null)
  .map((t) => t.token);

/** The real local token valued as `sym` on `chain` (USD: the stablecoin), if any. */
export function chainTokenFor(chain: NoteChain, sym: string): ChainToken | undefined {
  return Object.values(CHAIN_TOKENS[chain] ?? {}).find((t) => t.valuedAs === sym);
}

/**
 * Receipts on Arbitrum for collateral locked on Robinhood Chain (deployments/crosschain-testnet.json): the tokens stay
 * in the vault there; a receipt only records the lock for the note and moves only into or out of the engine. Just
 * these three: nothing else is carried over (NFLX's receipt exists but has no feed; no others will be added).
 */
export const REMOTE_COLLATERAL: Record<
  string,
  Partial<Record<CollateralSymbol, { token: string; decimals: number }>>
> = {
  robinhood: {
    USD: { token: 'USDG.rh', decimals: 6 },
    TSLA: { token: 'TSLA.rh', decimals: 18 },
    AMZN: { token: 'AMZN.rh', decimals: 18 },
    AMD: { token: 'AMD.rh', decimals: 18 },
    PLTR: { token: 'PLTR.rh', decimals: 18 },
  },
};

/**
 * notes.markets' own test tokens, retired 2026-10-24: never offered, priced or listed. tUSD alone stays known
 * (TEST_CASH_TOKEN) because notes issued before USDG settle in it.
 */
export const RETIRED_TEST_TOKENS: readonly string[] = ['tETH', 'tBTC', 'tSOL', 'tTSLA', 'tNVDA', 'tAAPL', 'tSPY'];
export const isRetiredTestToken = (sym: string) => RETIRED_TEST_TOKENS.includes(sym.replace(/\.rh$/, ''));

export type DefaultRule = 'cap-at-owed' | 'all-to-holders';
export const DEFAULT_RULES: DefaultRule[] = ['cap-at-owed', 'all-to-holders'];

export const MAX_COLLATERAL = 3;
export const MAX_GRACE_DAYS = 7;
export const DEFAULT_HAIRCUT: Record<CollateralSymbol, number> = {
  USD: 100,
  ETH: 70,
  TSLA: 60,
  AMZN: 60,
  AMD: 60,
  PLTR: 60,
};
export const COLLATERAL_SYMBOLS = Object.keys(DEFAULT_HAIRCUT) as CollateralSymbol[];
export const DEFAULT_COLLATERAL: CollateralTerm[] = [{ symbol: 'USD', haircutPct: 100 }];

/** The term sheet's economics with defaults filled in. */
export function economicsOf(p: ProductParams) {
  return {
    collateral: p.collateral?.length ? p.collateral : DEFAULT_COLLATERAL,
    collateralRatioPct: p.collateralRatioPct ?? 100,
    settlementLagDays: p.settlementLagDays ?? 2,
    gracePeriodDays: p.gracePeriodDays ?? 2,
    defaultRule: p.defaultRule ?? ('cap-at-owed' as DefaultRule),
  };
}

/**
 * The token an underlying is delivered in on the note's chain: the real token there priced as it (WETH for ETH on
 * both; Robinhood's TSLA, AMZN, AMD and PLTR on Robinhood Chain). Undefined when the chain has none (BTC anywhere,
 * stocks on Arbitrum: nothing is bridged over): such a note settles in cash.
 */
export function deliverableToken(
  p: Pick<ProductParams, 'chain'>,
  symbol: string,
): { token: string; decimals: number } | undefined {
  if (symbol === 'USD') return undefined;
  const local = chainTokenFor(noteChainOf(p), symbol);
  return local ? { token: local.token, decimals: local.decimals } : undefined;
}

/** The token behind a collateral asset (USD: the stablecoin) for this note: on its chain, or a Robinhood receipt. */
export function collateralTokenOf(
  p: Pick<ProductParams, 'chain' | 'collateralChain'>,
  c: CollateralSymbol,
): { token: string; decimals: number } | undefined {
  const chain = noteChainOf(p);
  if (p.collateralChain === 'robinhood' && chain === HOME_CHAIN) return REMOTE_COLLATERAL.robinhood[c];
  if (c === 'USD') return CASH_TOKEN;
  const local = chainTokenFor(chain, c);
  return local ? { token: local.token, decimals: local.decimals } : undefined;
}

/** What each collateral symbol is pledged as on a chain (local tokens, or Robinhood receipts), for pickers. */
export const collateralChoices = (p: Pick<ProductParams, 'chain' | 'collateralChain'>) =>
  COLLATERAL_SYMBOLS.map((symbol) => ({ symbol, token: collateralTokenOf(p, symbol)?.token ?? null }));

/**
 * The collateral symbol behind a definition's collateral asset name ("Collateral WETH" -> ETH, "Collateral TSLA.rh"
 * -> TSLA, "Collateral USDG" -> USD), including the names older notes used ("Collateral tETH", "Collateral tUSD").
 */
export function collateralSymbolOfAsset(assetName: string): string | null {
  const m = /^Collateral (\S+)$/.exec(assetName);
  if (!m) return null;
  const t = m[1].replace(/\.rh$/, '');
  if (['USD', 'USDG', 'USDC', 'tUSD'].includes(t)) return 'USD';
  for (const chain of NOTE_CHAINS) {
    const v = CHAIN_TOKENS[chain][t]?.valuedAs;
    if (v) return v;
  }
  const bare = t.replace(/^t(?=[A-Z]{2,}$)/, '');
  return /^[A-Z][A-Z0-9]*$/.test(bare) ? bare : null;
}

export const PRODUCT_LABELS: Record<ProductType, string> = {
  fcn: 'Fixed Coupon Note',
  'reverse-convertible': 'Reverse Convertible',
  phoenix: 'Phoenix Autocallable',
  snowball: 'Snowball Autocallable',
  ppn: 'Principal-Protected Note',
};

export function productUses(t: ProductType) {
  return {
    coupon: t !== 'ppn',
    couponBarrier: t === 'phoenix',
    autocall: t === 'fcn' || t === 'phoenix' || t === 'snowball',
    knockIn: t !== 'ppn',
    protection: t === 'ppn',
  };
}

export const MAX_OBSERVATIONS = 12;
export const MAX_UNDERLYINGS = 3;

/**
 * Term sheets stored in older shapes: a single `underlying` (before baskets), and `stockTokens`, the retired switch
 * between notes.markets' test tokens ('test', dropped) and Robinhood's stock tokens ('robinhood': such a note was
 * meant for Robinhood Chain, so it becomes `chain: 'robinhood-testnet'` unless it names a chain). Read any of them.
 */
export function normalizeParams(p: ProductParams & { underlying?: Underlying; stockTokens?: unknown }): ProductParams {
  let q: ProductParams & { underlying?: Underlying } = p;
  if ('stockTokens' in p) {
    const { stockTokens, ...rest } = p;
    q = stockTokens === 'robinhood' && !rest.chain ? { ...rest, chain: ASSET_CHAIN } : rest;
  }
  if (Array.isArray(q.underlyings) && q.underlyings.length) return q;
  const { underlying, ...rest } = q;
  return { ...rest, underlyings: underlying ? [underlying] : [] };
}

/** "ETH" or "worst of ETH, BTC". */
export const underlyingLabel = (p: ProductParams) =>
  p.underlyings.length > 1
    ? `worst of ${p.underlyings.map((u) => u.symbol).join(', ')}`
    : (p.underlyings[0]?.symbol ?? '');
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether a term sheet can be issued now: its terms hold together (validateTermSheet) and it names the issuance
 * chain, Arbitrum Sepolia. A term sheet with `chain: 'robinhood-testnet'` (a legacy Robinhood Chain note) is refused:
 * Robinhood Chain is a collateral chain only (lock stock tokens there with collateralChain 'robinhood').
 */
export function validateProductParams(p: ProductParams): string[] {
  const e: string[] = [];
  if (p.chain !== undefined && NOTE_CHAINS.includes(p.chain) && !ISSUANCE_CHAINS.includes(p.chain)) {
    e.push(
      `Notes are issued on ${NOTE_CHAIN_LABELS[HOME_CHAIN]} only: ${NOTE_CHAIN_LABELS[p.chain]} is a collateral chain. Issue on ${NOTE_CHAIN_LABELS[HOME_CHAIN]} and lock TSLA, AMZN, AMD, PLTR or USDG on Robinhood Chain as collateral; stock notes settle in cash.`,
    );
  }
  return [...e, ...validateTermSheet(p)];
}

/**
 * A term sheet moved to where notes are issued, for a form that opens an old one (a legacy Robinhood Chain note, a
 * physically settled stock note): the note goes on Arbitrum Sepolia, an undeliverable underlying settles in cash,
 * and stock collateral is locked on Robinhood Chain instead (its receipts pledged; ETH can't be locked there, so it
 * is dropped). Terms already issuable come back unchanged (the same object).
 */
export function toIssuanceTerms(p: ProductParams): ProductParams {
  const undeliverable =
    p.settlement === 'physical' && (p.underlyings ?? []).some((u) => !deliverableToken({}, u.symbol));
  if (!isLegacyChainTerms(p) && !undeliverable) return p;
  const { chain: _legacy, ...rest } = p;
  const q: ProductParams = { ...rest, ...(undeliverable ? { settlement: 'cash' as const } : {}) };
  const col = economicsOf(p).collateral;
  if (col.some((c) => !collateralTokenOf(q, c.symbol))) {
    const remote: ProductParams = { ...q, collateralChain: 'robinhood' };
    const kept = col.filter((c) => !!collateralTokenOf(remote, c.symbol));
    if (kept.some((c) => c.symbol !== 'USD')) return { ...remote, collateral: kept };
    const local = col.filter((c) => !!collateralTokenOf(q, c.symbol));
    return { ...q, collateral: local.length ? local : DEFAULT_COLLATERAL };
  }
  return q;
}

/**
 * Whether a term sheet's terms hold together, whatever chain it names: the check behind validateProductParams, also
 * used to rebuild the workflow of a legacy note (a Robinhood Chain one) for display.
 */
export function validateTermSheet(p: ProductParams): string[] {
  const e: string[] = [];
  const use = productUses(p.productType);
  if (!PRODUCT_LABELS[p.productType]) e.push(`Unknown product type '${p.productType}'.`);
  if (!p.name?.trim()) e.push('Give the product a name.');
  if (!(p.issuePricePct > 0)) e.push('Issue price must be positive (% of face).');
  const unds = p.underlyings ?? [];
  if (!unds.length) e.push('Add an underlying.');
  if (unds.length > MAX_UNDERLYINGS) e.push(`At most ${MAX_UNDERLYINGS} underlyings in a basket.`);
  if (new Set(unds.map((u) => u.symbol)).size !== unds.length) e.push('Each underlying can appear once.');
  for (const u of unds) {
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(u.symbol ?? ''))
      e.push(`'${u.symbol}' is not a ticker (capital letters and digits).`);
    if (!EVM_ADDR.test(u.feed || '')) e.push(`The ${u.symbol} price feed must be a Chainlink feed address (0x…).`);
    if (!(u.minPrice >= 0 && u.maxPrice > u.minPrice)) e.push(`${u.symbol}: price bounds need 0 <= min < max.`);
  }
  if (!(Number.isInteger(p.observations) && p.observations >= 1 && p.observations <= MAX_OBSERVATIONS))
    e.push(`Between 1 and ${MAX_OBSERVATIONS} observations.`);
  if (use.coupon && !(Number(p.couponRatePct) > 0)) e.push('Set a positive coupon rate per period.');
  if (use.couponBarrier && !(Number(p.couponBarrierPct) > 0)) e.push('A phoenix needs a coupon barrier (% of strike).');
  if (use.autocall) {
    if (!(Number(p.autocallLevelPct) > 0)) e.push('Set the autocall level (% of strike).');
    const from = p.autocallFromPeriod ?? 1;
    if (!(Number.isInteger(from) && from >= 1 && from <= p.observations))
      e.push('The first autocall observation must be within the schedule.');
  }
  if (use.knockIn) {
    if (!(Number(p.knockInBarrierPct) > 0)) e.push('Set the knock-in barrier (% of strike).');
    if (use.autocall && Number(p.knockInBarrierPct) >= Number(p.autocallLevelPct))
      e.push('The knock-in barrier must be below the autocall level.');
    if (use.couponBarrier && Number(p.knockInBarrierPct) > Number(p.couponBarrierPct))
      e.push('The knock-in barrier must not be above the coupon barrier.');
  }
  if (p.settlement === 'physical') {
    if (!use.knockIn) e.push('Physical delivery applies below a knock-in barrier: this payoff has none.');
    for (const u of unds)
      if (!deliverableToken(p, u.symbol))
        e.push(
          `There is no ${u.symbol} token to deliver on ${NOTE_CHAIN_LABELS[noteChainOf(p)]} (${deliverableList(p)}): settle in cash (stock notes are cash-settled), or pick another underlying.`,
        );
  }
  if (use.protection) {
    if (!(Number(p.protectionPct) > 0 && Number(p.protectionPct) <= 100))
      e.push('Protection must be between 0 and 100% of face.');
    if (!(Number(p.participationPct) >= 0)) e.push('Participation must be zero or positive.');
  }
  const eco = economicsOf(p);
  if (eco.collateral.length > MAX_COLLATERAL) e.push(`At most ${MAX_COLLATERAL} collateral assets.`);
  if (new Set(eco.collateral.map((c) => c.symbol)).size !== eco.collateral.length)
    e.push('Each collateral asset can appear once.');
  for (const c of eco.collateral) {
    if (!COLLATERAL_SYMBOLS.includes(c.symbol))
      e.push(`'${c.symbol}' cannot be pledged: use ${COLLATERAL_SYMBOLS.join(', ')}.`);
    else if (!collateralTokenOf(p, c.symbol))
      e.push(
        p.collateralChain === 'robinhood' && noteChainOf(p) === HOME_CHAIN
          ? `${c.symbol} can't be locked on Robinhood Chain for an Arbitrum note: lock USD (USDG), TSLA, AMZN, AMD or PLTR there.`
          : `There is no ${c.symbol} token to pledge on ${NOTE_CHAIN_LABELS[noteChainOf(p)]}: pledge ${collateralChoices(
              p,
            )
              .filter((x) => x.token)
              .map((x) => `${x.symbol}${x.token !== x.symbol ? ` (${x.token})` : ''}`)
              .join(
                ', ',
              )}${noteChainOf(p) === HOME_CHAIN ? ', or lock TSLA, AMZN, AMD or PLTR on Robinhood Chain (collateral held there)' : ''}.`,
      );
    if (!(c.haircutPct >= 0 && c.haircutPct <= 100))
      e.push(`${c.symbol} collateral: the haircut must be between 0 and 100% (the share of market value counted).`);
  }
  if (!(eco.collateralRatioPct >= 0 && eco.collateralRatioPct <= 1000))
    e.push('The collateral ratio must be between 0 and 1,000% of the outstanding notional.');
  if (!(eco.settlementLagDays >= 0 && eco.settlementLagDays <= 30))
    e.push('The settlement lag must be between 0 and 30 days.');
  if (p.collateralChain !== undefined && !['note', 'robinhood'].includes(p.collateralChain))
    e.push("Collateral must be held on the note's chain or on Robinhood Chain.");
  if (p.chain !== undefined && !NOTE_CHAINS.includes(p.chain))
    e.push(`The note's chain must be one of ${NOTE_CHAINS.join(', ')}.`);
  if (p.collateralChain === 'robinhood' && noteChainOf(p) !== HOME_CHAIN)
    e.push("A note on Robinhood Chain holds its collateral there already: choose the note's chain.");
  if (p.payouts !== undefined && !PAYOUT_METHODS.includes(p.payouts))
    e.push(`Payouts must be one of ${PAYOUT_METHODS.join(', ')}.`);
  if (!DEFAULT_RULES.includes(eco.defaultRule)) e.push(`The default rule must be one of ${DEFAULT_RULES.join(', ')}.`);
  if (!(eco.gracePeriodDays >= 0 && eco.gracePeriodDays <= MAX_GRACE_DAYS))
    e.push(`The grace period must be between 0 and ${MAX_GRACE_DAYS} days.`);
  // The engine holds 8 assets per note: the note, the stablecoin, deliverable tokens and collateral together.
  const nAssets = 2 + (p.settlement === 'physical' ? unds.length : 0) + eco.collateral.length;
  if (nAssets > 8)
    e.push(
      `This note would hold ${nAssets} assets; the engine holds 8 (note, stablecoin, ${p.settlement === 'physical' ? 'one deliverable token per underlying, ' : ''}and the collateral assets). Pledge fewer collateral assets.`,
    );
  return e;
}

/** Most a period can call for per unit of face, excluding the final redemption (for the funding schedule). */
export function maxCouponPerUnit(p: ProductParams, k: number): number {
  const r = (p.couponRatePct ?? 0) / 100;
  if (p.productType === 'phoenix') return p.memory ? r * k : r;
  if (p.productType === 'fcn' || p.productType === 'reverse-convertible') return r;
  return 0;
}

/**
 * The cash leg: USDG (Global Dollar, issued by Paxos; the dollar Robinhood uses), 6 decimals, on both testnets
 * (CASH_TOKENS has the addresses). Paxos runs its faucet; notes.markets cannot mint it. tUSD, our retired test
 * dollar, is known only to label notes issued before USDG, which still settle in it (TEST_CASH_TOKEN).
 */
export const CASH_TOKEN = { token: 'USDG', decimals: 6 };
export const TEST_CASH_TOKEN = { token: 'tUSD', decimals: 6 };

/**
 * USDG on each testnet (https://docs.paxos.com/guides/stablecoin/usdg/testnet), checked on 2026-10-24: symbol USDG,
 * 6 decimals, non-zero supply; on an Arbitrum Sepolia fork transfer and transferFrom delivered in full (no fee on
 * transfer). It is an upgradeable proxy whose admin roles can pause transfers and freeze or wipe an address
 * (pause(), freeze(), wipeFrozenAddress() exist behind AccessControl): see docs/SECURITY.md.
 */
export const CASH_TOKENS: Record<string, `0x${string}`> = {
  'arbitrum-sepolia': CHAIN_TOKENS['arbitrum-sepolia'].USDG.address,
  'robinhood-testnet': CHAIN_TOKENS['robinhood-testnet'].USDG.address,
};
export const CASH_FAUCET = 'https://faucet.paxos.com';

/** Every real token's address by symbol per chain (the app merges these with the deployment's config). */
export const EXTERNAL_TOKENS: Record<string, Record<string, `0x${string}`>> = Object.fromEntries(
  NOTE_CHAINS.map((c) => [c, Object.fromEntries(Object.values(CHAIN_TOKENS[c]).map((t) => [t.token, t.address]))]),
);

/** Where to get each chain's testnet tokens (plain links: notes.markets mints nothing). */
export const FAUCETS = {
  /** USDG on both chains. */
  usdg: CASH_FAUCET,
  /** Robinhood Chain testnet: ETH for gas and the stock tokens. */
  robinhood: 'https://faucet.testnet.chain.robinhood.com',
  /** Arbitrum Sepolia ETH for gas. */
  arbitrumSepolia: ['https://faucets.chain.link/arbitrum-sepolia', 'https://www.alchemy.com/faucets/arbitrum-sepolia'],
} as const;
/** Where to get each chain's own stock tokens. */
export const STOCK_TOKEN_FAUCETS: Record<string, string> = { 'robinhood-testnet': FAUCETS.robinhood };

/** The tokens a note can deliver on its chain, for messages ("WETH for ETH, …"). */
function deliverableList(p: Pick<ProductParams, 'chain'>): string {
  const list = (Object.keys(FEEDS) as string[])
    .map((s) => [s, deliverableToken(p, s)?.token] as const)
    .filter(([, t]) => t);
  return list.length
    ? `deliverable: ${list.map(([s, t]) => (s === t ? s : `${s} as ${t}`)).join(', ')}`
    : 'none deliverable';
}

/**
 * Chainlink price feeds (8 decimals) the CRE workflow reads: each asset's fixing comes from its native chain's oracle.
 * Crypto: Ethereum mainnet (ETH/USD and BTC/USD update at least hourly, SOL/USD at least daily).
 * US equities: Robinhood Chain mainnet (CRE chain 'robinhood-mainnet'), Robinhood's own stock feeds. They follow
 * market hours with a 24 h heartbeat, so they do not move from Friday's close to Monday's open: the staleness
 * allowance is 4 days, which spans a weekend. Checked on 2026-10-24 with eth_call on https://rpc.mainnet.chain.robinhood.com:
 * description ("RHTSLA / USD", "Robinhood AMZN / USD"…), 8 decimals, latestRoundData updated within the last day.
 * There is no NFLX feed there. Notes issued before keep the feeds compiled into their definitions (equities on
 * Arbitrum One, CRE 'ethereum-mainnet-arbitrum-1').
 */
type FeedSymbol =
  | 'ETH'
  | 'BTC'
  | 'SOL'
  | 'TSLA'
  | 'AMZN'
  | 'AMD'
  | 'PLTR'
  | 'NVDA'
  | 'AAPL'
  | 'SPY'
  | 'META'
  | 'MSFT'
  | 'GOOGL'
  | 'COIN';
const equity = (symbol: FeedSymbol, feed: string): Underlying => ({
  symbol,
  feed,
  feedChain: 'robinhood-mainnet',
  minPrice: 1,
  maxPrice: 100_000,
  staleness: 345_600,
});
export const FEEDS: Record<FeedSymbol, Underlying> = {
  ETH: {
    symbol: 'ETH',
    feed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    feedChain: 'ethereum-mainnet',
    minPrice: 1,
    maxPrice: 1_000_000,
    staleness: 3600,
  },
  BTC: {
    symbol: 'BTC',
    feed: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    feedChain: 'ethereum-mainnet',
    minPrice: 1,
    maxPrice: 10_000_000,
    staleness: 3600,
  },
  SOL: {
    symbol: 'SOL',
    feed: '0x4ffC43a60e009B551865A93d232E33Fce9f01507',
    feedChain: 'ethereum-mainnet',
    minPrice: 0.01,
    maxPrice: 100_000,
    staleness: 86400,
  },
  TSLA: equity('TSLA', '0x4A1166a659A55625345e9515b32adECea5547C38'),
  AMZN: equity('AMZN', '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C'),
  AMD: equity('AMD', '0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72'),
  PLTR: equity('PLTR', '0x820ABedFF239034956B7A9d2F0a331f9F075eB4c'),
  NVDA: equity('NVDA', '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15'),
  AAPL: equity('AAPL', '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0'),
  SPY: equity('SPY', '0x319724394D3A0e3669269846abE664Cd621f9f6A'),
  META: equity('META', '0x7C38C00C30BEe9378381E7B6135d7283356D71b1'),
  MSFT: equity('MSFT', '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E'),
  GOOGL: equity('GOOGL', '0xF6f373a037c30F0e5010d854385cA89185AE638b'),
  COIN: equity('COIN', '0xA3a468A452940B7D6b69991207B508c609a98Ef2'),
};

const base = { issuePricePct: 100, underlyings: [FEEDS.ETH], observations: 4 };

/** A worst-of basket: the phoenix on the worst of ETH, BTC and SOL. */
export const EXAMPLE_WORST_OF: ProductParams = {
  ...base,
  productType: 'phoenix',
  name: '12M Worst-of Phoenix on ETH, BTC, SOL',
  underlyings: [FEEDS.ETH, FEEDS.BTC, FEEDS.SOL],
  couponRatePct: 3,
  couponBarrierPct: 70,
  memory: true,
  autocallLevelPct: 100,
  autocallFromPeriod: 2,
  knockInBarrierPct: 60,
};

/** One worked example per product (quarterly over a year on ETH/USD). */
export const EXAMPLE_PRODUCTS: Record<ProductType, ProductParams> = {
  fcn: {
    ...base,
    productType: 'fcn',
    name: '12M Fixed Coupon Note on ETH',
    couponRatePct: 2,
    autocallLevelPct: 100,
    knockInBarrierPct: 60,
  },
  'reverse-convertible': {
    ...base,
    productType: 'reverse-convertible',
    name: '12M Reverse Convertible on ETH',
    couponRatePct: 2.5,
    knockInBarrierPct: 70,
  },
  phoenix: {
    ...base,
    productType: 'phoenix',
    name: '12M Phoenix (memory) on ETH',
    couponRatePct: 2.5,
    couponBarrierPct: 70,
    memory: true,
    autocallLevelPct: 100,
    autocallFromPeriod: 2,
    knockInBarrierPct: 60,
  },
  snowball: {
    ...base,
    productType: 'snowball',
    name: '12M Snowball on ETH',
    couponRatePct: 2.25,
    autocallLevelPct: 100,
    knockInBarrierPct: 65,
  },
  ppn: {
    ...base,
    productType: 'ppn',
    name: '12M 100% Protected Note on ETH',
    observations: 1,
    protectionPct: 100,
    participationPct: 50,
  },
};

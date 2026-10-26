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

import { ASSET_CLASSES } from './feed-directory';
import { FEED_CATALOGUE, type CatalogueFeed, type CatalogueSymbol } from './feeds-catalogue';

export type { AssetClass, CatalogueChain } from './feed-directory';
export { ASSET_CLASSES } from './feed-directory';
export { FEED_CATALOGUE, type CatalogueFeed, type CatalogueSymbol } from './feeds-catalogue';

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
 * Robinhood Chain's WETH, TSLA, AMZN, AMD and PLTR as Robinhood's stock tokens), all on Robinhood Chain, the note's own
 * chain (CHAIN_TOKENS). BTC is synthetic for now: an underlying, cash-settled, never pledged.
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
   * The chain the note is issued on: Robinhood Chain testnet (HOME_CHAIN), the only one. It decides which real tokens
   * a physically settled note delivers and which the issuer can pledge (CHAIN_TOKENS): token symbols and decimals are
   * compiled into the definition. Any other value is refused (validateTermSheet).
   */
  chain?: NoteChain;
  /**
   * Where the collateral is held. Absent or 'note' (today, the only choice): the tokens are pledged into the note on
   * Robinhood Chain. Planned (docs/CROSS-CHAIN.md): a key of REMOTE_COLLATERAL, collateral locked in a vault on another
   * chain and pledged as receipts that Chainlink CCIP mints on Robinhood Chain. None is configured yet.
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

/**
 * Where a note's collateral is held: 'note' (the note's own chain, Robinhood Chain) or, once cross-chain collateral is
 * deployed, a key of REMOTE_COLLATERAL (docs/CROSS-CHAIN.md). Any other value is refused.
 */
export type CollateralChain = 'note' | (string & {});

/**
 * The chain notes run on: Robinhood Chain testnet (chain id 46630). Issuance, subscriptions, coupons, redemption, the
 * note tokens, the escrow and Chainlink CRE's reports are all there, and so is the collateral (USDG, WETH and
 * Robinhood's stock tokens). A term sheet naming any other chain is refused.
 */
export type NoteChain = 'robinhood-testnet';
export const HOME_CHAIN: NoteChain = 'robinhood-testnet';
/** Every chain a term sheet may name: Robinhood Chain testnet only. */
export const NOTE_CHAINS: readonly NoteChain[] = [HOME_CHAIN];
/** Where new notes are issued (the same single chain). */
export const ISSUANCE_CHAINS: readonly NoteChain[] = NOTE_CHAINS;
/**
 * A term sheet that names a chain notes do not run on (e.g. one saved by the earlier Arbitrum build): it reads, and
 * toIssuanceTerms moves it to Robinhood Chain, but it cannot be issued as it is.
 */
export const isLegacyChainTerms = (p: Pick<ProductParams, 'chain'> | null | undefined) =>
  p?.chain !== undefined && !(NOTE_CHAINS as readonly string[]).includes(p.chain);
export const NOTE_CHAIN_LABELS: Record<NoteChain, string> = {
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
 * The real tokens on Robinhood Chain testnet; notes.markets mints none of them. Checked on-chain on 2026-10-24 with
 * eth_call (symbol, name, decimals, supply; WETH's deposit() simulated with value; no transaction sent):
 *  - USDG: Paxos's Global Dollar testnet deployment (docs.paxos.com/guides/stablecoin/usdg/testnet), 6 decimals.
 *  - WETH: the chain's own token-bridge WETH (aeWETH proxy; l1Address() = Sepolia WETH, the gateway router's WETH
 *    gateway 0x5A8F…E413 maps Sepolia WETH to it). The other "Wrapped ETH" there (0x33e4…0B94, a plain WETH9) is not
 *    the bridge's.
 *  - No wrapped BTC: Robinhood Chain testnet has only user-deployed mocks. BTC is synthetic: an underlying priced by
 *    Chainlink BTC/USD, settled in cash.
 *  - TSLA, AMZN, AMD, PLTR, NFLX: Robinhood's testnet stock tokens (18 decimals; one deployer, BeaconProxy). TSLA,
 *    AMZN, AMD and PLTR are priced by Robinhood Chain mainnet's Chainlink feeds (FEEDS); NFLX has no feed CRE reads,
 *    so it is held and shown, never pledged or delivered.
 */
export const CHAIN_TOKENS: Record<NoteChain, Record<string, ChainToken>> = {
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
 * Planned (docs/CROSS-CHAIN.md): collateral held on other chains, by collateralChain key. The tokens would stay in a
 * RemoteVault there and the note would hold receipts that Chainlink CCIP mints on Robinhood Chain (the home chain),
 * e.g. `{ ethereum: { USD: { token: 'USDC.eth', decimals: 6 } } }`. Empty: no remote collateral is deployed, so every
 * note pledges on Robinhood Chain.
 */
export const REMOTE_COLLATERAL: Record<
  string,
  Partial<Record<CollateralSymbol, { token: string; decimals: number }>>
> = {};
/** Whether the terms hold their collateral on another chain (a REMOTE_COLLATERAL key), not in the note itself. */
export const isRemoteCollateral = (p: Pick<ProductParams, 'collateralChain'> | null | undefined) =>
  !!p?.collateralChain && p.collateralChain !== 'note';

/**
 * notes.markets' own test tokens, retired 2026-10-24: never offered, priced or listed. tUSD alone stays known
 * (TEST_CASH_TOKEN), only to label a note that settles in it.
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
 * The token an underlying is delivered in on the note's chain: the real token there priced as it (WETH for ETH;
 * Robinhood's TSLA, AMZN, AMD and PLTR). Undefined when there is none (BTC, SOL, NVDA, AAPL…): such a note settles
 * in cash.
 */
export function deliverableToken(
  p: Pick<ProductParams, 'chain'>,
  symbol: string,
): { token: string; decimals: number } | undefined {
  if (symbol === 'USD') return undefined;
  const local = chainTokenFor(noteChainOf(p), symbol);
  return local ? { token: local.token, decimals: local.decimals } : undefined;
}

/** The token behind a collateral asset (USD: the stablecoin) for this note: on its chain, or a remote receipt. */
export function collateralTokenOf(
  p: Pick<ProductParams, 'chain' | 'collateralChain'>,
  c: CollateralSymbol,
): { token: string; decimals: number } | undefined {
  const chain = noteChainOf(p);
  if (isRemoteCollateral(p)) return REMOTE_COLLATERAL[p.collateralChain!]?.[c];
  if (c === 'USD') return CASH_TOKEN;
  const local = chainTokenFor(chain, c);
  return local ? { token: local.token, decimals: local.decimals } : undefined;
}

/** What each collateral symbol is pledged as (Robinhood Chain's own tokens, or a remote chain's receipts), for pickers. */
export const collateralChoices = (p: Pick<ProductParams, 'chain' | 'collateralChain'>) =>
  COLLATERAL_SYMBOLS.map((symbol) => ({ symbol, token: collateralTokenOf(p, symbol)?.token ?? null }));

/**
 * The collateral symbol behind a definition's collateral asset name ("Collateral WETH" -> ETH, "Collateral TSLA.rh"
 * -> TSLA, "Collateral USDG" -> USD), including the names older notes used ("Collateral tETH", "Collateral tUSD").
 */
export function collateralSymbolOfAsset(assetName: string): string | null {
  const m = /^Collateral (\S+)$/.exec(assetName);
  if (!m) return null;
  const t = m[1].replace(/\.[a-z]+$/, '');
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
 * between notes.markets' test tokens ('test') and Robinhood's stock tokens ('robinhood'): dropped, every note runs on
 * Robinhood Chain with its real tokens. Read any of them.
 */
export function normalizeParams(p: ProductParams & { underlying?: Underlying; stockTokens?: unknown }): ProductParams {
  let q: ProductParams & { underlying?: Underlying } = p;
  if ('stockTokens' in p) {
    const { stockTokens, ...rest } = p;
    void stockTokens;
    q = rest;
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
 * Whether a term sheet can be issued now: its terms hold together on Robinhood Chain (validateTermSheet), with every
 * token it delivers or pledges real there.
 */
export function validateProductParams(p: ProductParams): string[] {
  return validateTermSheet(p);
}

/**
 * A term sheet moved to where notes are issued, for a form that opens an old one (e.g. saved by the earlier Arbitrum
 * build, with a chain or collateral chain that no longer applies): the note goes on Robinhood Chain, an undeliverable
 * underlying settles in cash, and collateral held elsewhere is pledged on Robinhood Chain instead (assets with no
 * token there dropped). Terms already issuable come back unchanged (the same object).
 */
export function toIssuanceTerms(p: ProductParams): ProductParams {
  const undeliverable =
    p.settlement === 'physical' && (p.underlyings ?? []).some((u) => !deliverableToken({}, u.symbol));
  const remote = isRemoteCollateral(p) && !REMOTE_COLLATERAL[p.collateralChain!];
  if (!isLegacyChainTerms(p) && !undeliverable && !remote) return p;
  const { chain: _legacy, collateralChain: _held, ...rest } = p;
  const q: ProductParams = {
    ...rest,
    ...(undeliverable ? { settlement: 'cash' as const } : {}),
    ...(remote || !p.collateralChain ? {} : { collateralChain: p.collateralChain }),
  };
  const col = economicsOf(p).collateral;
  if (col.some((c) => !collateralTokenOf(q, c.symbol))) {
    const local = col.filter((c) => !!collateralTokenOf(q, c.symbol));
    return { ...q, collateral: local.length ? local : DEFAULT_COLLATERAL };
  }
  return q;
}

/** Whether a term sheet's terms hold together on Robinhood Chain: the check behind validateProductParams. */
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
    if (!(u.minPrice >= 0 && u.maxPrice > u.minPrice && Number.isFinite(u.maxPrice)))
      e.push(`${u.symbol}: price bounds need 0 <= min < max.`);
    else if (![u.minPrice, u.maxPrice].every((x) => /^\d+(\.\d{1,10})?$/.test(String(x))))
      e.push(`${u.symbol}: price bounds must be plain decimals with at most 10 decimal places.`);
    if (!(Number.isInteger(u.staleness) && u.staleness! > 0))
      e.push(`${u.symbol}: set how old a Chainlink round may be (staleness, whole seconds).`);
    if (!FEED_CHAIN_LABELS[u.feedChain])
      e.push(
        `${u.symbol}: the keeper reads prices on ${Object.keys(FEED_CHAIN_LABELS).join(', ')}, not '${u.feedChain}'.`,
      );
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
          `There is no ${u.symbol} token to deliver on ${NOTE_CHAIN_LABELS[noteChainOf(p)]} (${deliverableList(p)}): settle in cash, or pick another underlying.`,
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
        isRemoteCollateral(p)
          ? `${c.symbol} can't be held on ${p.collateralChain} for this note.`
          : `There is no ${c.symbol} token to pledge on ${NOTE_CHAIN_LABELS[noteChainOf(p)]}: pledge ${collateralChoices(
              p,
            )
              .filter((x) => x.token)
              .map((x) => `${x.symbol}${x.token !== x.symbol ? ` (${x.token})` : ''}`)
              .join(', ')}.`,
      );
    if (!(c.haircutPct >= 0 && c.haircutPct <= 100))
      e.push(`${c.symbol} collateral: the haircut must be between 0 and 100% (the share of market value counted).`);
  }
  if (!(eco.collateralRatioPct >= 0 && eco.collateralRatioPct <= 1000))
    e.push('The collateral ratio must be between 0 and 1,000% of the outstanding notional.');
  if (!(eco.settlementLagDays >= 0 && eco.settlementLagDays <= 30))
    e.push('The settlement lag must be between 0 and 30 days.');
  if (isRemoteCollateral(p) && !REMOTE_COLLATERAL[p.collateralChain!])
    e.push(
      `Collateral on other chains (${p.collateralChain}) is not available yet: pledge it into the note on ${NOTE_CHAIN_LABELS[HOME_CHAIN]}.`,
    );
  if (isLegacyChainTerms(p))
    e.push(`Notes run on ${NOTE_CHAIN_LABELS[HOME_CHAIN]} only: '${p.chain}' is not a note chain.`);
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
 * The cash leg: USDG (Global Dollar, issued by Paxos; the dollar Robinhood uses), 6 decimals, on Robinhood Chain
 * testnet (CASH_TOKENS has the address). Paxos runs its faucet; notes.markets cannot mint it. tUSD, our retired test
 * dollar, is known only to label a note that settles in it (TEST_CASH_TOKEN).
 */
export const CASH_TOKEN = { token: 'USDG', decimals: 6 };
export const TEST_CASH_TOKEN = { token: 'tUSD', decimals: 6 };

/**
 * USDG on Robinhood Chain testnet (https://docs.paxos.com/guides/stablecoin/usdg/testnet), checked on 2026-10-24:
 * symbol USDG, 6 decimals, non-zero supply; transfer and transferFrom deliver in full (no fee on transfer). It is an upgradeable proxy whose admin roles can pause transfers and freeze or wipe an address
 * (pause(), freeze(), wipeFrozenAddress() exist behind AccessControl): see docs/SECURITY.md.
 */
export const CASH_TOKENS: Record<string, `0x${string}`> = {
  'robinhood-testnet': CHAIN_TOKENS['robinhood-testnet'].USDG.address,
};
export const CASH_FAUCET = 'https://faucet.paxos.com';

/** Every real token's address by symbol per chain (the app merges these with the deployment's config). */
export const EXTERNAL_TOKENS: Record<string, Record<string, `0x${string}`>> = Object.fromEntries(
  NOTE_CHAINS.map((c) => [c, Object.fromEntries(Object.values(CHAIN_TOKENS[c]).map((t) => [t.token, t.address]))]),
);

/** Where to get Robinhood Chain testnet tokens (plain links: notes.markets mints nothing). */
export const FAUCETS = {
  /** USDG (Paxos). */
  usdg: CASH_FAUCET,
  /** Robinhood Chain testnet: ETH for gas and the stock tokens. */
  robinhood: 'https://faucet.testnet.chain.robinhood.com',
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
 * Every Chainlink price a note can be fixed on, by symbol: the generated catalogue (feeds-catalogue.ts,
 * scripts/feeds-catalogue.ts; rules in docs/UNDERLYINGS.md) as Underlyings. Stocks, crypto, forex and commodities,
 * each from its native oracle: US equities from Robinhood Chain mainnet (CRE chain 'robinhood-mainnet', read over CRE's
 * HTTP capability), crypto, forex and commodities from Ethereum mainnet, the rest from Arbitrum One (CRE EVM reads).
 * Equity, forex and commodity feeds follow market hours, so their staleness allowance spans a weekend.
 *
 * An Underlying carries only what the engine and the keeper read (feed, chain, bounds, staleness): a definition
 * compiled from one stays the same whatever else the catalogue learns. FEEDS.TSLA, FEEDS.ETH… keep the exact values
 * notes used before the catalogue. Being an underlying is not being collateral: COLLATERAL_SYMBOLS is a separate
 * whitelist of the tokens a note can actually lock.
 */
export const FEEDS = Object.fromEntries(
  FEED_CATALOGUE.map((f) => [
    f.symbol,
    {
      symbol: f.symbol,
      feed: f.feed,
      feedChain: f.feedChain,
      minPrice: f.minPrice,
      maxPrice: f.maxPrice,
      staleness: f.staleness,
    } satisfies Underlying,
  ]),
) as Record<CatalogueSymbol, Underlying>;

/** The catalogue entry for a symbol (class, name, source), if it has one. */
const CATALOGUE_BY_SYMBOL = new Map(FEED_CATALOGUE.map((f) => [f.symbol as string, f]));
export const catalogueFeed = (symbol: string): CatalogueFeed | undefined => CATALOGUE_BY_SYMBOL.get(symbol);
/** Whether `symbol` has a Chainlink feed in the catalogue. */
export const isCatalogueSymbol = (symbol: string): symbol is CatalogueSymbol => CATALOGUE_BY_SYMBOL.has(symbol);

/** The underlyings shown first in pickers: the ones notes are most often written on. */
export const POPULAR_UNDERLYINGS: readonly CatalogueSymbol[] = [
  'ETH',
  'BTC',
  'SOL',
  'TSLA',
  'NVDA',
  'AAPL',
  'AMZN',
  'SPY',
  'EUR',
  'XAU',
];

/**
 * The catalogue by class, for prompts and messages: "Stocks: AAPL, AMD, …; Crypto: …". `max` caps the symbols listed
 * per class (the rest summarised as "and N more").
 */
export function catalogueSummary(max = Infinity): string {
  return ASSET_CLASSES.map((c) => {
    const all = FEED_CATALOGUE.filter((f) => f.assetClass === c).map((f) => f.symbol);
    const syms = [
      ...POPULAR_UNDERLYINGS.filter((s) => all.includes(s)),
      ...all.filter((s) => !POPULAR_UNDERLYINGS.includes(s)),
    ];
    const shown = syms.slice(0, max);
    return `${c}: ${shown.join(', ')}${syms.length > shown.length ? ` and ${syms.length - shown.length} more` : ''}`;
  }).join('; ');
}

/** Where a feed chain's prices come from, for labels ("Chainlink · Robinhood Chain"). */
export const FEED_CHAIN_LABELS: Record<string, string> = {
  'ethereum-mainnet': 'Ethereum',
  'ethereum-mainnet-arbitrum-1': 'Arbitrum One',
  'robinhood-mainnet': 'Robinhood Chain',
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

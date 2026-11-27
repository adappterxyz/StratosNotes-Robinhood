/**
 * ProductParams: the typed term sheet of a structured product (Flow's
 * products/params.ts, for Solana). A product is instantiated into a BPMN
 * workflow from these parameters, never authored free-hand, so every issued
 * note runs one of a small set of tested payoff engines.
 *
 * Units: one note unit has a face value of 1 unit of the cash token (USDG on Robinhood Chain, USDC on Base).
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

import {
  B20_STOCKS,
  B20_SYMBOLS,
  b20MultiplierFeed,
  b20PriceFeed,
  BASE_MAINNET_FEED_CHAIN,
  BASE_SEPOLIA_FEED_CHAIN,
  BASE_SEPOLIA_STOCKS,
  isB20Symbol,
  isDeployedAddress,
  multiplierField,
  type B20Symbol,
  type FeedSpec,
} from './base-stocks';
import {
  BNB_TEST_CASH,
  BNB_TESTNET_DEPLOYMENT,
  BNB_TESTNET_FEED_CHAIN,
  BSTOCK_SYMBOLS,
  BSTOCKS,
  bstockMultiplierFeed,
  isBStockSymbol,
  type BStockSymbol,
} from './bnb-stocks';
import { ASSET_CLASSES } from './feed-directory';
import { BSC_MAINNET_FEED_CHAIN, FEED_REF, HISTORY_FEED_CHAINS, HTTP_FEED_CHAINS, isAtlasFeed } from '../feed-rpc';
import { SECOND_SOURCE_TOLERANCE_BPS, SECOND_SOURCE_TOLERANCE_CLOSED_BPS } from '../cmc';
import { DISRUPTION_MAX_POSTPONEMENTS } from '../keeper';
import { isRhStockTicker, refMultiplierField, rhMultiplierFeed } from './robinhood-tokens';
import {
  FEED_CATALOGUE as CHAINLINK_CATALOGUE,
  type CatalogueFeed as ChainlinkFeed,
  type CatalogueSymbol as ChainlinkSymbol,
} from './feeds-catalogue';
import { ATLAS_CATALOGUE, type AtlasSymbol } from './atlas-feeds';

export type { AssetClass, CatalogueChain } from './feed-directory';
export { ASSET_CLASSES } from './feed-directory';
export * from './atlas-feeds';

/** Every symbol a note can be fixed on: Chainlink's catalogue and the Atlas-priced stock tokens. */
export type CatalogueSymbol = ChainlinkSymbol | AtlasSymbol;
/** One price a note can be fixed on: a Chainlink feed of the generated catalogue, or an Atlas feed (atlas-feeds.ts). */
export type CatalogueFeed = Omit<ChainlinkFeed, 'symbol' | 'feedChain' | 'feed'> & {
  symbol: CatalogueSymbol;
  /** An AggregatorV3 proxy, or a keyed Atlas Multi-Feed reference (feed-rpc.ts FEED_REF). */
  feed: string;
  feedChain: string;
};
/**
 * Every price a note can be fixed on: the Atlas-priced stock tokens of BNB Chain first, then Chainlink's catalogue
 * (generated: feeds-catalogue.ts).
 */
export const FEED_CATALOGUE: readonly CatalogueFeed[] = [...ATLAS_CATALOGUE, ...CHAINLINK_CATALOGUE];

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
 * WETH, TSLA, AMZN, AMD and PLTR as Robinhood's stock tokens), on the note's own chain (CHAIN_TOKENS) or locked on the
 * other note chain (REMOTE_COLLATERAL). BTC is synthetic for now: an underlying, cash-settled, never pledged.
 *
 * The symbol is the VALUATION KEY: which feed prices one token. Robinhood's stock tokens are priced as the share (TSLA,
 * share-price feed). Coinbase's B20 stocks on Base (TSLAc, NVDAc…: notes.markets' stand-ins on Base Sepolia,
 * docs/BASE-STOCKS.md) have keys of their own, valued with Chainlink's per-token feeds (share price x multiplier):
 * never TSLA, which would price them as shares. Binance's bStocks on BNB Chain (TSLAB, NVDAB…: stand-ins on BNB Chain
 * testnet, docs/BNB-CHAIN.md) also have keys of their own, valued as the share's feed x the token's multiplier.
 */
export type CollateralSymbol = 'USD' | 'ETH' | 'TSLA' | 'AMZN' | 'AMD' | 'PLTR' | B20Symbol | BStockSymbol;
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
  /**
   * Fixing window, minutes (absent or 0: the latest Chainlink round). Every price the note reads (start price,
   * observations, collateral prices) is then the time-weighted median of its feed over that long before the
   * reading, so a wick shorter than half the window cannot set a fixing (FIXING_WINDOWS, keeper.ts
   * timeWeightedMedian). Only for feeds whose history the keeper can read (canWindowFeed).
   */
  fixingWindowMin?: number;
  /**
   * 'close': a closing-price note. Its start and check dates are set at the US market close (16:00 New York,
   * usCloseOnOrAfter) and each price is the median over the fixing window ending at that time. US stocks only; needs
   * a fixing window. The dates themselves are set at issuance (Approve Terms).
   */
  fixingAt?: 'close';
  /**
   * Disruption limit, % (absent or 0: none; DISRUPTION_LIMITS). Needs a fixing window. When a price moved more than
   * this between its low and its high inside the window, the fixing is postponed by one window, at most
   * DISRUPTION_MAX_POSTPONEMENTS times, then taken regardless (keeper.ts stepFixing).
   */
  disruptionPct?: number;
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
   * The chain the note is issued on: absent for Robinhood Chain testnet (HOME_CHAIN), 'base-sepolia' for Base
   * Sepolia. It decides the cash token (USDG or USDC, CHAIN_CASH), which real tokens a physically settled note
   * delivers and which the issuer can pledge (CHAIN_TOKENS): token symbols and decimals are compiled into the
   * definition. Any other value is refused (validateTermSheet).
   */
  chain?: NoteChain;
  /**
   * Where the collateral is held. Absent or 'note': the tokens are pledged into the note on its own chain. The other
   * note chain's key (docs/CROSS-CHAIN.md): the issuer locks the tokens in the vault there and pledges the receipts
   * Chainlink CCIP mints on the note's chain (REMOTE_COLLATERAL), e.g. a Base note backed by TSLA locked on Robinhood
   * Chain (TSLA.rh).
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
 * Where a note's collateral is held: 'note' (absent: pledged into the note on its own chain) or the key of another note
 * chain whose vault holds it (docs/CROSS-CHAIN.md), e.g. 'robinhood-testnet' for a Base Sepolia note backed by
 * Robinhood's stock tokens locked on Robinhood Chain. Only the pairs in REMOTE_COLLATERAL are accepted.
 */
export type CollateralChain = 'note' | (string & {});

/**
 * The chains notes run on (each a "home": issuance, subscriptions, coupons, redemption, the note tokens, the escrow
 * and Chainlink CRE's reports all happen there):
 *  - Robinhood Chain testnet (chain id 46630), cash USDG (Paxos), collateral USDG, WETH and Robinhood's stock tokens;
 *  - Base Sepolia (chain id 84532), cash USDC (Circle), collateral USDC, WETH and the B20 stock stand-ins (TSLAc…);
 *  - BNB Chain testnet (chain id 97), cash nmUSD (notes.markets' test dollar: BNB testnet has no stablecoin with a
 *    public faucet), collateral nmUSD and the bStocks stand-ins (TSLAB…).
 * A term sheet with no `chain` is a Robinhood Chain note (HOME_CHAIN, the first note chain): its definition stays as
 * it was before Base was added. A term sheet naming any other chain is refused.
 */
export type NoteChain = 'robinhood-testnet' | 'base-sepolia' | 'bnb-testnet';
export const HOME_CHAIN: NoteChain = 'robinhood-testnet';
export const BASE_CHAIN: NoteChain = 'base-sepolia';
export const BNB_CHAIN: NoteChain = 'bnb-testnet';
/** Every chain a term sheet may name. */
export const NOTE_CHAINS: readonly NoteChain[] = [HOME_CHAIN, BASE_CHAIN, BNB_CHAIN];
/** Where new notes are issued: all of them (a chain is offered once the served config lists its engine). */
export const ISSUANCE_CHAINS: readonly NoteChain[] = NOTE_CHAINS;
export const isNoteChain = (c: string | null | undefined): c is NoteChain =>
  !!c && (NOTE_CHAINS as readonly string[]).includes(c);
/**
 * A term sheet that names a chain notes do not run on (e.g. one saved by the earlier Arbitrum build): it reads, and
 * toIssuanceTerms moves it to Robinhood Chain, but it cannot be issued as it is.
 */
export const isLegacyChainTerms = (p: Pick<ProductParams, 'chain'> | null | undefined) =>
  p?.chain !== undefined && !isNoteChain(p.chain);
export const NOTE_CHAIN_LABELS: Record<NoteChain, string> = {
  'robinhood-testnet': 'Robinhood Chain testnet',
  'base-sepolia': 'Base Sepolia',
  'bnb-testnet': 'BNB Chain testnet',
};
/** Short names, for chips and sentences ("locked on Robinhood Chain"). */
export const NOTE_CHAIN_SHORT: Record<NoteChain, string> = {
  'robinhood-testnet': 'Robinhood Chain',
  'base-sepolia': 'Base',
  'bnb-testnet': 'BNB Chain',
};
/** "A", "A and B", "A, B and C". */
export const joinList = (xs: readonly string[], word: 'and' | 'or') =>
  xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`;
/** A chain key's label (a note chain's name, else the key itself). */
export const chainLabel = (key: string) => (isNoteChain(key) ? NOTE_CHAIN_LABELS[key] : key);
/** EVM chain ids. */
export const NOTE_CHAIN_IDS: Record<NoteChain, number> = {
  'robinhood-testnet': 46630,
  'base-sepolia': 84532,
  'bnb-testnet': 97,
};
/** The note's chain: its terms' `chain`, else the home chain. */
export const noteChainOf = (p: Pick<ProductParams, 'chain'> | null | undefined): NoteChain =>
  isNoteChain(p?.chain) ? p.chain : HOME_CHAIN;
/**
 * The terms as written for `chain`: Robinhood Chain notes leave `chain` out (so their definitions stay byte for byte
 * as before), any other chain names it.
 */
export const withChain = <T extends Pick<ProductParams, 'chain'>>(p: T, chain: NoteChain): T => {
  const { chain: _old, ...rest } = p;
  void _old;
  return (chain === HOME_CHAIN ? rest : { ...rest, chain }) as T;
};

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
  /**
   * A B20 stock (Coinbase's standard; on Base Sepolia notes.markets' stand-in): the share underlying it delivers
   * (`delivers`, e.g. TSLA) at shares / multiplier token units, the B20MultiplierFeed the note reads the multiplier
   * from, and the real Coinbase token on Base mainnet. Absent for every other token.
   */
  b20?: { delivers: string; multiplierFeed: `0x${string}`; standIn: boolean; mainnetToken: `0x${string}` };
  /**
   * A bStock (Binance's; on BNB Chain testnet notes.markets' stand-in): the same fields as `b20`. Valued as the share
   * (`delivers`) x its multiplier, delivered at shares / multiplier token units.
   */
  bstock?: { delivers: string; multiplierFeed: `0x${string}`; standIn: boolean; mainnetToken: `0x${string}` };
}

/** The multiplier feed of a token paid at shares / multiplier (a B20 stock or a bStock), if it is one. */
export const multiplierFeedOf = (t: Pick<ChainToken, 'b20' | 'bstock'> | null | undefined) =>
  t?.b20?.multiplierFeed ?? t?.bstock?.multiplierFeed;

/** Whether a token's contract exists (not the NOT_DEPLOYED placeholder of a stand-in still to deploy). */
export const isDeployedToken = (t: Pick<ChainToken, 'address'> | null | undefined) => isDeployedAddress(t?.address);

/**
 * The real tokens on each note chain; notes.markets mints none of them.
 *
 * Robinhood Chain testnet, checked on-chain on 2026-10-24 (again 2026-11-06) with eth_call (symbol, name, decimals,
 * supply; WETH's deposit() simulated with value; no transaction sent):
 *  - USDG: Paxos's Global Dollar testnet deployment (docs.paxos.com/guides/stablecoin/usdg/testnet), 6 decimals.
 *  - WETH: the chain's own token-bridge WETH (aeWETH proxy; l1Address() = Sepolia WETH, the gateway router's WETH
 *    gateway 0x5A8F…E413 maps Sepolia WETH to it). The other "Wrapped ETH" there (0x33e4…0B94, a plain WETH9) is not
 *    the bridge's.
 *  - No wrapped BTC: Robinhood Chain testnet has only user-deployed mocks. BTC is synthetic: an underlying priced by
 *    Chainlink BTC/USD, settled in cash.
 *  - TSLA, AMZN, AMD, PLTR, NFLX: Robinhood's testnet stock tokens (18 decimals; one deployer, BeaconProxy). TSLA,
 *    AMZN, AMD and PLTR are priced by Robinhood Chain mainnet's Chainlink feeds (FEEDS); NFLX has no feed CRE reads,
 *    so it is held and shown, never pledged or delivered.
 *
 * Base Sepolia, checked 2026-11-06 (eth_call symbol/decimals; addresses from the issuers' docs):
 *  - USDC: Circle's testnet USDC (developers.circle.com/stablecoins/usdc-contract-addresses), 6 decimals; Circle's
 *    faucet (faucet.circle.com) gives it. Circle can pause it and blacklist an address (FiatToken), like USDG.
 *  - WETH: the OP Stack WETH9 predeploy 0x4200…0006 (deposit() wraps ETH), 18 decimals.
 *  - TSLAc, AMZNc, NVDAc, AAPLc, MSFTc, METAc: notes.markets' TEST STAND-INS for Coinbase's B20 stock tokens, which
 *    exist on Base mainnet only (docs/BASE-STOCKS.md, base-stocks.ts). 8 decimals and the real token's multiplier,
 *    like the real ones; valued with Chainlink's per-token feeds on Base mainnet (keys TSLAc…, not TSLA); a TSLA, AMZN,
 *    NVDA, AAPL, MSFT or META underlying is delivered in them (shares / multiplier). Their addresses are
 *    BASE_SEPOLIA_STOCKS: the NOT_DEPLOYED placeholder until scripts/deploy-base-stocks.sh runs, and a token not
 *    deployed is never served, offered or wired (isDeployedToken). These are notes.markets' own test tokens, minted by
 *    a public rate-limited faucet; they are not Coinbase's and have no value.
 *  Robinhood's stock tokens do not exist on Base: a Base note gets them as collateral by locking them on Robinhood
 *  Chain (REMOTE_COLLATERAL, TSLA.rh…). The other way round, a Robinhood Chain note can lock the Base stand-ins on Base
 *  (TSLAc.base…).
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
  'base-sepolia': {
    USDC: {
      token: 'USDC',
      decimals: 6,
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      name: 'USD Coin',
      issuer: 'Circle',
      valuedAs: 'USD',
    },
    WETH: {
      token: 'WETH',
      decimals: 18,
      address: '0x4200000000000000000000000000000000000006',
      name: 'Wrapped Ether',
      issuer: 'OP Stack predeploy (WETH9)',
      valuedAs: 'ETH',
    },
    ...b20StandIns(),
  },
  'bnb-testnet': {
    nmUSD: {
      token: BNB_TEST_CASH.token,
      decimals: BNB_TEST_CASH.decimals,
      address: BNB_TESTNET_DEPLOYMENT.cash,
      name: `${BNB_TEST_CASH.name} (test, no value)`,
      issuer: 'notes.markets (test token)',
      valuedAs: 'USD',
    },
    ...bstockStandIns(),
  },
};

/** The BNB Chain testnet stand-ins for Binance's bStocks (addresses: BNB_TESTNET_DEPLOYMENT). */
function bstockStandIns(): Record<string, ChainToken> {
  return Object.fromEntries(
    BSTOCK_SYMBOLS.map((s) => {
      const b = BSTOCKS[s];
      const d = BNB_TESTNET_DEPLOYMENT.tokens[s];
      return [
        s,
        {
          token: s,
          decimals: b.decimals,
          address: d.token,
          name: `${b.name} (test stand-in for Binance ${s})`,
          issuer: 'notes.markets (test stand-in)',
          valuedAs: s,
          bstock: { delivers: b.ticker, multiplierFeed: d.multiplierFeed, standIn: true, mainnetToken: b.mainnetToken },
        } satisfies ChainToken,
      ];
    }),
  );
}

/** The Base Sepolia stand-ins for Coinbase's B20 stocks (addresses: BASE_SEPOLIA_STOCKS). */
function b20StandIns(): Record<string, ChainToken> {
  return Object.fromEntries(
    B20_SYMBOLS.map((s) => {
      const b = B20_STOCKS[s];
      const d = BASE_SEPOLIA_STOCKS.tokens[s];
      return [
        s,
        {
          token: s,
          decimals: b.decimals,
          address: d.token,
          name: `${b.name} (test stand-in for Coinbase ${s})`,
          issuer: 'notes.markets (test stand-in)',
          valuedAs: s,
          b20: { delivers: b.ticker, multiplierFeed: d.multiplierFeed, standIn: true, mainnetToken: b.mainnetToken },
        } satisfies ChainToken,
      ];
    }),
  );
}

/** Robinhood's stock tokens with no Chainlink feed CRE can read: shown as held, never offered as collateral or delivery. */
export const UNPRICED_STOCKS = Object.values(CHAIN_TOKENS['robinhood-testnet'])
  .filter((t) => t.valuedAs === null)
  .map((t) => t.token);

/** The real local token valued as `sym` on `chain` (USD: the stablecoin), if any. */
export function chainTokenFor(chain: NoteChain, sym: string): ChainToken | undefined {
  return Object.values(CHAIN_TOKENS[chain] ?? {}).find((t) => t.valuedAs === sym);
}

/**
 * The local token a physically settled note delivers for underlying `sym` on `chain`: the token valued as it (WETH
 * for ETH, Robinhood's TSLA on Robinhood Chain), else a B20 stock that represents the share (TSLAc on Base Sepolia,
 * paid at shares / multiplier).
 */
export function deliveryTokenFor(chain: NoteChain, sym: string): ChainToken | undefined {
  return (
    chainTokenFor(chain, sym) ??
    Object.values(CHAIN_TOKENS[chain] ?? {}).find((t) => (t.b20 ?? t.bstock)?.delivers === sym)
  );
}

/**
 * The suffix of a receipt for a token locked on each chain: TSLA locked on Robinhood Chain backs a Base note as
 * `TSLA.rh`; USDC locked on Base backs a Robinhood Chain note as `USDC.base`.
 */
export const RECEIPT_SUFFIX: Record<NoteChain, string> = {
  'robinhood-testnet': 'rh',
  'base-sepolia': 'base',
  'bnb-testnet': 'bnb',
};

/** A receipt the home gateway mints for a token locked in the vault on another chain. */
export interface RemoteToken {
  /** The receipt's symbol on the home chain (e.g. TSLA.rh). */
  token: string;
  decimals: number;
  /** The locked token on the asset chain. */
  locked: ChainToken;
}

/**
 * The tokens a vault on `asset` accepts as collateral for notes on `home`: every token there that has a Chainlink
 * price the keeper reads (valuedAs), in COLLATERAL_SYMBOLS. NFLX (no feed) is left out. The receipt keeps the token's
 * valuation key: TSLA.rh is priced as the TSLA share (Robinhood's tokens are), TSLAc.base as the TSLAc token (Coinbase's
 * per-token feed). A stand-in not deployed yet is listed here (its symbol and key are fixed) but never wired
 * (wirePlan skips it) and never issuable (validateProductParams).
 */
function lockable(home: NoteChain, asset: NoteChain): Partial<Record<CollateralSymbol, RemoteToken>> {
  const out: Partial<Record<CollateralSymbol, RemoteToken>> = {};
  if (home === asset) return out;
  for (const t of Object.values(CHAIN_TOKENS[asset])) {
    if (!t.valuedAs) continue;
    out[t.valuedAs] = { token: `${t.token}.${RECEIPT_SUFFIX[asset]}`, decimals: t.decimals, locked: t };
  }
  return out;
}

/**
 * Collateral held on another chain (docs/CROSS-CHAIN.md), by the note's chain (home) and then the chain that holds
 * it (the term sheet's collateralChain). The token stays in a RemoteVault there; the note holds receipts that
 * Chainlink CCIP mints on the home chain, valued with the token's own Chainlink feed and the haircut the issuer sets
 * (DEFAULT_HAIRCUT, the same as the token pledged locally). Both directions:
 *  - a Robinhood Chain note, collateral on Base: USDC.base, WETH.base and the B20 stock stand-ins TSLAc.base,
 *    AMZNc.base, NVDAc.base, AAPLc.base, MSFTc.base, METAc.base (valued per token, docs/BASE-STOCKS.md);
 *  - a Base note, collateral on Robinhood Chain: USDG.rh, WETH.rh and Robinhood's stock tokens TSLA.rh, AMZN.rh,
 *    AMD.rh, PLTR.rh.
 * A pair is usable once its gateway and vault are deployed and the served config lists the receipts (the app checks
 * the chain's `tokens`; the issue step refuses a receipt with no address).
 */
export const REMOTE_COLLATERAL: Record<
  NoteChain,
  Record<string, Partial<Record<CollateralSymbol, RemoteToken>>>
> = Object.fromEntries(
  NOTE_CHAINS.map((home) => [
    home,
    Object.fromEntries(NOTE_CHAINS.filter((a) => a !== home).map((asset) => [asset, lockable(home, asset)])),
  ]),
) as Record<NoteChain, Record<string, Partial<Record<CollateralSymbol, RemoteToken>>>>;
/** Whether the terms hold their collateral on another chain, not in the note itself. */
export const isRemoteCollateral = (p: Pick<ProductParams, 'collateralChain'> | null | undefined) =>
  !!p?.collateralChain && p.collateralChain !== 'note';
/** The receipts a note's terms pledge, when they hold collateral on another chain this note chain accepts. */
export const remoteCollateralOf = (
  p: Pick<ProductParams, 'chain' | 'collateralChain'> | null | undefined,
): Partial<Record<CollateralSymbol, RemoteToken>> | undefined =>
  isRemoteCollateral(p) ? REMOTE_COLLATERAL[noteChainOf(p)]?.[p!.collateralChain!] : undefined;
/** The chains a note on `chain` may hold its collateral on, other than itself. */
export const remoteCollateralChains = (chain: NoteChain): NoteChain[] =>
  Object.keys(REMOTE_COLLATERAL[chain] ?? {}).filter(isNoteChain);
/**
 * Every receipt symbol a gateway may mint, with where its token is locked (for labels and the template check). The
 * same receipt (TSLAc.base) can back notes on several home chains, each gateway minting its own: `homes` lists them.
 */
export const RECEIPTS: Record<
  string,
  { homes: NoteChain[]; asset: NoteChain; symbol: CollateralSymbol; locked: ChainToken }
> = {};
for (const home of NOTE_CHAINS)
  for (const [asset, m] of Object.entries(REMOTE_COLLATERAL[home]))
    for (const [symbol, r] of Object.entries(m)) {
      const known = RECEIPTS[r!.token];
      if (known) known.homes.push(home);
      else
        RECEIPTS[r!.token] = {
          homes: [home],
          asset: asset as NoteChain,
          symbol: symbol as CollateralSymbol,
          locked: r!.locked,
        };
    }
/** "TSLA.rh" -> the chain it is locked on (robinhood-testnet), from its suffix; null for a plain token. */
export function receiptChain(token: string): NoteChain | null {
  const m = /\.([a-z]+)$/.exec(token);
  if (!m) return null;
  return (Object.entries(RECEIPT_SUFFIX).find(([, s]) => s === m[1])?.[0] as NoteChain | undefined) ?? null;
}

/**
 * notes.markets' own test tokens, retired 2026-10-24: never offered, priced or listed. tUSD alone stays known
 * (TEST_CASH_TOKEN), only to label a note that settles in it.
 */
export const RETIRED_TEST_TOKENS: readonly string[] = ['tETH', 'tBTC', 'tSOL', 'tTSLA', 'tNVDA', 'tAAPL', 'tSPY'];
export const isRetiredTestToken = (sym: string) => RETIRED_TEST_TOKENS.includes(sym.replace(/\.[a-z]+$/, ''));

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
  // Coinbase's B20 stocks (stand-ins on Base Sepolia): the same haircut as Robinhood's stock tokens.
  TSLAc: 60,
  AMZNc: 60,
  NVDAc: 60,
  AAPLc: 60,
  MSFTc: 60,
  METAc: 60,
  // Binance's bStocks (stand-ins on BNB Chain testnet): the same.
  TSLAB: 60,
  NVDAB: 60,
  AAPLB: 60,
  MSFTB: 60,
  AMZNB: 60,
  GOOGLB: 60,
  METAB: 60,
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
 * both chains; Robinhood's TSLA, AMZN, AMD and PLTR on Robinhood Chain), or on Base Sepolia the B20 stock stand-in for
 * the share (TSLAc for TSLA, also AMZN, NVDA, AAPL, MSFT, META: `multiplier` set, delivered at shares / multiplier,
 * the multiplier read into `multiplier.field` at the final observation from `multiplier.feed`). Undefined when there
 * is none (BTC, SOL, AMD on Base…): such a note settles in cash.
 */
export function deliverableToken(
  p: Pick<ProductParams, 'chain'>,
  symbol: string,
):
  | {
      token: string;
      decimals: number;
      multiplier?: { field: string; feed: FeedSpec };
      /**
       * Set with `multiplier`: the multiplier of the token the underlying's PRICE is of (Robinhood's, whose feed
       * every stock underlying reads: share price x that multiplier). 1 / strike is a number of Robinhood tokens;
       * another issuer's token is delivered at 1 / strike x reference / multiplier (robinhood-tokens.ts).
       */
      reference?: { field: string; feed: FeedSpec };
    }
  | undefined {
  if (symbol === 'USD') return undefined;
  const chain = noteChainOf(p);
  const local = deliveryTokenFor(chain, symbol);
  if (!local) return undefined;
  // A token that IS the underlying (TSLAB for an Atlas-priced TSLAB note) is paid at 1 / strike: its price is per
  // token. Only a token that stands for a SHARE underlying (TSLAB or TSLAc for TSLA) is scaled by its multiplier.
  const feed =
    local.valuedAs === symbol
      ? null
      : local.b20 && isB20Symbol(local.token)
        ? b20MultiplierFeed(local.token)
        : local.bstock && isBStockSymbol(local.token)
          ? bstockMultiplierFeed(local.token)
          : null;
  return {
    token: local.token,
    decimals: local.decimals,
    ...(feed ? { multiplier: { field: multiplierField(symbol), feed } } : {}),
    ...(feed && isRhStockTicker(symbol)
      ? { reference: { field: refMultiplierField(symbol), feed: rhMultiplierFeed(symbol) } }
      : {}),
  };
}

/** The token behind a collateral asset (USD: the stablecoin) for this note: on its chain, or a remote receipt. */
export function collateralTokenOf(
  p: Pick<ProductParams, 'chain' | 'collateralChain'>,
  c: CollateralSymbol,
): { token: string; decimals: number } | undefined {
  const chain = noteChainOf(p);
  if (isRemoteCollateral(p)) {
    const r = remoteCollateralOf(p)?.[c];
    return r ? { token: r.token, decimals: r.decimals } : undefined;
  }
  if (c === 'USD') return cashTokenOf(chain);
  const local = chainTokenFor(chain, c);
  return local ? { token: local.token, decimals: local.decimals } : undefined;
}

/**
 * The Chainlink feed a priced collateral key is valued with: the catalogue's (ETH, and TSLA… as shares: Robinhood's
 * stock tokens are 1:1 shares) or, for a B20 stock (TSLAc…), Chainlink's per-token feed on Base mainnet (share price x
 * multiplier). Undefined for USD (no feed).
 */
export function collateralFeed(c: CollateralSymbol): FeedSpec | undefined {
  if (c === 'USD') return undefined;
  if (isB20Symbol(c)) return b20PriceFeed(c);
  return FEEDS[c];
}

/**
 * The multiplier a collateral key's price is scaled by: a bStock (TSLAB…) is worth its share's price (collateralFeed)
 * x its multiplier (its BStockMultiplierFeed). Undefined for every other key (priced by one feed).
 */
export function collateralMultiplierFeed(_c: CollateralSymbol): FeedSpec | undefined {
  return undefined;
}

/**
 * The multiplier a bStock's share feed must be divided by: collateralFeed is Chainlink's feed of ROBINHOOD's token
 * for that stock (share price x Robinhood's multiplier), so the share price is feed / Robinhood's multiplier and a
 * bStock is worth feed / this x its own multiplier. Undefined for every other key.
 */
export function collateralRefMultiplierFeed(c: CollateralSymbol): FeedSpec | undefined {
  void c;
  return undefined;
}

/**
 * Where a deliverable or collateral token of these terms is not deployed yet (a B20 stand-in before its deploy): the
 * token symbols, for issuance checks. Empty when everything exists.
 */
export function undeployedTokensOf(p: ProductParams): string[] {
  const chain = noteChainOf(p);
  const out = new Set<string>();
  if (p.settlement === 'physical')
    for (const u of p.underlyings ?? []) {
      const t = deliveryTokenFor(chain, u.symbol);
      if (t && (!isDeployedToken(t) || (multiplierFeedOf(t) && !isDeployedAddress(multiplierFeedOf(t)))))
        out.add(t.token);
    }
  for (const c of economicsOf(p).collateral) {
    if (c.symbol === 'USD') continue;
    const t = isRemoteCollateral(p) ? remoteCollateralOf(p)?.[c.symbol]?.locked : chainTokenFor(chain, c.symbol);
    if (t && (!isDeployedToken(t) || (t.bstock && !isDeployedAddress(t.bstock.multiplierFeed)))) out.add(t.token);
  }
  return [...out];
}

/**
 * What each collateral symbol is pledged as (the note chain's own tokens, or another chain's receipts), for pickers:
 * null where there is none, or its token is not deployed yet (a B20 stand-in before its deploy).
 */
export const collateralChoices = (p: Pick<ProductParams, 'chain' | 'collateralChain'>) =>
  COLLATERAL_SYMBOLS.map((symbol) => ({
    symbol,
    token: canPledgeNow(p, symbol) ? (collateralTokenOf(p, symbol)?.token ?? null) : null,
  }));

/** Whether `c` can be pledged on these terms now: it has a token there, and that token is deployed. */
export function canPledgeNow(p: Pick<ProductParams, 'chain' | 'collateralChain'>, c: CollateralSymbol): boolean {
  if (!collateralTokenOf(p, c)) return false;
  // USD too: the stablecoin is checked like any token (BNB Chain testnet's nmUSD exists only after its deploy).
  const t = isRemoteCollateral(p) ? remoteCollateralOf(p)?.[c]?.locked : chainTokenFor(noteChainOf(p), c);
  return !t || (isDeployedToken(t) && (!t.bstock || isDeployedAddress(t.bstock.multiplierFeed)));
}

/** Whether underlying `sym` can be delivered on these terms' chain now: a token exists there and is deployed. */
export function canDeliverNow(p: Pick<ProductParams, 'chain'>, sym: string): boolean {
  if (!deliverableToken(p, sym)) return false;
  const t = deliveryTokenFor(noteChainOf(p), sym);
  return !t || (isDeployedToken(t) && (!multiplierFeedOf(t) || isDeployedAddress(multiplierFeedOf(t))));
}

/**
 * The collateral symbol behind a definition's collateral asset name ("Collateral WETH" -> ETH, "Collateral TSLA.rh"
 * -> TSLA, "Collateral USDG" -> USD), including the names older notes used ("Collateral tETH", "Collateral tUSD").
 */
export function collateralSymbolOfAsset(assetName: string): string | null {
  const m = /^Collateral (\S+)$/.exec(assetName);
  if (!m) return null;
  const t = m[1].replace(/\.[a-z]+$/, '');
  if (['USD', 'USDG', 'USDC', 'tUSD', 'nmUSD'].includes(t)) return 'USD';
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

/**
 * Whether a term sheet can be issued now: its terms hold together on its chain (validateTermSheet), with every token
 * it delivers or pledges real there (or a receipt of a token locked on the other chain).
 */
export function validateProductParams(p: ProductParams): string[] {
  const e = validateTermSheet(p);
  const pending = undeployedTokensOf(p);
  if (pending.length)
    e.push(
      `${pending.join(', ')} ${pending.length > 1 ? 'are' : 'is'} not deployed yet (notes.markets' test token${pending.length > 1 ? 's' : ''}: docs/BASE-STOCKS.md, docs/BNB-CHAIN.md): pick another token for now.`,
    );
  return e;
}

/**
 * The terms rewritten for a note on `chain` (the issue form's network picker): an underlying with no token to deliver
 * there settles in cash, collateral held on a chain this one does not take (or on `chain` itself) is pledged into the
 * note instead, and collateral assets with no token on `chain` are dropped (the stablecoin when none is left).
 */
export function toChain(p: ProductParams, chain: NoteChain): ProductParams {
  let q: ProductParams = withChain(p, chain);
  if (isRemoteCollateral(q) && (q.collateralChain === chain || !remoteCollateralOf(q))) {
    const { collateralChain: _held, ...rest } = q;
    void _held;
    q = rest;
  }
  if (q.settlement === 'physical' && (q.underlyings ?? []).some((u) => !canDeliverNow(q, u.symbol)))
    q = { ...q, settlement: 'cash' };
  const col = economicsOf(p).collateral;
  if (col.some((c) => !canPledgeNow(q, c.symbol))) {
    const kept = col.filter((c) => canPledgeNow(q, c.symbol));
    q = { ...q, collateral: kept.length ? kept : DEFAULT_COLLATERAL };
  }
  return q;
}

/**
 * A term sheet moved to where notes are issued, for a form that opens an old one (e.g. saved by the earlier Arbitrum
 * build, with a chain or collateral chain that no longer applies): a chain notes do not run on becomes Robinhood
 * Chain, an undeliverable underlying settles in cash, and collateral held where the note's chain takes none is
 * pledged into the note instead (assets with no token there dropped). Terms already issuable come back unchanged
 * (the same object).
 */
export function toIssuanceTerms(p: ProductParams): ProductParams {
  const chain = isLegacyChainTerms(p) ? HOME_CHAIN : noteChainOf(p);
  const undeliverable =
    p.settlement === 'physical' && (p.underlyings ?? []).some((u) => !canDeliverNow({ chain }, u.symbol));
  const remote = isRemoteCollateral(p) && (p.collateralChain === chain || !remoteCollateralOf({ ...p, chain }));
  if (!isLegacyChainTerms(p) && !undeliverable && !remote) return p;
  return toChain(p, chain);
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
    if (!FEED_REF.test(u.feed || '')) e.push(`The ${u.symbol} price feed must be a feed address (0x…).`);
    if (!(u.minPrice >= 0 && u.maxPrice > u.minPrice && Number.isFinite(u.maxPrice)))
      e.push(`${u.symbol}: price bounds need 0 <= min < max.`);
    else if (![u.minPrice, u.maxPrice].every((x) => /^\d+(\.\d{1,10})?$/.test(String(x))))
      e.push(`${u.symbol}: price bounds must be plain decimals with at most 10 decimal places.`);
    if (!(Number.isInteger(u.staleness) && u.staleness! > 0))
      e.push(`${u.symbol}: set how old a price may be (staleness, whole seconds).`);
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
    else if (!collateralTokenOf(p, c.symbol) && !(isRemoteCollateral(p) && !remoteCollateralOf(p)))
      e.push(
        isRemoteCollateral(p)
          ? `${c.symbol} can't be locked on ${chainLabel(p.collateralChain!)} for a ${NOTE_CHAIN_SHORT[noteChainOf(p)]} note: lock ${Object.entries(
              remoteCollateralOf(p)!,
            )
              .map(([s, r]) => `${s}${s !== r!.locked.token ? ` (${r!.locked.token})` : ''}`)
              .join(', ')}.`
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
  if (p.fixingWindowMin) {
    if (!(FIXING_WINDOWS as readonly number[]).includes(p.fixingWindowMin))
      e.push(`The fixing window must be one of ${FIXING_WINDOWS.filter(Boolean).join(', ')} minutes, or none.`);
    const no = (p.underlyings ?? []).filter((u) => !canWindowFeed(u)).map((u) => u.symbol);
    if (no.length)
      e.push(`A fixing window needs the price history of every underlying: not available for ${joinList(no, 'and')}.`);
  }
  if (p.disruptionPct) {
    if (!(DISRUPTION_LIMITS as readonly number[]).includes(p.disruptionPct))
      e.push(`The disruption limit must be one of ${DISRUPTION_LIMITS.filter(Boolean).join(', ')}%, or none.`);
    if (!p.fixingWindowMin) e.push('The disruption rule needs a fixing window: choose a median first.');
  }
  if (p.fixingAt) {
    if (p.fixingAt !== 'close') e.push('The fixing time must be the market close, or left out.');
    if (!p.fixingWindowMin) e.push('A closing-price note needs a fixing window: the minutes before the close.');
    const no = (p.underlyings ?? []).filter((u) => !canCloseFeed(u)).map((u) => u.symbol);
    if (no.length)
      e.push(
        `A closing price is for US stocks only: ${joinList(no, 'and')} trade${no.length === 1 ? 's' : ''} without a close.`,
      );
  }
  if (isRemoteCollateral(p) && !remoteCollateralOf(p))
    e.push(
      p.collateralChain === noteChainOf(p)
        ? `This note runs on ${NOTE_CHAIN_LABELS[noteChainOf(p)]} already: pledge the collateral into the note (no lock needed).`
        : `A ${NOTE_CHAIN_SHORT[noteChainOf(p)]} note can't hold collateral on ${chainLabel(p.collateralChain!)}: pledge it into the note${
            remoteCollateralChains(noteChainOf(p)).length
              ? `, or lock it on ${joinList(
                  remoteCollateralChains(noteChainOf(p)).map((c) => NOTE_CHAIN_LABELS[c]),
                  'or',
                )}`
              : ''
          }.`,
    );
  if (isLegacyChainTerms(p))
    e.push(
      `Notes run on ${joinList(
        NOTE_CHAINS.map((c) => NOTE_CHAIN_LABELS[c]),
        'and',
      )} only: '${p.chain}' is not a note chain.`,
    );
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
 * The cash leg, per note chain: one note unit has a face value of one unit of it.
 *  - Robinhood Chain testnet: USDG (Global Dollar, issued by Paxos; the dollar Robinhood uses), 6 decimals. Checked
 *    on 2026-10-24 (docs.paxos.com/guides/stablecoin/usdg/testnet): non-zero supply; transfer and transferFrom deliver
 *    in full (no fee on transfer). An upgradeable proxy whose admin roles can pause transfers and freeze or wipe an
 *    address (pause(), freeze(), wipeFrozenAddress() behind AccessControl): see docs/SECURITY.md.
 *  - Base Sepolia: USDC (Circle), 6 decimals; Circle can pause it and blacklist an address (FiatToken).
 * The issuers run the faucets (CASH_FAUCETS); notes.markets cannot mint either. tUSD, our retired test dollar, is
 * known only to label a note that settles in it (TEST_CASH_TOKEN). CASH_TOKEN is Robinhood Chain's (USDG), for code
 * that has no chain in hand: prefer cashTokenOf.
 */
export const CHAIN_CASH: Record<NoteChain, { token: string; decimals: number }> = {
  'robinhood-testnet': { token: 'USDG', decimals: 6 },
  'base-sepolia': { token: 'USDC', decimals: 6 },
  'bnb-testnet': { token: BNB_TEST_CASH.token, decimals: BNB_TEST_CASH.decimals },
};
export const CASH_TOKEN = CHAIN_CASH[HOME_CHAIN];
export const TEST_CASH_TOKEN = { token: 'tUSD', decimals: 6 };
/** The cash token a note on `chain` (or with these terms) settles in. */
export const cashTokenOf = (chain: NoteChain | Pick<ProductParams, 'chain'> | null | undefined) =>
  CHAIN_CASH[typeof chain === 'string' ? chain : noteChainOf(chain)];

/** Each note chain's cash token address (a chain whose cash token is not deployed yet, BNB Chain testnet's nmUSD
 * before scripts/deploy-bnb.sh, is left out). */
export const CASH_TOKENS: Record<string, `0x${string}`> = Object.fromEntries(
  NOTE_CHAINS.map((c) => [c, CHAIN_TOKENS[c][CHAIN_CASH[c].token].address] as const).filter(([, a]) =>
    isDeployedAddress(a),
  ),
);
/** Paxos's USDG faucet (Robinhood Chain testnet). */
export const CASH_FAUCET = 'https://faucet.paxos.com';

/**
 * Every real token's address by symbol per chain (the app merges these with the deployment's config). Tokens not
 * deployed yet (a B20 stand-in before its deploy) are left out.
 */
export const EXTERNAL_TOKENS: Record<string, Record<string, `0x${string}`>> = Object.fromEntries(
  NOTE_CHAINS.map((c) => [
    c,
    Object.fromEntries(
      Object.values(CHAIN_TOKENS[c])
        .filter(isDeployedToken)
        .map((t) => [t.token, t.address]),
    ),
  ]),
);

/** Where to get testnet tokens (plain links: notes.markets mints nothing). */
export const FAUCETS = {
  /** USDG (Paxos), on Robinhood Chain testnet. */
  usdg: CASH_FAUCET,
  /** USDC (Circle), on Base Sepolia among others. */
  usdc: 'https://faucet.circle.com',
  /** Robinhood Chain testnet: ETH for gas and the stock tokens. */
  robinhood: 'https://faucet.testnet.chain.robinhood.com',
  /** Base Sepolia ETH for gas (Base lists more at docs.base.org, network faucets). */
  baseSepolia: ['https://faucets.chain.link/base-sepolia', 'https://www.alchemy.com/faucets/base-sepolia'],
  /** BNB Chain testnet tBNB for gas (needs 0.002 BNB on mainnet in the same wallet). */
  bnbTestnet: ['https://www.bnbchain.org/en/testnet-faucet'],
} as const;
/**
 * notes.markets' faucet on BNB Chain testnet (StockFaucet: the bStocks stand-ins and nmUSD, rate-limited), once
 * deployed; null before.
 */
export const BNB_FAUCET: `0x${string}` | null = isDeployedAddress(BNB_TESTNET_DEPLOYMENT.faucet)
  ? BNB_TESTNET_DEPLOYMENT.faucet
  : null;
const BNB_FAUCET_PAGE = BNB_FAUCET ? `https://testnet.bscscan.com/address/${BNB_FAUCET}#writeContract` : '';
/** Where to get each chain's cash token. */
export const CASH_FAUCETS: Record<NoteChain, string> = {
  'robinhood-testnet': FAUCETS.usdg,
  'base-sepolia': FAUCETS.usdc,
  'bnb-testnet': BNB_FAUCET_PAGE,
};
/** Where to get ETH for gas on each chain. */
export const GAS_FAUCETS: Record<NoteChain, readonly string[]> = {
  'robinhood-testnet': [FAUCETS.robinhood],
  'base-sepolia': FAUCETS.baseSepolia,
  'bnb-testnet': FAUCETS.bnbTestnet,
};
/**
 * The B20 stand-ins' faucet on Base Sepolia (B20StockFaucet: claim(token) or claimAll(), rate-limited; b20FaucetAbi),
 * once deployed; null before.
 */
export const BASE_STOCK_FAUCET: `0x${string}` | null = isDeployedAddress(BASE_SEPOLIA_STOCKS.faucet)
  ? BASE_SEPOLIA_STOCKS.faucet
  : null;
/**
 * Where to get each chain's own stock tokens: Robinhood's faucet on Robinhood Chain; on Base Sepolia, once deployed,
 * notes.markets' B20 stand-in faucet (its contract page: call claimAll, or claim(token)).
 */
export const STOCK_TOKEN_FAUCETS: Record<string, string> = {
  'robinhood-testnet': FAUCETS.robinhood,
  ...(BASE_STOCK_FAUCET
    ? { 'base-sepolia': `https://sepolia.basescan.org/address/${BASE_STOCK_FAUCET}#writeContract` }
    : {}),
  ...(BNB_FAUCET ? { 'bnb-testnet': BNB_FAUCET_PAGE } : {}),
};

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

/**
 * Where a feed chain's prices come from, for labels ("Chainlink · Robinhood Chain"). Base mainnet carries Chainlink's
 * per-token feeds of Coinbase's B20 stocks (collateral prices); Base Sepolia the stand-ins' multipliers (delivery).
 */
/** Who publishes a feed and where: "Atlas · BNB Chain", "Chainlink · Ethereum". */
export const feedSourceLabel = (f: { feed: string; feedChain: string }): string =>
  `${isAtlasFeed(f.feed) ? 'Atlas' : 'Chainlink'} · ${FEED_CHAIN_LABELS[f.feedChain] ?? f.feedChain}`;

export const FEED_CHAIN_LABELS: Record<string, string> = {
  'ethereum-mainnet': 'Ethereum',
  'ethereum-mainnet-arbitrum-1': 'Arbitrum One',
  'robinhood-mainnet': 'Robinhood Chain',
  [BSC_MAINNET_FEED_CHAIN]: 'BNB Chain',
  [BASE_MAINNET_FEED_CHAIN]: 'Base',
  [BASE_SEPOLIA_FEED_CHAIN]: 'Base Sepolia',
  [BNB_TESTNET_FEED_CHAIN]: 'BNB Chain testnet',
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

/** Fixing windows an issuer can choose, minutes (0: the latest round). */
export const FIXING_WINDOWS = [0, 15, 30, 60] as const;
/** Disruption limits an issuer can choose, % between the low and the high inside the fixing window (0: none). */
export const DISRUPTION_LIMITS = [0, 5, 10, 20] as const;
/**
 * Whether the keeper can read a feed's past rounds, which a fixing window needs: on the feed chains read over
 * JSON-RPC (HTTP_FEED_CHAINS: Robinhood Chain mainnet, i.e. every stock) and on Ethereum and Arbitrum
 * (HISTORY_FEED_CHAINS: crypto, forex, gold), where one request brings the rounds.
 */
export const canWindowFeed = (f: { feedChain: string }): boolean =>
  f.feedChain in HTTP_FEED_CHAINS || HISTORY_FEED_CHAINS.includes(f.feedChain);
/** Whether a feed has a market close to fix at: a US stock (every stock feed is on Robinhood Chain mainnet). */
export const canCloseFeed = (f: { feedChain: string }): boolean => f.feedChain in HTTP_FEED_CHAINS;

/**
 * The US market close (16:00 New York, unix seconds) on the first weekday at or after `tSec`. Follows New York's
 * daylight saving. Exchange holidays and half days are not skipped: the feed is the Robinhood token's 24/5 price,
 * so on a holiday it stands at the last close, and on a half day it is the token's price at 16:00.
 */
export function usCloseOnOrAfter(tSec: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const ny = (t: number) => {
    const o: Record<string, string> = {};
    for (const x of fmt.formatToParts(new Date(t * 1000))) o[x.type] = x.value;
    return { wd: o.weekday, secs: Number(o.hour) * 3600 + Number(o.minute) * 60 + Number(o.second) };
  };
  // Step to 16:00 New York of the day `t` is in (twice: a daylight-saving change in between moves it by an hour).
  const closeOfDay = (t: number) => {
    let c = t + (16 * 3600 - ny(t).secs);
    c += 16 * 3600 - ny(c).secs;
    return c;
  };
  let c = closeOfDay(tSec);
  for (let i = 0; i < 8 && (c < tSec || ny(c).wd === 'Sat' || ny(c).wd === 'Sun'); i++) c = closeOfDay(c + 86_400);
  return c;
}

/** The fixing rule of these terms in plain words, or '' for the latest price. */
export const fixingRuleText = (
  p: Pick<ProductParams, 'fixingWindowMin' | 'fixingAt' | 'disruptionPct'> & { underlyings?: Underlying[] },
): string => {
  const unds = p.underlyings ?? [];
  const atlas = unds.filter((u) => isAtlasFeed(u.feed));
  // Stock tokens: Atlas's on-chain price, confirmed by CoinMarketCap; CoinMarketCap's history for a window.
  const allAtlas = atlas.length > 0 && atlas.length === unds.length;
  const second = atlas.length
    ? `${
        allAtlas
          ? 'A'
          : `For ${joinList(
              atlas.map((u) => u.symbol),
              'and',
            )}, a`
      } price is written only when Atlas (on BNB Chain) and CoinMarketCap agree within ${SECOND_SOURCE_TOLERANCE_BPS / 100}% (${SECOND_SOURCE_TOLERANCE_CLOSED_BPS / 100}% while the US stock market is closed); otherwise the check waits.`
    : '';
  if (!p.fixingWindowMin)
    return atlas.length
      ? `${
          allAtlas
            ? 'Each price'
            : `The price of ${joinList(
                atlas.map((u) => u.symbol),
                'and',
              )}`
        } is Atlas's price of the token itself, published on BNB Chain around the clock. ${second}`
      : '';
  const source = allAtlas
    ? "CoinMarketCap's five-minute prices"
    : atlas.length
      ? "the price history (the Chainlink feed, or CoinMarketCap's five-minute prices for stock tokens)"
      : 'the Chainlink feed';
  const base =
    p.fixingAt === 'close'
      ? `Each price is taken at the US market close (16:00 New York): the time-weighted median of ${source} over the ${p.fixingWindowMin} minutes before it, so a brief spike or dip does not set it.`
      : `Each price is the time-weighted median of ${source} over the ${p.fixingWindowMin} minutes before the check, so a brief spike or dip does not set it.`;
  const rule = p.disruptionPct
    ? `${base} If a price moved more than ${p.disruptionPct}% between its low and its high in those minutes, the check is postponed by ${p.fixingWindowMin} minutes, at most ${DISRUPTION_MAX_POSTPONEMENTS === 2 ? 'twice' : `${DISRUPTION_MAX_POSTPONEMENTS} times`}, then taken regardless.`
    : base;
  return second ? `${rule} ${second}` : rule;
};

/**
 * What a reader of these terms should know about the stock tokens in them (docs/CORPORATE-ACTIONS.md), in plain
 * words: shown on the note's page, in the issue flow and on the support page. Empty when no stock is involved.
 *  - 'bstock': a bStock pledged (here or locked on BNB Chain) is valued at Atlas's price of the token.
 *  - 'delivery': the note delivers another issuer's token than the one its price is of.
 *  - 'price': the underlying is a stock, i.e. Chainlink's price of Robinhood's token (splits and dividends in it).
 */
export function stockTokenNotes(p: ProductParams): Array<{ key: 'bstock' | 'delivery' | 'price'; text: string }> {
  const out: Array<{ key: 'bstock' | 'delivery' | 'price'; text: string }> = [];
  const stocks = p.underlyings.filter((u) => isRhStockTicker(u.symbol));
  if (economicsOf(p).collateral.some((c) => isBStockSymbol(c.symbol)))
    out.push({
      key: 'bstock',
      text: "bStock collateral is valued at Atlas's price of the token itself (its own markets, around the clock), not at the stock's exchange price. The two can differ, mostly when the US market is closed.",
    });
  if (p.settlement === 'physical') {
    const tokens = stocks.flatMap((u) => {
      const d = deliverableToken(p, u.symbol);
      return d?.reference ? [d.token] : [];
    });
    if (tokens.length)
      out.push({
        key: 'delivery',
        text: `If the note ends in the stock, it is paid in ${joinList(tokens, 'or')}. The number of tokens is set at the final check so you receive the shares owed: a split or a reinvested dividend changes how many shares a token stands for, never what you are owed.`,
      });
  }
  if (stocks.length)
    out.push({
      key: 'price',
      text: `Stock prices are Chainlink's prices of Robinhood's stock tokens: the share price with splits and reinvested dividends already in it, so a split does not move the note's lines. A check waits while a split or dividend is being applied.`,
    });
  return out;
}

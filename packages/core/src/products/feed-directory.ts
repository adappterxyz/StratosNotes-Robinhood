/**
 * The rules that turn Chainlink's reference data directory (https://reference-data-directory.vercel.app/feeds-<network>.json)
 * into the underlyings catalogue (feeds-catalogue.ts): which feeds a note may be fixed on, which one per symbol, its
 * staleness allowance and its price bounds. Pure (no I/O): scripts/feeds-catalogue.ts downloads the directories, reads
 * every selected feed once (latestRoundData) and writes the catalogue; the tests run the same rules on fixtures.
 * docs/UNDERLYINGS.md explains the rules.
 */

/** A row of the directory, the fields these rules read. */
export interface DirectoryEntry {
  name: string;
  proxyAddress: string | null;
  path?: string;
  ens?: string | null;
  heartbeat?: number;
  decimals: number;
  feedCategory?: string;
  feedType?: string;
  contractType?: string;
  assetName?: string;
  docs?: {
    assetClass?: string;
    assetSubClass?: string;
    assetName?: string;
    baseAsset?: string;
    quoteAsset?: string;
    marketHours?: string;
    productType?: string;
    deliveryChannelCode?: string;
    shutdownDate?: string;
    hidden?: boolean;
    [k: string]: unknown;
  };
}

export type AssetClass = 'Stocks' | 'Crypto' | 'Forex' | 'Commodities';
export const ASSET_CLASSES: readonly AssetClass[] = ['Stocks', 'Crypto', 'Forex', 'Commodities'];

/** The directory networks a fixing can come from, by directory name, and their CRE chain-selector names. */
export const DIRECTORY_NETWORKS = {
  mainnet: 'ethereum-mainnet',
  'ethereum-mainnet-arbitrum-1': 'ethereum-mainnet-arbitrum-1',
  'robinhood-mainnet': 'robinhood-mainnet',
} as const;
export type DirectoryNetwork = keyof typeof DIRECTORY_NETWORKS;
export type CatalogueChain = (typeof DIRECTORY_NETWORKS)[DirectoryNetwork];

/**
 * Where each class is fixed from, first choice first. Equities: Robinhood Chain mainnet (the native oracle for
 * Robinhood's stock tokens, read over CRE's HTTP capability), then Arbitrum One. Crypto, forex and commodities:
 * Ethereum mainnet first (CRE EVM read).
 */
export const SOURCE_PRIORITY: Record<AssetClass, readonly CatalogueChain[]> = {
  Stocks: ['robinhood-mainnet', 'ethereum-mainnet-arbitrum-1', 'ethereum-mainnet'],
  Crypto: ['ethereum-mainnet', 'ethereum-mainnet-arbitrum-1', 'robinhood-mainnet'],
  Forex: ['ethereum-mainnet', 'ethereum-mainnet-arbitrum-1', 'robinhood-mainnet'],
  Commodities: ['ethereum-mainnet', 'ethereum-mainnet-arbitrum-1', 'robinhood-mainnet'],
};

/** Chainlink's market-risk categories a feed may have. 'custom' is allowed only for ALLOW_CUSTOM. */
export const ALLOWED_RISK = ['low', 'medium'] as const;

/** Classes that trade in market hours: their feeds stop at the weekend, so staleness spans one. */
export const WEEKEND_ALLOWANCE_SEC = 259_200;

/** A feed that passed the filter, before the live read. */
export interface Candidate {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  feed: `0x${string}`;
  feedChain: CatalogueChain;
  decimals: number;
  heartbeat: number;
  /** Chainlink's market-risk category ('custom' only where ALLOW_CUSTOM allows it). */
  risk: string;
  marketHours: string;
  /** The directory's path (one per feed on a network), for the record. */
  path: string;
}

export interface Exclusion {
  network: DirectoryNetwork;
  name: string;
  reason: string;
}

/** Tickers notes accept (validateTermSheet): a capital letter, then capitals and digits, at most 10. */
export const TICKER = /^[A-Z][A-Z0-9]{0,9}$/;

const ROBINHOOD_EQUITY = /^Robinhood ([A-Z0-9.]+)\s*(?:\/|-)\s*USD$/;
const PLAIN_PAIR = /^([A-Za-z0-9.]+)\s*\/\s*([A-Za-z0-9.]+)$/;

/**
 * 'custom' risk is Chainlink's label for feeds outside its standard methodology. The one family allowed: Robinhood
 * Chain mainnet's own "Robinhood <TICKER> / USD" equity feeds, the native oracle for Robinhood's stock tokens (the
 * equities notes already used).
 */
export function allowCustom(network: DirectoryNetwork, e: DirectoryEntry): boolean {
  return network === 'robinhood-mainnet' && ROBINHOOD_EQUITY.test(e.name) && e.docs?.assetClass === 'Equity';
}

/** The base symbol and quote of a feed's name, or null when it is not a plain "X / Y" pair. */
export function pairOf(network: DirectoryNetwork, name: string): { base: string; quote: string } | null {
  const rh = ROBINHOOD_EQUITY.exec(name);
  if (network === 'robinhood-mainnet' && rh) return { base: rh[1], quote: 'USD' };
  const m = PLAIN_PAIR.exec(name.trim());
  return m ? { base: m[1], quote: m[2] } : null;
}

/** The catalogue class of a directory entry, or null when it is none of them. */
export function classOf(network: DirectoryNetwork, e: DirectoryEntry): AssetClass | null {
  const c = (e.docs?.assetClass ?? '').toLowerCase();
  if (c === 'equity' || c === 'equities' || c === 'etf') return 'Stocks';
  if (c === 'fiat' || c === 'forex') return 'Forex';
  if (c === 'commodity' || c === 'commodities') return 'Commodities';
  if (c === 'crypto') return 'Crypto';
  if (
    network === 'robinhood-mainnet' &&
    /^us_equities/.test(e.docs?.marketHours ?? '') &&
    ROBINHOOD_EQUITY.test(e.name)
  )
    return 'Stocks';
  return null;
}

/** Why an entry is not a standard USD price feed a note can be fixed on, or null when it is. */
export function exclusionReason(network: DirectoryNetwork, e: DirectoryEntry): string | null {
  const name = e.name ?? '';
  const d = e.docs ?? {};
  if (!e.proxyAddress || !/^0x[0-9a-fA-F]{40}$/.test(e.proxyAddress) || e.contractType === 'verifier')
    return 'no AggregatorV3 proxy (Data Streams)';
  if (/datalink|streams|refprice/i.test(name) || d.deliveryChannelCode === 'DS') return 'Data Streams / DataLink';
  if (d.shutdownDate || e.feedCategory === 'deprecating') return 'deprecated';
  if (d.hidden) return 'hidden in the directory';
  const product = String(d.productType ?? '').toLowerCase();
  if (/proof of reserve|reserves/i.test(`${product} ${name}`)) return 'proof of reserve';
  if (/exchange rate/i.test(name) || /exchange_rate/.test(String(d.attributeType ?? ''))) return 'exchange rate';
  if (
    /nav/i.test(product) ||
    /\bnav\b/i.test(name) ||
    /fund|treasur|fixed income|private credit/i.test(d.assetClass ?? '')
  )
    return 'NAV / fund';
  if (/macro|index/i.test(`${product} ${d.assetClass ?? ''} ${e.feedType ?? ''}`)) return 'macro / index';
  if (product && product !== 'price') return `not a price feed (${d.productType})`;
  const cls = classOf(network, e);
  if (!cls) return `asset class ${d.assetClass ?? 'unknown'}`;
  const pair = pairOf(network, name);
  if (!pair) return 'not a plain X / USD pair';
  if (pair.quote.toUpperCase() !== 'USD') return `quoted in ${pair.quote}, not USD`;
  const risk = e.feedCategory ?? '';
  if (!(ALLOWED_RISK as readonly string[]).includes(risk) && !(risk === 'custom' && allowCustom(network, e)))
    return `risk category '${risk || 'none'}'`;
  if (cls === 'Crypto') {
    if (/stablecoin|pegged/i.test(d.assetSubClass ?? '')) return `crypto ${d.assetSubClass}`;
    if (/USD/i.test(pair.base)) return 'a dollar stablecoin';
  }
  if (!TICKER.test(pair.base.toUpperCase())) return `'${pair.base}' is not a ticker notes accept`;
  if (!(e.heartbeat && e.heartbeat > 0)) return 'no heartbeat';
  return null;
}

/** Of two feeds for the same symbol on one network, the canonical one: listed, plain path, 8 decimals, faster. */
function rankOnNetwork(symbol: string, e: DirectoryEntry): number[] {
  const path = e.path ?? '';
  return [
    path === `${symbol.toLowerCase()}-usd` ? 0 : 1,
    /svr|backup/.test(path) ? 1 : 0,
    e.decimals === 8 ? 0 : 1,
    e.heartbeat ?? Infinity,
  ];
}
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** Every entry that passes the filter, one per symbol per network, and every exclusion with its reason. */
export function filterDirectory(
  network: DirectoryNetwork,
  entries: DirectoryEntry[],
): { kept: Candidate[]; excluded: Exclusion[] } {
  const excluded: Exclusion[] = [];
  const best = new Map<string, DirectoryEntry>();
  for (const e of entries) {
    const why = exclusionReason(network, e);
    if (why) {
      excluded.push({ network, name: e.name, reason: why });
      continue;
    }
    const sym = pairOf(network, e.name)!.base.toUpperCase();
    const prev = best.get(sym);
    if (!prev || cmp(rankOnNetwork(sym, e), rankOnNetwork(sym, prev)) < 0) {
      if (prev) excluded.push({ network, name: `${prev.name} (${prev.path})`, reason: 'duplicate on the network' });
      best.set(sym, e);
    } else excluded.push({ network, name: `${e.name} (${e.path})`, reason: 'duplicate on the network' });
  }
  const chain = DIRECTORY_NETWORKS[network];
  const kept = [...best.entries()].map(([symbol, e]) => ({
    symbol,
    name: displayName(symbol, classOf(network, e)!, e),
    assetClass: classOf(network, e)!,
    feed: e.proxyAddress as `0x${string}`,
    feedChain: chain,
    decimals: e.decimals,
    heartbeat: e.heartbeat!,
    risk: e.feedCategory ?? '',
    marketHours: String(e.docs?.marketHours ?? ''),
    path: e.path ?? '',
  }));
  return { kept, excluded };
}

/**
 * One feed per symbol across networks, by SOURCE_PRIORITY. A symbol that names assets of two classes (rare) keeps
 * the class listed first in ASSET_CLASSES.
 */
export function pickPerSymbol(candidates: Candidate[]): { picked: Candidate[]; dropped: Candidate[] } {
  const by = new Map<string, Candidate>();
  const dropped: Candidate[] = [];
  const rank = (c: Candidate) => [
    ASSET_CLASSES.indexOf(c.assetClass),
    SOURCE_PRIORITY[c.assetClass].indexOf(c.feedChain),
  ];
  for (const c of candidates) {
    const prev = by.get(c.symbol);
    if (!prev || cmp(rank(c), rank(prev)) < 0) {
      if (prev) dropped.push(prev);
      by.set(c.symbol, c);
    } else dropped.push(c);
  }
  const picked = [...by.values()].sort(
    (a, b) =>
      ASSET_CLASSES.indexOf(a.assetClass) - ASSET_CLASSES.indexOf(b.assetClass) || a.symbol.localeCompare(b.symbol),
  );
  return { picked, dropped };
}

/**
 * Oldest acceptable round, seconds: the heartbeat, plus the weekend for classes that trade in market hours (stocks,
 * ETFs, forex, commodities: no round from Friday's close to Monday's open), or plus 10% (at least 5 minutes) for
 * crypto, which trades around the clock. The keeper adds its finality allowance on top.
 */
export function stalenessOf(c: Pick<Candidate, 'assetClass' | 'heartbeat'>): number {
  if (c.assetClass === 'Crypto') return c.heartbeat + Math.max(300, Math.ceil(c.heartbeat / 10 / 60) * 60);
  return c.heartbeat + WEEKEND_ALLOWANCE_SEC;
}

/** Lowest price the bounds rule supports: below it, a tenth of the price has more decimals than bounds keep. */
export const MIN_SUPPORTED_PRICE = 0.00001;

/** `x` rounded down (or up) to two significant figures, as a plain decimal number. */
export function roundSig(x: number, dir: 'down' | 'up'): number {
  if (!(x > 0)) throw new Error(`roundSig: ${x}`);
  const e = Math.floor(Math.log10(x));
  const unit = 10 ** (e - 1);
  const k = dir === 'down' ? Math.floor(x / unit + 1e-9) : Math.ceil(x / unit - 1e-9);
  return Number((k * unit).toFixed(Math.max(0, 1 - e)));
}

/**
 * Price bounds every fixing must sit in (checked on-chain): a tenth of the price at generation to ten times it,
 * two significant figures (min rounded down, max up). Wide enough for any move a note's life would see; narrow
 * enough to refuse a feed that reports nonsense (a decimals change, a zero, a broken aggregator).
 */
export function boundsOf(price: number): { minPrice: number; maxPrice: number } {
  if (!(price >= MIN_SUPPORTED_PRICE)) throw new Error(`price ${price} below ${MIN_SUPPORTED_PRICE}`);
  return { minPrice: roundSig(price / 10, 'down'), maxPrice: roundSig(price * 10, 'up') };
}

const FX_NAMES: Record<string, string> = {
  EUR: 'Euro',
  GBP: 'British pound',
  JPY: 'Japanese yen',
  CHF: 'Swiss franc',
  AUD: 'Australian dollar',
  NZD: 'New Zealand dollar',
  CAD: 'Canadian dollar',
  CNY: 'Chinese yuan',
  KRW: 'South Korean won',
  SGD: 'Singapore dollar',
  HKD: 'Hong Kong dollar',
  SEK: 'Swedish krona',
  NOK: 'Norwegian krone',
  MXN: 'Mexican peso',
  BRL: 'Brazilian real',
  TRY: 'Turkish lira',
  IDR: 'Indonesian rupiah',
  PHP: 'Philippine peso',
  ARS: 'Argentine peso',
  INR: 'Indian rupee',
  ZAR: 'South African rand',
  CZK: 'Czech koruna',
  PLN: 'Polish zloty',
  ILS: 'Israeli shekel',
  THB: 'Thai baht',
  TWD: 'New Taiwan dollar',
};
const COMMODITY_NAMES: Record<string, string> = {
  XAU: 'Gold',
  XAG: 'Silver',
  XPT: 'Platinum',
  XPD: 'Palladium',
  WTI: 'WTI crude oil',
  BRENT: 'Brent crude oil',
};
/** Names for Robinhood Chain's equity feeds (the directory gives none). */
const EQUITY_NAMES: Record<string, string> = {
  AAPL: 'Apple',
  AMD: 'AMD',
  AMZN: 'Amazon',
  ASML: 'ASML',
  BABA: 'Alibaba',
  CLSK: 'CleanSpark',
  COIN: 'Coinbase',
  CRCL: 'Circle',
  CRWV: 'CoreWeave',
  DELL: 'Dell Technologies',
  EWY: 'iShares MSCI South Korea ETF',
  GLD: 'SPDR Gold Shares',
  GME: 'GameStop',
  GOOGL: 'Alphabet (Google)',
  INTC: 'Intel',
  IONQ: 'IonQ',
  META: 'Meta Platforms',
  MSFT: 'Microsoft',
  MSTR: 'Strategy (MicroStrategy)',
  MU: 'Micron Technology',
  NBIS: 'Nebius Group',
  NVDA: 'NVIDIA',
  ORCL: 'Oracle',
  PLTR: 'Palantir Technologies',
  QQQ: 'Invesco QQQ (Nasdaq-100)',
  RGTI: 'Rigetti Computing',
  RKLB: 'Rocket Lab',
  SHV: 'iShares Short Treasury Bond ETF',
  SLV: 'iShares Silver Trust',
  SNDK: 'Sandisk',
  SPCX: 'SpaceX (tokenized)',
  SPY: 'SPDR S&P 500 ETF',
  TSLA: 'Tesla',
  TSM: 'TSMC',
  USO: 'United States Oil Fund',
};

function displayName(symbol: string, cls: AssetClass, e: DirectoryEntry): string {
  if (cls === 'Forex') return FX_NAMES[symbol] ?? symbol;
  if (cls === 'Commodities') return COMMODITY_NAMES[symbol] ?? e.assetName ?? symbol;
  if (cls === 'Stocks') return EQUITY_NAMES[symbol] ?? (e.assetName || e.docs?.assetName || symbol);
  return e.assetName || e.docs?.assetName || symbol;
}

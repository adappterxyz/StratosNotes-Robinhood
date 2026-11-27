/**
 * Liquidity-aware collateral (docs/ATLAS-CMC.md). Collateral only protects holders if it can be sold: a stock token
 * locked against a note is worth its price only up to what the token's markets on BNB Chain can absorb. CoinMarketCap's
 * DEX API (/v1/dex/token, platform bsc) gives each token's on-chain liquidity, its 24-hour volume and its 24-hour
 * high and low; from them the issue flow suggests what share of the token's value a note should count (the haircut)
 * and says when a pledge is too large for the market it would have to be sold into.
 *
 * Advice shown before issuing: the haircut written in the note's terms is still the issuer's choice, and investors
 * see it. Pure: no I/O.
 */
export interface TokenMarket {
  /** USD in the token's DEX pools on BNB Chain. */
  liquidityUsd: number;
  /** USD traded on those DEXes in the last 24 hours. */
  volume24hUsd: number;
  /** The 24-hour low and high, USD. */
  low24h: number;
  high24h: number;
  /** When CoinMarketCap last priced it, unix seconds. */
  at: number;
}

/** CoinMarketCap's DEX path for a token on BNB Chain (network 14, platform "bsc"). */
export const cmcDexTokenPath = (address: string): string =>
  `/v1/dex/token?platform=bsc&address=${address.toLowerCase()}`;

/** Decode /v1/dex/token: throws when CoinMarketCap refuses or does not know the token's markets. */
export function decodeCmcDexToken(body: string): TokenMarket {
  let parsed: {
    status?: { error_code?: number | string };
    data?: {
      liqUsd?: string;
      ph24h?: string;
      pl24h?: string;
      pt?: string;
      sts?: Array<{ tp?: string; vu?: string }>;
    };
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new Error('CoinMarketCap: reply is not JSON');
  }
  const code = Number(parsed?.status?.error_code ?? 0);
  const d = parsed?.data;
  if (code !== 0 || !d) throw new Error(`CoinMarketCap: request refused${code ? ` (code ${code})` : ''}`);
  const n = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? Number(x) : NaN);
  const m: TokenMarket = {
    liquidityUsd: n(d.liqUsd),
    volume24hUsd: n(d.sts?.find((s) => s.tp === '24h')?.vu ?? 0),
    low24h: n(d.pl24h),
    high24h: n(d.ph24h),
    at: Math.floor(n(d.pt) / 1000),
  };
  if (!(m.liquidityUsd >= 0) || !(m.low24h > 0) || !(m.high24h >= m.low24h))
    throw new Error('CoinMarketCap: no DEX market data for this token');
  return m;
}

/** The most a stock token is counted at, % of its value (params.ts DEFAULT_HAIRCUT). */
export const MAX_COUNTED_AT = 60;
export const MIN_COUNTED_AT = 20;
/** A pledge above this share of the DEX liquidity starts to cost haircut; above LARGE it is flagged as unsellable. */
export const PLEDGE_SHARE_FREE = 0.1;
export const PLEDGE_SHARE_LARGE = 0.5;

export interface CollateralAdvice {
  /** Suggested haircut: what % of the token's value to count, a multiple of 5 between 20 and 60. */
  countedAtPct: number;
  /** 24-hour range, % of the low. */
  rangePct: number;
  /** The pledge as a share of the DEX liquidity, % (0 when no pledge size is known). */
  sharePct: number;
  /** 'ok', 'large' (above 10% of the liquidity: counted for less) or 'too-large' (above 50%). */
  size: 'ok' | 'large' | 'too-large';
}

/**
 * What to count a stock token at, given its market and the USD value pledged:
 *  - never more than MAX_COUNTED_AT;
 *  - room for four days like the last one: 100 - 4 x the 24-hour range;
 *  - less for a pledge that is large against the liquidity: one point per point of share above 10%.
 */
export function collateralAdvice(m: TokenMarket, pledgeUsd = 0): CollateralAdvice {
  const rangePct = ((m.high24h - m.low24h) / m.low24h) * 100;
  const share = m.liquidityUsd > 0 ? pledgeUsd / m.liquidityUsd : pledgeUsd > 0 ? Infinity : 0;
  const sizePenalty = Math.max(0, share - PLEDGE_SHARE_FREE) * 100;
  const raw = Math.min(MAX_COUNTED_AT, 100 - 4 * rangePct) - sizePenalty;
  const countedAtPct = Math.max(MIN_COUNTED_AT, Math.min(MAX_COUNTED_AT, Math.floor(raw / 5) * 5));
  return {
    countedAtPct,
    rangePct,
    sharePct: Number.isFinite(share) ? share * 100 : Infinity,
    size: share > PLEDGE_SHARE_LARGE ? 'too-large' : share > PLEDGE_SHARE_FREE ? 'large' : 'ok',
  };
}

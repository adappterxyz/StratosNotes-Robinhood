import { describe, expect, it } from 'vitest';
import { cmcDexTokenPath, collateralAdvice, decodeCmcDexToken, type TokenMarket } from '../src';

// What CoinMarketCap answered for TSLAB on 2026-11-25, trimmed to the fields read.
const TSLAB = JSON.stringify({
  data: {
    sym: 'TSLAB',
    liqUsd: '1793494.607775491382923177',
    ph24h: '386.131689701965906977',
    pl24h: '357.945421335001723797',
    pt: '1795626336000',
    sts: [
      { tp: '1h', vu: '149084.64' },
      { tp: '24h', vu: '2221107.8615037347515552' },
    ],
  },
  status: { error_code: '0' },
});

describe('liquidity-aware collateral (CoinMarketCap DEX data, BNB Chain)', () => {
  it("reads a token's DEX liquidity, volume and 24-hour range", () => {
    expect(cmcDexTokenPath('0x5B1910eaad6450e50f816082aa078c41f10c292F')).toBe(
      '/v1/dex/token?platform=bsc&address=0x5b1910eaad6450e50f816082aa078c41f10c292f',
    );
    const m = decodeCmcDexToken(TSLAB);
    expect(m.liquidityUsd).toBeCloseTo(1_793_494.61, 2);
    expect(m.volume24hUsd).toBeCloseTo(2_221_107.86, 2);
    expect(m.low24h).toBeCloseTo(357.945, 3);
    expect(m.high24h).toBeCloseTo(386.132, 3);
    expect(m.at).toBe(1795626336);
    expect(() => decodeCmcDexToken(JSON.stringify({ status: { error_code: '400' } }))).toThrow(/refused \(code 400\)/);
    expect(() => decodeCmcDexToken(JSON.stringify({ data: { liqUsd: '1' }, status: { error_code: '0' } }))).toThrow(
      /no DEX market data/,
    );
  });

  const m: TokenMarket = { liquidityUsd: 1_000_000, volume24hUsd: 2_000_000, low24h: 100, high24h: 105, at: 0 };

  it('counts a calm, liquid token at the most a stock token is counted at', () => {
    expect(collateralAdvice(m, 10_000)).toMatchObject({ countedAtPct: 60, size: 'ok' });
    expect(collateralAdvice(m, 10_000).rangePct).toBeCloseTo(5, 10);
    expect(collateralAdvice(m, 10_000).sharePct).toBeCloseTo(1, 10);
    // The real TSLAB day: a 7.9% range still leaves 60.
    expect(collateralAdvice(decodeCmcDexToken(TSLAB), 30).countedAtPct).toBe(60);
  });

  it('counts a token for less after a violent day', () => {
    // A 15% range: room for four such days is 100 - 60 = 40.
    expect(collateralAdvice({ ...m, high24h: 115 }).countedAtPct).toBe(40);
    // Never below the floor.
    expect(collateralAdvice({ ...m, high24h: 160 }).countedAtPct).toBe(20);
  });

  it('counts a pledge for less when it is large against the liquidity, and flags one that could not be sold', () => {
    // 30% of the liquidity: 20 points above the free 10%.
    expect(collateralAdvice(m, 300_000)).toMatchObject({ countedAtPct: 40, size: 'large' });
    expect(collateralAdvice(m, 600_000)).toMatchObject({ countedAtPct: 20, size: 'too-large' });
    expect(collateralAdvice({ ...m, liquidityUsd: 0 }, 1)).toMatchObject({ size: 'too-large', sharePct: Infinity });
    expect(collateralAdvice({ ...m, liquidityUsd: 0 }, 0)).toMatchObject({ size: 'ok', sharePct: 0 });
  });
});

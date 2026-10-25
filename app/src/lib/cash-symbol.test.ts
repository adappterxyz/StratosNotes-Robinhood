import { describe, expect, it } from 'vitest';
import { cashSymbol, prepareConfig } from './chains';

const USDG_RH = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const TUSD_RH = '0x1D91004a9DA8D385196017727046cBA8CBbff397';

describe('cash symbol per note', () => {
  it('keeps tUSD notes labelled tUSD when the API names USDG as the stablecoin', () => {
    const cfg = prepareConfig({
      chains: [
        {
          key: 'robinhood-testnet',
          stablecoin: { symbol: 'USDG', address: USDG_RH, decimals: 6 },
          tokens: { tUSD: TUSD_RH, USDG: USDG_RH },
        },
      ],
    } as never);
    const c = cfg.chains[0];
    expect(cashSymbol(c, TUSD_RH.toLowerCase())).toBe('tUSD');
    expect(cashSymbol(c, USDG_RH.toLowerCase())).toBe('USDG');
  });
});

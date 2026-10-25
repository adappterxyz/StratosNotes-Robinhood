import { describe, expect, it } from 'vitest';
import {
  collateralShortfalls,
  describeFlush,
  encodeFlushReport,
  isReceiptInfo,
  keeperGateways,
  overdueReleases,
  planFallbackFlush,
  planFlush,
  planReceiptPush,
  planReceiptWithdrawals,
  receiptPushGas,
  releaseQueueReading,
  withdrawableBase,
  type VaultWatch,
} from '../src/crosschain';

const watch: VaultWatch = {
  homeChain: 'robinhood-testnet',
  receipt: '0xr',
  assetChain: 'ethereum-testnet-sepolia',
  vault: '0xv',
  token: '0xt',
  label: 'USDC on Ethereum Sepolia',
};
const reading = (
  o: Partial<{ locked: bigint; unclaimedTotal: bigint; vaultBalance: bigint; receiptsOutstanding: bigint }>,
) => ({ watch, locked: 100n, unclaimedTotal: 0n, vaultBalance: 100n, receiptsOutstanding: 100n, ...o });

describe('cross-chain collateral checks', () => {
  it('a fully backed vault has no shortfall', () => {
    expect(collateralShortfalls([reading({})])).toEqual([]);
  });
  it('messages in flight never look like a shortfall', () => {
    // A lock not yet credited at home; a redemption burned at home, not yet paid on the asset chain.
    expect(collateralShortfalls([reading({ receiptsOutstanding: 60n })])).toEqual([]);
  });
  it('unclaimed releases are owed but no longer locked', () => {
    expect(
      collateralShortfalls([
        reading({ locked: 60n, unclaimedTotal: 40n, vaultBalance: 100n, receiptsOutstanding: 60n }),
      ]),
    ).toEqual([]);
  });
  it('the token taking tokens back from the vault is a shortfall', () => {
    expect(collateralShortfalls([reading({ vaultBalance: 70n })])).toEqual([
      { watch, kind: 'vault-backing', missing: 30n },
    ]);
  });
  it('receipts the vault does not account for are a shortfall', () => {
    expect(collateralShortfalls([reading({ receiptsOutstanding: 120n })])).toEqual([
      { watch, kind: 'receipts-exceed-locked', missing: 20n },
    ]);
  });
});

describe('auto-release queue (HomeGateway v2)', () => {
  const q = (o: Partial<{ pending: bigint; head: bigint; queued: bigint; pool: bigint; nextFee: bigint }>) => ({
    pending: 0n,
    head: 1n,
    queued: 0n,
    pool: 10n ** 16n,
    nextFee: 5n * 10n ** 13n,
    ...o,
  });
  it('nothing queued: no report', () => {
    expect(planFlush(q({}))).toMatchObject({ flush: false, reason: 'empty' });
  });
  it('flushes what is pending, within the cap and what the pool pays for', () => {
    expect(planFlush(q({ pending: 3n, queued: 3n }))).toEqual({
      flush: true,
      maxItems: 3,
      gasLimit: 150_000n + 3n * 300_000n,
    });
    expect(planFlush(q({ pending: 40n }), { maxItems: 50 }).maxItems).toBe(25);
    expect(planFlush(q({ pending: 40n, pool: 2n * 5n * 10n ** 13n })).maxItems).toBe(2);
  });
  it('an empty pool or a chain without a vault waits (the releases stay queued)', () => {
    expect(planFlush(q({ pending: 2n, pool: 1n }))).toMatchObject({ flush: false, reason: 'pool-short' });
    expect(planFlush(q({ pending: 2n, nextFee: 0n }))).toMatchObject({ flush: false, reason: 'no-vault' });
  });
  it('the report is abi.encode(uint8 1, uint256 maxItems)', () => {
    expect(encodeFlushReport(7)).toBe(`0x${'0'.repeat(63)}1${'0'.repeat(63)}7`);
    expect(() => encodeFlushReport(0)).toThrow();
  });
  it('reads releaseQueue() outputs in order', () => {
    expect(releaseQueueReading([2n, 5n, 6n, 10n ** 15n, 4n])).toEqual({
      pending: 2n,
      head: 5n,
      queued: 6n,
      pool: 10n ** 15n,
      nextFee: 4n,
    });
  });
  it('logs one line per gateway, with why no report was written', () => {
    const flushing = q({ pending: 2n, queued: 2n });
    expect(describeFlush('rh', flushing, planFlush(flushing))).toMatch(
      /^rh gateway flush: 2 release\(s\) waiting .* -> flush up to 2 \(gas 750000\)$/,
    );
    expect(describeFlush('rh', q({}), planFlush(q({})))).toMatch(/no report \(nothing to send\)$/);
    const short = q({ pending: 1n, pool: 1n });
    expect(describeFlush('rh', short, planFlush(short))).toMatch(/no report \(pool-short/);
    const noVault = q({ pending: 1n, nextFee: 0n });
    expect(describeFlush('rh', noVault, planFlush(noVault))).toMatch(/no report \(no-vault/);
  });
  it('the keeper config gets the gateway only for an auto-release (v2) gateway', () => {
    const names = { 'robinhood-testnet': 'robinhood-testnet' };
    const home = { chain: 'robinhood-testnet', gateway: '0x4C393Ed28Cc1825CfBA5A4d6F2223589249C3a89' };
    expect(keeperGateways({ home: { ...home, version: 2 } }, names, { stateBlock: 'latest' })).toEqual([
      {
        chainSelectorName: 'robinhood-testnet',
        gateway: home.gateway,
        maxItems: 10,
        baseGas: '250000',
        gasPerItem: '300000',
        stateBlock: 'latest',
      },
    ]);
    expect(keeperGateways({ home }, names)).toEqual([]);
    expect(keeperGateways({ home: { ...home, version: 1 } }, names)).toEqual([]);
    expect(() => keeperGateways({ home: { ...home, chain: 'mars', version: 2 } }, names)).toThrow();
  });
});

describe('auto-release automation (issuer bot)', () => {
  const TSLA_RH = '0x3667d1534FA175c1A388fC8E2C8F8d7ebBBcD9d6',
    USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
  const receipts = new Set([TSLA_RH.toLowerCase()]);
  const isReceipt = (t: string) => receipts.has(t.toLowerCase());

  it('tells a receipt from any other token by the gateway registry', () => {
    expect(isReceiptInfo([2032988798112970440n, '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E'])).toBe(true);
    expect(isReceiptInfo([0n, '0x0000000000000000000000000000000000000000'])).toBe(false);
  });

  it('withdraws whole base units only, so the engine converts the amount back exactly', () => {
    expect(withdrawableBase(3n * 10n ** 10n, 18)).toBe(3n * 10n ** 18n); // 3 TSLA.rh
    expect(withdrawableBase(12_345_678n, 6)).toBe(1_234n); // 0.0012345678 USDG.rh -> 1,234 base units, the rest stays
    expect(withdrawableBase(9_999n, 6)).toBe(0n);
    expect(withdrawableBase(-5n, 18)).toBe(0n);
    // Round trip as Units.fromBase / toBase: base * 1e10 / 10^d, then back.
    for (const [bal, d] of [
      [123_456_789_012n, 18],
      [123_456_789_012n, 6],
      [7n, 10],
    ] as const) {
      const base = withdrawableBase(bal, d);
      const fixed = (base * 10n ** 10n) / 10n ** BigInt(d);
      expect((fixed * 10n ** BigInt(d)) / 10n ** 10n).toBe(base);
    }
  });

  it('a note paid in full: the issuer withdraws its receipt collateral, never its cash', () => {
    const assets = [
      { asset: 1, token: USDG, decimals: 6, balance: 40n * 10n ** 10n },
      { asset: 2, token: TSLA_RH, decimals: 18, balance: 3n * 10n ** 10n },
    ];
    expect(planReceiptWithdrawals(false, assets, isReceipt)).toEqual([
      { asset: 2, token: TSLA_RH, base: 3n * 10n ** 18n },
    ]);
  });

  it('nothing while the note runs, and nothing below one base unit', () => {
    const assets = [{ asset: 2, token: TSLA_RH, decimals: 18, balance: 3n * 10n ** 10n }];
    expect(planReceiptWithdrawals(true, assets, isReceipt)).toEqual([]);
    expect(
      planReceiptWithdrawals(false, [{ asset: 2, token: TSLA_RH, decimals: 6, balance: 9_999n }], isReceipt),
    ).toEqual([]);
    expect(planReceiptWithdrawals(false, [{ asset: 2, token: TSLA_RH, decimals: 18, balance: 0n }], isReceipt)).toEqual(
      [],
    );
  });

  it('a default: pushes every holder owed a whole base unit of the receipt, in batches', () => {
    const who = ['0xa', '0xb', '0xc', '0xd', '0xe'];
    const owed = [10n ** 10n, 0n, 5n, 2n * 10n ** 10n, 3n * 10n ** 10n];
    expect(planReceiptPush(who, owed, 18, 2)).toEqual([
      ['0xa', '0xc'],
      ['0xd', '0xe'],
    ]);
    // 6 decimals: 5 (fixed point) is under one base unit (1e4) and stays claimable.
    expect(planReceiptPush(who, owed, 6, 25)).toEqual([['0xa', '0xd', '0xe']]);
    expect(planReceiptPush([], [], 18, 25)).toEqual([]);
    expect(() => planReceiptPush(who, owed.slice(1), 18, 2)).toThrow();
    expect(() => planReceiptPush(who, owed, 18, 0)).toThrow();
  });

  it('push gas leaves every holder the full 150k transfer cap', () => {
    expect(receiptPushGas(1)).toBe(450_000n);
    expect(receiptPushGas(25)).toBe(200_000n + 25n * 250_000n);
    expect(receiptPushGas(25) / 25n).toBeGreaterThan(150_000n);
  });

  describe('CRE is the primary flusher; the bot flushes only what waited longer than FLUSH_AFTER', () => {
    const q = (o: Partial<{ pending: bigint; head: bigint; queued: bigint; pool: bigint; nextFee: bigint }>) => ({
      pending: 3n,
      head: 4n,
      queued: 6n,
      pool: 10n ** 16n,
      nextFee: 5n * 10n ** 13n,
      ...o,
    });
    const at = new Map<bigint, number>([
      [4n, 1_000],
      [5n, 1_100],
      [6n, 1_190],
    ]);

    it('counts the releases older than FLUSH_AFTER, oldest first', () => {
      expect(overdueReleases(q({}), at, new Set(), 1_150, 180)).toBe(0); // the oldest waited 150 s: CRE's turn
      expect(overdueReleases(q({}), at, new Set(), 1_181, 180)).toBe(1);
      expect(overdueReleases(q({}), at, new Set(), 1_290, 180)).toBe(2);
      expect(overdueReleases(q({}), at, new Set(), 2_000, 180)).toBe(3);
      expect(overdueReleases(q({}), at, new Set(), 2_000, 180, 2)).toBe(2);
    });
    it('a release queued exactly FLUSH_AFTER ago is not overdue yet', () => {
      expect(overdueReleases(q({}), at, new Set(), 1_180, 180)).toBe(0);
    });
    it('skips releases already sent out of order, as flush does', () => {
      expect(overdueReleases(q({}), at, new Set([4n]), 1_290, 180)).toBe(1);
      expect(overdueReleases(q({}), at, new Set([5n]), 1_400, 180)).toBe(2);
    });
    it('an unknown queued time stops the count (never flush ahead of CRE on a guess)', () => {
      expect(overdueReleases(q({}), new Map([[5n, 0]]), new Set(), 5_000, 180)).toBe(0);
      expect(overdueReleases(q({ head: 1n, queued: 0n }), at, new Set(), 5_000, 180)).toBe(0);
    });
    it('the plan: nothing overdue waits for CRE; else at most the overdue ones, the pool and the cap', () => {
      expect(planFallbackFlush(q({}), 0)).toMatchObject({ flush: false, reason: 'cre-window' });
      expect(planFallbackFlush(q({}), 2)).toEqual({ flush: true, maxItems: 2, gasLimit: 150_000n + 2n * 300_000n });
      expect(planFallbackFlush(q({}), 9).maxItems).toBe(3);
      expect(planFallbackFlush(q({ pool: 5n * 10n ** 13n }), 3).maxItems).toBe(1);
      expect(planFallbackFlush(q({ pool: 1n }), 3)).toMatchObject({ flush: false, reason: 'pool-short' });
      expect(planFallbackFlush(q({ pending: 0n }), 3)).toMatchObject({ flush: false, reason: 'empty' });
      expect(planFallbackFlush(q({ nextFee: 0n }), 3)).toMatchObject({ flush: false, reason: 'no-vault' });
    });
  });
});

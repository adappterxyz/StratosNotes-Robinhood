import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  distributionHash,
  payoutId,
  rollingHash,
  verifyPayouts,
  type EngineEvent,
  type NoteEvent,
  type NoteState,
} from '../src';

const scope = { chainId: 46630, engine: '0x1111111111111111111111111111111111111111' };
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';

// Vectors from `cast keccak $(cast abi-encode ...)`, i.e. Solidity's keccak256(abi.encode(...)).
const P1 = '0x8295e2a8ef347bfcd8fa714683ace073697b7f3c2d9a879942bc71342e8e84a9';
const P2 = '0x3f88995ea51f63aedea1c8e526e80baedefab2f14f9d998a0f763910ecdd8bd8';
const ROLLING = '0x82ea0d33bb42a8b1df8f236a4dbda6baa53ddf8c91d534d0615a9661d4c74de9';
const DIST = '0xa73a2f3cd32e5142bb9d406761068c08df946d8d4346f11e8ab1d5a33bd98472';

describe('payout receipts', () => {
  it('payoutId, the rolling hash and the distribution hash match Solidity abi.encode', () => {
    expect(payoutId(scope, 7n, 1, 3, A, 1_250_000n)).toBe(P1);
    expect(payoutId(scope, '7', 1, 3, B, '750000')).toBe(P2);
    expect(rollingHash([P1, P2])).toBe(ROLLING);
    expect(distributionHash(scope, 7n, 1, 3, 125_000_000n, 10_000_000_000_000n)).toBe(DIST);
  });

  it('verifyPayouts checks every receipt and each round against the logs', () => {
    const events: EngineEvent[] = [
      {
        name: 'DistributionRecorded',
        pid: '7',
        asset: 1,
        period: 3,
        holding: 0,
        step: 12,
        payer: '0x9',
        perUnit: '125000000',
        total: '1250000000000',
        supply: '10000000000000',
        retire: false,
        hash: DIST,
      },
      { name: 'PayoutPaid', pid: '7', asset: 1, period: 3, holder: A, amount: '1250000', payoutId: P1 },
      { name: 'PayoutPaid', pid: '7', asset: 1, period: 3, holder: B, amount: '750000', payoutId: P2 },
      {
        name: 'DistributionSettled',
        pid: '7',
        asset: 1,
        period: 3,
        paidCount: 2,
        paidTotal: '2000000',
        rollingHash: ROLLING,
      },
    ];
    const [r] = verifyPayouts(scope, events);
    expect(r.ok).toBe(true);
    const tampered = events.map((e) => (e.name === 'PayoutPaid' && e.holder === B ? { ...e, amount: '750001' } : e));
    const [t] = verifyPayouts(scope, tampered);
    expect(t.ok).toBe(false);
    expect(t.problems.join(' ')).toMatch(/payoutId mismatch/);
  });

  it("checks the receipts of holders' claims in a round nobody pushed to the end (settled: false)", () => {
    const events: EngineEvent[] = [
      {
        name: 'DistributionRecorded',
        pid: '7',
        asset: 1,
        period: 3,
        holding: 0,
        step: 12,
        payer: '0x9',
        perUnit: '125000000',
        total: '1250000000000',
        supply: '10000000000000',
        retire: false,
        hash: DIST,
      },
      { name: 'PayoutPaid', pid: '7', asset: 1, period: 3, holder: A, amount: '1250000', payoutId: P1 },
    ];
    const [r] = verifyPayouts(scope, events);
    expect(r).toMatchObject({ settled: false, ok: true, paidCount: 1, paidTotal: 1_250_000n, period: 3 });
    const [t] = verifyPayouts(scope, [events[0], { ...events[1], amount: '1' } as EngineEvent]);
    expect(t.ok).toBe(false);
  });
});

describe('the read model follows the accumulator', () => {
  const ctx = { chain: 'local', engine: scope.engine, at: 1 };
  const start: NoteEvent = {
    name: 'ProcessStarted',
    pid: '1',
    definition: '0xd',
    creator: A,
    ref: '1',
    roles: [A, '0x0000000000000000000000000000000000000000'],
    assetTokens: ['0x0000000000000000000000000000000000000000', '0x00000000000000000000000000000000000000aa'],
  };

  it('credits holders at payment time, follows units, and settles to the chain balance', () => {
    let s: NoteState | null = applyEvent(null, start, ctx);
    const ev = (e: NoteEvent) => {
      s = applyEvent(s, e, ctx);
    };
    ev({ name: 'NoteTokenCreated', pid: '1', asset: 0, token: '0x00000000000000000000000000000000000000BB' });
    expect(s!.assetTokens[0]).toBe('0x00000000000000000000000000000000000000bb');
    ev({ name: 'HoldingChanged', pid: '1', asset: 0, owner: A, balance: String(600n * 10n ** 10n) });
    ev({ name: 'HoldingChanged', pid: '1', asset: 0, owner: B, balance: String(400n * 10n ** 10n) });
    // 2% coupon: 0.02 per unit.
    ev({
      name: 'DistributionRecorded',
      pid: '1',
      asset: 1,
      period: 1,
      holding: 0,
      step: 5,
      payer: '0x9',
      perUnit: String(2n * 10n ** 8n),
      total: String(20n * 10n ** 10n),
      supply: String(1000n * 10n ** 10n),
      retire: false,
      hash: '0x',
    });
    const cash = (o: string) => s!.holdings.find((h) => h.asset === 1 && h.owner === o.toLowerCase())?.balance;
    expect(cash(A)).toBe(String(12n * 10n ** 10n));
    expect(cash(B)).toBe(String(8n * 10n ** 10n));
    // A pushes to the wallet: the chain logs the account's balance after the push.
    ev({ name: 'PayoutPaid', pid: '1', asset: 1, period: 1, holder: A, amount: '12000000', payoutId: '0x' });
    ev({ name: 'HoldingChanged', pid: '1', asset: 1, owner: A, balance: '0' });
    expect(cash(A)).toBeUndefined();
    // A sells everything to B; the redemption pays B on all 1,000 and retires the units.
    ev({ name: 'HoldingChanged', pid: '1', asset: 0, owner: A, balance: '0' });
    ev({ name: 'HoldingChanged', pid: '1', asset: 0, owner: B, balance: String(1000n * 10n ** 10n) });
    ev({
      name: 'DistributionRecorded',
      pid: '1',
      asset: 1,
      period: 2,
      holding: 0,
      step: 9,
      payer: '0x9',
      perUnit: String(10n ** 10n),
      total: String(1000n * 10n ** 10n),
      supply: String(1000n * 10n ** 10n),
      retire: true,
      hash: '0x',
    });
    expect(cash(B)).toBe(String(1008n * 10n ** 10n));
    expect(s!.holdings.filter((h) => h.asset === 0)).toEqual([]);
  });
});

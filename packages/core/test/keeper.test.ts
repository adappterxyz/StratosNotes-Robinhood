import { describe, expect, it } from 'vitest';
import {
  checkRound,
  compile,
  dec,
  dueReports,
  EXAMPLE_PRODUCTS,
  EXAMPLE_WORST_OF,
  feedToFixed,
  instantiateProduct,
  parseBpmn,
  routeFeed,
  STEP_ADVANCE,
  type ProcessState,
  type ProductParams,
} from '../src';

function compiled(p: ProductParams) {
  const prod = instantiateProduct(p);
  return compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
}

/** A running process with tokens on `steps` and the named date fields set. */
function state(c: ReturnType<typeof compiled>, steps: string[], dates: Record<string, number>): ProcessState {
  const numbers: Array<bigint | undefined> = [];
  for (const [name, at] of Object.entries(dates)) numbers[c.def.fields.findIndex((f) => f.name === name)] = BigInt(at);
  return { id: '7', definition: '0xabc', status: 0, tokens: steps.map((s) => c.stepIndex[s]), numbers };
}

describe('keeper: what is due', () => {
  const phoenix = compiled(EXAMPLE_PRODUCTS.phoenix);

  it('waits for the strike date, then reports the strike fixing with its feed', () => {
    const p = state(phoenix, ['Task_FixStrike'], { strikeDate: 1000 });
    expect(dueReports(p, phoenix.def, 999)).toEqual([]);
    const [d] = dueReports(p, phoenix.def, 1000);
    expect(d).toMatchObject({
      process: '7',
      definition: '0xabc',
      step: phoenix.stepIndex.Task_FixStrike,
      stepId: 'Task_FixStrike',
    });
    expect(d.feeds).toHaveLength(1);
    expect(d.feeds[0].feedChain).toBe('ethereum-mainnet');
    expect(d.feeds[0].feed).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('does nothing while the date field is unset, or once the note is finished', () => {
    expect(dueReports(state(phoenix, ['Task_FixStrike'], {}), phoenix.def, 5000)).toEqual([]);
    const done = { ...state(phoenix, ['Task_FixStrike'], { strikeDate: 1 }), status: 1 };
    expect(dueReports(done, phoenix.def, 5000)).toEqual([]);
  });

  it("ignores user tasks: subscriptions are investors' to make", () => {
    expect(
      dueReports(state(phoenix, ['Task_Subscribe', 'Task_Fund1'], { strikeDate: 6000 }), phoenix.def, 5000),
    ).toEqual([]);
    // A closed window advances only when nothing else holds the note (closing it is what finishes it).
    expect(
      dueReports(state(phoenix, ['Task_Subscribe', 'Task_FixStrike'], { strikeDate: 6000 }), phoenix.def, 7000).map(
        (d) => d.stepId,
      ),
    ).toEqual(['Task_FixStrike']);
    expect(
      dueReports(state(phoenix, ['Task_Subscribe'], { strikeDate: 6000 }), phoenix.def, 7000).map((d) => d.stepId),
    ).toEqual(['advance']);
  });

  it('reports an observation on its own date', () => {
    const p = state(phoenix, ['Task_Observe2'], { obsDate2: 2000 });
    expect(dueReports(p, phoenix.def, 1999)).toEqual([]);
    expect(dueReports(p, phoenix.def, 2000).map((d) => d.stepId)).toEqual(['Task_Observe2']);
  });

  it('reads one feed per underlying for a worst-of basket', () => {
    const wo = compiled(EXAMPLE_WORST_OF);
    const [d] = dueReports(state(wo, ['Task_FixStrike'], { strikeDate: 10 }), wo.def, 10);
    expect(d.feeds.map((f) => f.field)).toEqual(EXAMPLE_WORST_OF.underlyings.map((u) => `initialLevel_${u.symbol}`));
    expect(new Set(d.feeds.map((f) => f.feed)).size).toBe(EXAMPLE_WORST_OF.underlyings.length);
  });

  it('advances a plain due timer once, and only when no oracle step is due', () => {
    const def = structuredClone(phoenix.def);
    const k = phoenix.stepIndex.Task_Observe1;
    def.steps[k] = { ...def.steps[k], captures: [] }; // a timer that observes nothing
    const p = state(phoenix, ['Task_Observe1'], { obsDate1: 50 });
    expect(dueReports(p, def, 49)).toEqual([]);
    expect(dueReports(p, def, 50)).toEqual([
      { process: '7', definition: '0xabc', step: STEP_ADVANCE, stepId: 'advance', feeds: [] },
    ]);
    const both = {
      ...p,
      tokens: [...p.tokens, phoenix.stepIndex.Task_FixStrike],
      numbers: Object.assign([], p.numbers, { [def.fields.findIndex((f) => f.name === 'strikeDate')]: 1n }),
    };
    expect(dueReports(both, def, 50).map((d) => d.stepId)).toEqual(['Task_FixStrike']);
  });
});

describe('keeper: prices', () => {
  it("scales feed answers to the engine's 10 decimals", () => {
    expect(feedToFixed(2_581_15000000n, 8)).toBe(dec(2581.15));
    expect(feedToFixed(10n ** 18n, 18)).toBe(dec(1));
  });

  it('rejects stale, unanswered and non-positive rounds', () => {
    const r = { roundId: 5n, answer: 100_00000000n, updatedAt: 1000n, answeredInRound: 5n };
    expect(checkRound(r, 8, 1000 + 3600 + 900, 3600, 900)).toBe(dec(100));
    expect(() => checkRound(r, 8, 1000 + 3600 + 901, 3600, 900)).toThrow(/stale/);
    expect(() => checkRound({ ...r, answer: 0n }, 8, 1000, 3600, 0)).toThrow(/non-positive/);
    expect(() => checkRound({ ...r, answeredInRound: 4n }, 8, 1000, 3600, 0)).toThrow(/not answered/);
  });

  it('routes a recorded feed to another source by address', () => {
    const f = {
      field: 'obs1_ETH',
      feed: '0xAbC0000000000000000000000000000000000001',
      feedChain: 'ethereum-mainnet',
      staleness: 3600,
    };
    expect(routeFeed(f, undefined)).toBe(f);
    expect(
      routeFeed(f, {
        '0xabc0000000000000000000000000000000000001': { feed: '0x02', feedChain: 'ethereum-mainnet-arbitrum-1' },
      }),
    ).toEqual({ field: 'obs1_ETH', feed: '0x02', feedChain: 'ethereum-mainnet-arbitrum-1', staleness: 3600 });
  });
});

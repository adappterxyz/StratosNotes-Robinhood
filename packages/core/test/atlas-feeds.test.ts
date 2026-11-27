import { describe, expect, it } from 'vitest';
import {
  ATLAS_BSTOCKS,
  ATLAS_MULTI_FEED,
  ATLAS_STALENESS,
  ATLAS_SYMBOLS,
  ATLAS_TOKENS,
  COLLATERAL_SYMBOLS,
  deliverableToken,
  atlasFetchData,
  atlasQualityHolds,
  atlasSignedBody,
  decodeAtlasSigned,
  BSC_MAINNET_FEED_CHAIN,
  checkRound,
  cmcIdOfFeed,
  decodeFeedBatch,
  feedBatchBody,
  FEEDS,
  HTTP_FEED_CHAINS,
  isAtlasFeed,
  keyedFeed,
  parseFeedRef,
  readingToRound,
} from '../src';

const TSLAB = keyedFeed(ATLAS_MULTI_FEED, 933);
const collateralChoicesHas = (s: string) => (COLLATERAL_SYMBOLS as string[]).includes(s);
const CHAINLINK = '0x4A1166a659A55625345e9515b32adECea5547C38';
const w = (v: bigint) => v.toString(16).padStart(64, '0');

describe('Atlas Multi-Feed prices', () => {
  it('names one price of the registry as contract#id', () => {
    expect(FEEDS.TSLAB.feed).toBe(TSLAB);
    expect(parseFeedRef(TSLAB)).toEqual({ address: ATLAS_MULTI_FEED, atlasId: 933 });
    expect(parseFeedRef(CHAINLINK)).toEqual({ address: CHAINLINK });
    expect(isAtlasFeed(TSLAB)).toBe(true);
    expect(isAtlasFeed(CHAINLINK)).toBe(false);
    // fetch(bytes4): the id left-aligned in its word. Checked against the live contract 2026-11-25.
    expect(atlasFetchData(933)).toBe('0x7ffc4b97000003a5' + '0'.repeat(56));
    expect(HTTP_FEED_CHAINS[BSC_MAINNET_FEED_CHAIN]).toMatchObject({ chainId: 56 });
  });

  it('asks for fetch(id) on the registry and latestRoundData on a Chainlink feed, in one batch', () => {
    const calls = JSON.parse(feedBatchBody([TSLAB, CHAINLINK], '0x10')) as Array<{
      id: number;
      params: [{ to: string; data: string }, string];
    }>;
    expect(calls.map((c) => c.id)).toEqual([0, 1, 2, 3]);
    expect(calls[0].params[0]).toEqual({ to: ATLAS_MULTI_FEED, data: atlasFetchData(933) });
    expect(calls[1].params[0]).toEqual({ to: ATLAS_MULTI_FEED, data: '0x313ce567' });
    expect(calls[2].params[0]).toEqual({ to: CHAINLINK, data: '0xfeaf968c' });
    expect(calls.every((c) => c.params[1] === '0x10')).toBe(true);
  });

  it('decodes a snapshot (the reply BNB Chain gave on 2026-11-25) into a reading the keeper checks as any other', () => {
    // TSLAB: 364.62… USD (18 decimals), aggregated at 1795621959, written on-chain a second later.
    const reply = JSON.stringify([
      { jsonrpc: '2.0', id: 1, result: '0x' + w(18n) },
      { jsonrpc: '2.0', id: 0, result: '0x' + w(0x13c42a3934e5f37dc0n) + w(0x6b070447n) + w(0x6b070448n) },
    ]);
    const [r] = decodeFeedBatch(reply, [TSLAB]);
    expect(r).toEqual({
      roundId: '1795621959',
      answer: '364623310680296226240',
      updatedAt: '1795621959',
      answeredInRound: '1795621959',
      decimals: 18,
    });
    const { round, decimals } = readingToRound(r);
    // Engine fixed point: 10 decimals.
    expect(checkRound(round, decimals, 1795621959 + 60, ATLAS_STALENESS, 30)).toBe(3646233106802n);
    // Atlas stopped publishing (its sources disagree): the price ages out and the check waits.
    expect(() => checkRound(round, decimals, 1795621959 + ATLAS_STALENESS + 31, ATLAS_STALENESS, 30)).toThrow(/stale/);
  });

  it('fails an id Atlas does not publish, and only that feed', () => {
    const reply = JSON.stringify([
      { jsonrpc: '2.0', id: 0, result: '0x' + w(0n) + w(0n) + w(0n) },
      { jsonrpc: '2.0', id: 1, result: '0x' + w(18n) },
      { jsonrpc: '2.0', id: 2, result: '0x' + w(5n) + w(40000000000n) + w(100n) + w(100n) + w(5n) },
      { jsonrpc: '2.0', id: 3, result: '0x' + w(8n) },
    ]);
    const [atlas, chainlink] = decodeFeedBatch(reply, [keyedFeed(ATLAS_MULTI_FEED, 1), CHAINLINK]);
    expect(atlas).toEqual({ error: 'Atlas feed: empty snapshot (unknown feed id?)' });
    expect(chainlink).toMatchObject({ answer: '40000000000', decimals: 8 });
  });

  it("knows each stock token's CoinMarketCap id: its second source", () => {
    expect(cmcIdOfFeed(FEEDS.TSLAB)).toBe(ATLAS_BSTOCKS.TSLAB.cmcId);
    expect(cmcIdOfFeed(FEEDS.NVDAB)).toBe(40215);
    expect(cmcIdOfFeed(FEEDS.TSLA)).toBeUndefined();
    expect(new Set(Object.values(ATLAS_BSTOCKS).map((b) => b.cmcId)).size).toBe(7);
    // The index ETFs and the other stocks: underlyings only, each with its own feed and CoinMarketCap id.
    expect(cmcIdOfFeed(FEEDS.SPYB)).toBe(40790);
    expect(cmcIdOfFeed(FEEDS.QQQB)).toBe(40593);
    expect(ATLAS_SYMBOLS).toHaveLength(14);
    expect(new Set(ATLAS_SYMBOLS.map((s) => ATLAS_TOKENS[s].cmcId)).size).toBe(14);
    expect(new Set(ATLAS_SYMBOLS.map((s) => ATLAS_TOKENS[s].atlasId)).size).toBe(14);
    expect(deliverableToken({ chain: 'bnb-testnet' }, 'SPYB')).toBeUndefined();
    expect(collateralChoicesHas('SPYB')).toBe(false);
  });
});

describe('Atlas signed prices', () => {
  // A live reply of 2026-11-25 (TSLAB and NVDAB), trimmed to what is read.
  const payload = '0x000003a50013cfee8b7c08206fde00006b071410000003a60007b5d22393eb64b12600006b07140f02';
  const signature =
    '0xd044803627f1fe037aa96d5181bcc94ad73af682d5d263b845a3c8b29e2ddbd434345f719bba89096c6f27261fd7dde2e7bab0ab6dde1f72aecc36642b120ae61b';
  const body = (over: object = {}) =>
    JSON.stringify({
      data: {
        payload,
        signature,
        magicMarker: '0x7096',
        consensusScores: [{ feedId: '933', consensusScore: 0.926, consensusStatus: 'HEALTHY' }],
        ...over,
      },
    });

  it('reads the prices from the signed payload, and the quality reading beside it', () => {
    const r = decodeAtlasSigned(body());
    expect(r.payload).toBe(payload);
    expect(r.signature).toBe(signature);
    expect(r.prices).toEqual([
      { feedId: 933, answer: 365471203775618248670n, at: 1795626000, status: 'HEALTHY', score: 0.926 },
      { feedId: 934, answer: 142228781900157464870n, at: 1795625999 },
    ]);
    expect(atlasSignedBody([933, 934])).toBe('{"signed":true,"feedIds":["933","934"]}');
  });

  it('refuses a reply whose payload does not hold together', () => {
    expect(() => decodeAtlasSigned('nope')).toThrow(/not JSON/);
    expect(() => decodeAtlasSigned(JSON.stringify({ data: {} }))).toThrow(/no signed payload/);
    expect(() => decodeAtlasSigned(body({ payload: payload.slice(0, -2) + '03' }))).toThrow(/does not match its count/);
    expect(() => decodeAtlasSigned(body({ signature: '0x1234' }))).toThrow(/65 bytes/);
  });
});

describe("Atlas's own quality reading as a control", () => {
  const reply = (scores: object[]) =>
    JSON.stringify({ data: { payload: '0x', signature: '0x', consensusScores: scores } });
  it('holds a price only when Atlas rates its sources critical or split', () => {
    const body = reply([
      { feedId: '933', consensusScore: 0.95, consensusStatus: 'HEALTHY' },
      { feedId: '934', consensusScore: 0.7, consensusStatus: 'DEGRADED' },
      { feedId: '956', consensusScore: 0.3, consensusStatus: 'CRITICAL' },
      { feedId: '947', consensusScore: 0.5, consensusStatus: 'SPLIT_MARKET' },
    ]);
    expect(atlasQualityHolds(body, [933, 934, 956, 947, 999])).toEqual([
      '',
      '',
      'Atlas rates its sources critical',
      'Atlas rates its sources split market',
      '',
    ]);
  });
  it('is not a reply to go on: a refused or malformed one throws, for the caller to go without', () => {
    expect(() => atlasQualityHolds('nope', [933])).toThrow(/not JSON/);
    expect(() => atlasQualityHolds(JSON.stringify({ data: {} }), [933])).toThrow(/no quality reading/);
  });
});

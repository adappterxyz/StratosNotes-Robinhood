import { describe, expect, it } from 'vitest';
import {
  blockNumberBody,
  checkRound,
  decodeBlockNumber,
  decodeFeedBatch,
  feedBatchBody,
  HTTP_FEED_CHAINS,
  pinnedBlock,
  readingToRound,
} from '../src';

const TSLA = '0x4A1166a659A55625345e9515b32adECea5547C38';
const AMD = '0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72';
// A real reply from Robinhood Chain mainnet (TSLA / USD, block tag 'safe', 2026-10-24).
const TSLA_ROUND =
  '0x00000000000000000000000000000000000000000000000100000000000006c200000000000000000000000000000000000000000000000000000008a9b7ac08000000000000000000000000000000000000000000000000000000006adb882d000000000000000000000000000000000000000000000000000000006adb883900000000000000000000000000000000000000000000000100000000000006c2';
const EIGHT = '0x' + '8'.padStart(64, '0');

describe('feed reads over JSON-RPC (chains CRE has no EVM capability for)', () => {
  it('batches latestRoundData + decimals per feed at the block tag', () => {
    const body = JSON.parse(feedBatchBody([TSLA, AMD], 'safe'));
    expect(body).toHaveLength(4);
    expect(body[0]).toEqual({
      jsonrpc: '2.0',
      id: 0,
      method: 'eth_call',
      params: [{ to: TSLA, data: '0xfeaf968c' }, 'safe'],
    });
    expect(body[3]).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'eth_call',
      params: [{ to: AMD, data: '0x313ce567' }, 'safe'],
    });
  });

  it('decodes a real reply in any order, deterministically, and checks it like an EVM read', () => {
    const reply = JSON.stringify([
      { jsonrpc: '2.0', id: 1, result: EIGHT },
      { jsonrpc: '2.0', id: 0, result: TSLA_ROUND },
    ]);
    const [r] = decodeFeedBatch(reply, [TSLA]);
    expect(r).toEqual({
      roundId: String((1n << 64n) + 0x6c2n),
      answer: String(0x8a9b7ac08n),
      updatedAt: String(0x6adb8839n),
      answeredInRound: String((1n << 64n) + 0x6c2n),
      decimals: 8,
    });
    const { round, decimals } = readingToRound(r);
    // $372.32... at 8 decimals -> engine fixed point (10 decimals).
    expect(checkRound(round, decimals, 0x6adb8839 + 60, 86400, 1800)).toBe(0x8a9b7ac08n * 100n);
    expect(() => checkRound(round, decimals, 0x6adb8839 + 86400 + 1801, 86400, 1800)).toThrow(/stale/);
  });

  it('fails only the feed whose call failed, with a node-independent error', () => {
    const reply = JSON.stringify([
      { jsonrpc: '2.0', id: 0, result: TSLA_ROUND },
      { jsonrpc: '2.0', id: 1, result: EIGHT },
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'historical state 78516d48… is not available' } },
      { jsonrpc: '2.0', id: 3, result: EIGHT },
    ]);
    const [ok, bad] = decodeFeedBatch(reply, [TSLA, AMD]);
    expect('error' in ok).toBe(false);
    expect(bad).toEqual({ error: 'feed RPC: eth_call failed (code -32000)' });
    expect(() => readingToRound(bad)).toThrow('eth_call failed');
  });

  it('refuses a non-feed (empty result), a missing reply, a non-batch reply and non-JSON', () => {
    expect(
      decodeFeedBatch(
        JSON.stringify([
          { id: 0, result: '0x' },
          { id: 1, result: EIGHT },
        ]),
        [TSLA],
      )[0],
    ).toEqual({ error: expect.stringMatching(/malformed/) });
    expect(decodeFeedBatch(JSON.stringify([{ id: 0, result: TSLA_ROUND }]), [TSLA])[0]).toEqual({
      error: 'feed RPC: no reply',
    });
    expect(decodeFeedBatch(JSON.stringify({ id: null, error: { code: -32600 } }), [TSLA, AMD])).toEqual([
      { error: 'feed RPC: batch refused (code -32600)' },
      { error: 'feed RPC: batch refused (code -32600)' },
    ]);
    expect(decodeFeedBatch('<html>', [TSLA])).toEqual([{ error: 'feed RPC: reply is not JSON' }]);
  });

  it('decodes a negative answer as negative (checkRound refuses it)', () => {
    const neg = TSLA_ROUND.slice(0, 66) + 'f'.repeat(64) + TSLA_ROUND.slice(130);
    const [r] = decodeFeedBatch(
      JSON.stringify([
        { id: 0, result: neg },
        { id: 1, result: EIGHT },
      ]),
      [TSLA],
    );
    expect((r as { answer: string }).answer).toBe('-1');
    const { round, decimals } = readingToRound(r);
    expect(() => checkRound(round, decimals, 0x6adb8839, 86400, 1800)).toThrow(/non-positive/);
  });

  it('pins the read below the agreed head', () => {
    expect(JSON.parse(blockNumberBody())).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    expect(decodeBlockNumber('{"jsonrpc":"2.0","id":1,"result":"0x5c45eea"}')).toBe(0x5c45eea);
    expect(() => decodeBlockNumber('{"jsonrpc":"2.0","id":1,"error":{"code":-32603}}')).toThrow('code -32603');
    expect(pinnedBlock(0x5c45eea, 600)).toBe('0x' + (0x5c45eea - 600).toString(16));
    expect(pinnedBlock(10, 600)).toBe('0x0');
    expect(JSON.parse(feedBatchBody([TSLA], pinnedBlock(1000, 600)))[0].params[1]).toBe('0x190');
  });

  it('knows Robinhood Chain mainnet', () => {
    expect(HTTP_FEED_CHAINS['robinhood-mainnet']).toEqual({
      rpc: 'https://rpc.mainnet.chain.robinhood.com',
      chainId: 4663,
      lagBlocks: 600,
    });
  });
});

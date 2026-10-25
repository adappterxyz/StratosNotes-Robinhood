/**
 * An in-memory EVM chain for indexer tests: blocks of FlowEngine logs (encoded with the real ABI, so the
 * indexer's decoder runs for real), with a `reorg` that replaces blocks from a height on.
 */
import { encodeAbiParameters, keccak256, toEventSelector, toHex, type Hex } from 'viem';
import { flowEngineAbi } from '@sn/sdk';
import type { ChainSource, RawLog } from '../src/source';

type EventName = Extract<(typeof flowEngineAbi)[number], { type: 'event' }>['name'];
export interface FakeEvent {
  eventName: EventName;
  args: Record<string, unknown>;
}
interface Block {
  number: bigint;
  hash: string;
  ts: number;
  events: FakeEvent[];
  salt: string;
}

export function encodeLog(e: FakeEvent): { data: Hex; topics: Hex[] } {
  const ev = flowEngineAbi.find((x) => x.type === 'event' && x.name === e.eventName) as Extract<
    (typeof flowEngineAbi)[number],
    { type: 'event' }
  >;
  // Topics by hand: viem's encodeEventTopics treats a zero argument as "any" (null).
  const topics = [
    toEventSelector(ev as never),
    ...ev.inputs.filter((i) => i.indexed).map((i) => encodeAbiParameters([i] as never, [e.args[i.name!]] as never)),
  ];
  const data = ev.inputs.filter((i) => !i.indexed);
  return { topics, data: encodeAbiParameters(data as never, data.map((i) => e.args[i.name!]) as never) };
}

export class FakeChain implements ChainSource {
  blocks: Block[] = [];
  cores = new Map<string, Hex>();
  fallbackHistory: Array<{ block: bigint; reporter: string }> = [];

  constructor(public genesisTs = 1_700_000_000) {
    this.mine([], 'genesis');
  }

  private hashOf(n: bigint, salt: string, events: FakeEvent[]) {
    return keccak256(
      toHex(`${n}:${salt}:${JSON.stringify(events, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`),
    ).toLowerCase();
  }

  mine(events: FakeEvent[], salt = 'a'): bigint {
    const number = BigInt(this.blocks.length);
    this.blocks.push({
      number,
      hash: this.hashOf(number, salt, events),
      ts: this.genesisTs + Number(number) * 2,
      events,
      salt,
    });
    return number;
  }

  /** Drop blocks >= `from` and mine `replacement` (one block each) in their place. */
  reorg(from: bigint, replacement: FakeEvent[][], salt = 'b') {
    this.blocks = this.blocks.slice(0, Number(from));
    for (const evs of replacement) this.mine(evs, salt);
  }

  async head() {
    return BigInt(this.blocks.length - 1);
  }
  async finalized() {
    return null;
  }
  async block(n: bigint) {
    const b = this.blocks[Number(n)];
    return b ? { hash: b.hash, ts: b.ts } : null;
  }
  async logs(from: bigint, to: bigint): Promise<RawLog[]> {
    const out: RawLog[] = [];
    for (const b of this.blocks.slice(Number(from), Number(to) + 1)) {
      b.events.forEach((e, i) => {
        const { data, topics } = encodeLog(e);
        out.push({
          block: b.number,
          blockHash: b.hash,
          logIndex: i,
          tx: keccak256(toHex(`${b.hash}:tx`)),
          data,
          topics,
        }); // one transaction per block: a step's events share it
      });
    }
    return out;
  }
  async definitionCore(id: string) {
    const c = this.cores.get(id);
    if (!c) throw new Error(`no definition ${id}`);
    return c;
  }
  async fallbackReporterAt() {
    return '0x0000000000000000000000000000000000000000';
  }
}

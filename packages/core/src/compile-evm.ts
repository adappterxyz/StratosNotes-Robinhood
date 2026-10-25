/**
 * The compiled workflow's canonical byte form, as the EVM engine
 * (packages/evm-engine/src/FlowEngine.sol) reads it.
 *
 * Why not the hackathon's Borsh form: Borsh is a sequence of variable-length
 * records, so reading step 37 means decoding everything before it. Solidity
 * would pay for that on every call. This form is the same WorkflowDef, split in
 * two:
 *
 *  - CORE: everything the engine executes, in fixed-width big-endian records
 *    behind offset tables. The engine copies it into memory once per
 *    transaction (one EXTCODECOPY from its SSTORE2 pointers) and then reads any
 *    step, expression or field kind directly by offset. No names and no strings:
 *    it stays a few KiB.
 *  - META: what people and apps need and the engine never reads (workflow name,
 *    term-sheet JSON, role, field, asset and step names), as UTF-8 JSON. The
 *    engine does not store it: it emits it once, in DefinitionRegistered, for the
 *    indexer.
 *
 * bytes = CORE ‖ META. A definition's id on every chain is sha256(bytes), so
 * the id covers the names as well as the logic. The engine checks it with the
 * sha256 precompile when the definition is sealed.
 *
 * CORE layout (all integers big-endian; offsets absolute from byte 0, u16, so
 * CORE < 64 KiB):
 *
 *   header (12)   version u8 | nRoles u8 | nFields u8 | nAssets u8 | nExprs u16 | nSteps u16 | coreLen u32
 *   roleFlags     nRoles × u8    (bit 0: escrow, an account the engine holds for the note)
 *   fieldKinds    nFields × u8
 *   assets        nAssets × (kind u8, decimals u8)
 *   exprOffsets   nExprs × u16   -> program: nOps u8, then nOps × (code u8, field u16, value i64)   [11 bytes/op]
 *                 (code 18 balance: field = role << 8 | asset; code 19 now)
 *   stepOffsets   nSteps × u16   -> step record:
 *       kind u8 | role u8 | join u8 | flags u8 (1 = timer, 2 = until, high nibble = milestone) | guard u16
 *       | nCaptures u8 | nOps u8 | nNext u8 | nSends u8                                    [10]
 *       | timer (kind u8, at i64, field u16)            if flags & 1                         [11]
 *       | until (kind u8, at i64, field u16)            if flags & 2                         [11]
 *       | captures × (field u16, source u8, expr u16, min i64, max i64)                      [21 each]
 *       | ops × (kind u8, asset u8, from u8, to u8, amount u16, asset2 u8, from2 u8,
 *                to2 u8, amount2 u16, retire u8)                                            [12 each]
 *       | next × (target u16, cond u16, isDefault u8)                                        [5 each]
 *       | sends × u16                                                                         [2 each]
 */
import type { Due, StepDef, WorkflowDef } from './def-types';

export const EVM_DEF_VERSION = 3;
export const EVM_HEADER = 12;

class W {
  parts: number[] = [];
  get length() {
    return this.parts.length;
  }
  u8(v: number) {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`u8 out of range: ${v}`);
    this.parts.push(v);
  }
  u16(v: number) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`u16 out of range: ${v}`);
    this.parts.push(v >> 8, v & 0xff);
  }
  u32(v: number) {
    for (let i = 3; i >= 0; i--) this.parts.push((v >>> (8 * i)) & 0xff);
  }
  i64(v: bigint) {
    if (v < -(2n ** 63n) || v >= 2n ** 63n) throw new Error(`i64 out of range: ${v}`);
    let x = BigInt.asUintN(64, v);
    const b: number[] = [];
    for (let i = 0; i < 8; i++) {
      b.unshift(Number(x & 0xffn));
      x >>= 8n;
    }
    this.parts.push(...b);
  }
  set16(at: number, v: number) {
    this.parts[at] = v >> 8;
    this.parts[at + 1] = v & 0xff;
  }
  set32(at: number, v: number) {
    for (let i = 0; i < 4; i++) this.parts[at + i] = (v >>> (8 * (3 - i))) & 0xff;
  }
}

/** The names and term sheet: everything the engine never reads. */
interface Meta {
  v: 1;
  name: string;
  meta: string;
  roles: string[];
  fields: string[];
  assets: string[];
  steps: string[];
}

export function encodeEvmDef(d: WorkflowDef): Uint8Array {
  if (d.roles.length > 255 || d.fields.length > 255 || d.assets.length > 255)
    throw new Error('too many roles, fields or assets');
  const w = new W();
  w.u8(EVM_DEF_VERSION);
  w.u8(d.roles.length);
  w.u8(d.fields.length);
  w.u8(d.assets.length);
  w.u16(d.exprs.length);
  w.u16(d.steps.length);
  w.u32(0); // coreLen, patched below
  d.roles.forEach((_, i) => w.u8(d.roleFlags?.[i] ?? 0));
  d.fields.forEach((f) => w.u8(f.kind));
  d.assets.forEach((a) => {
    w.u8(a.kind);
    w.u8(a.decimals);
  });
  const exprTable = w.length;
  d.exprs.forEach(() => w.u16(0));
  const stepTable = w.length;
  d.steps.forEach(() => w.u16(0));
  d.exprs.forEach((prog, i) => {
    w.set16(exprTable + 2 * i, w.length);
    w.u8(prog.length);
    prog.forEach((o) => {
      w.u8(o.code);
      w.u16(o.field);
      w.i64(o.value);
    });
  });
  const due = (x: Due) => {
    w.u8(x.kind);
    w.i64(x.at);
    w.u16(x.field);
  };
  d.steps.forEach((s, i) => {
    w.set16(stepTable + 2 * i, w.length);
    if (s.milestone < 0 || s.milestone > 15) throw new Error(`milestone out of range: ${s.milestone}`);
    w.u8(s.kind);
    w.u8(s.role);
    w.u8(s.join);
    w.u8((s.timer ? 1 : 0) | (s.until ? 2 : 0) | ((s.milestone ?? 0) << 4));
    w.u16(s.guard);
    w.u8(s.captures.length);
    w.u8(s.ops.length);
    w.u8(s.next.length);
    w.u8(s.sends.length);
    if (s.timer) due(s.timer);
    if (s.until) due(s.until);
    s.captures.forEach((c) => {
      w.u16(c.field);
      w.u8(c.source);
      w.u16(c.expr);
      w.i64(c.min);
      w.i64(c.max);
    });
    s.ops.forEach((o) => {
      w.u8(o.kind);
      w.u8(o.asset);
      w.u8(o.fromRole);
      w.u8(o.toRole);
      w.u16(o.amount);
      w.u8(o.asset2);
      w.u8(o.fromRole2);
      w.u8(o.toRole2);
      w.u16(o.amount2);
      w.u8(o.retire ? 1 : 0);
    });
    s.next.forEach((e) => {
      w.u16(e.target);
      w.u16(e.cond);
      w.u8(e.isDefault ? 1 : 0);
    });
    s.sends.forEach((t) => w.u16(t));
  });
  if (w.length > 0xffff) throw new Error(`definition core is ${w.length} bytes; the limit is 65,535`);
  w.set32(8, w.length);
  const meta: Meta = {
    v: 1,
    name: d.name,
    meta: d.meta,
    roles: d.roles,
    fields: d.fields.map((f) => f.name),
    assets: d.assets.map((a) => a.name),
    steps: d.steps.map((s) => s.id),
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(w.length + metaBytes.length);
  out.set(w.parts, 0);
  out.set(metaBytes, w.length);
  return out;
}

/** Length of the CORE part of encoded definition bytes. */
export function evmCoreLength(bytes: Uint8Array): number {
  return ((bytes[8] << 24) >>> 0) + (bytes[9] << 16) + (bytes[10] << 8) + bytes[11];
}

export function decodeEvmDef(bytes: Uint8Array): WorkflowDef {
  let o = 0;
  const u8 = () => bytes[o++];
  const u16 = () => {
    const v = (bytes[o] << 8) | bytes[o + 1];
    o += 2;
    return v;
  };
  const i64 = () => {
    let x = 0n;
    for (let i = 0; i < 8; i++) x = (x << 8n) | BigInt(bytes[o + i]);
    o += 8;
    return BigInt.asIntN(64, x);
  };
  if (u8() !== EVM_DEF_VERSION) throw new Error('not an EVM workflow definition');
  const nRoles = u8(),
    nFields = u8(),
    nAssets = u8(),
    nExprs = u16(),
    nSteps = u16();
  const coreLen = evmCoreLength(bytes);
  o = EVM_HEADER;
  const m = JSON.parse(new TextDecoder().decode(bytes.subarray(coreLen))) as Meta;
  const roleFlags = Array.from({ length: nRoles }, u8);
  const fieldKinds = Array.from({ length: nFields }, u8);
  const assets = Array.from({ length: nAssets }, (_, i) => ({ name: m.assets[i], kind: u8(), decimals: u8() }));
  const exprOff = Array.from({ length: nExprs }, u16);
  const stepOff = Array.from({ length: nSteps }, u16);
  const exprs = exprOff.map((at) => {
    o = at;
    return Array.from({ length: u8() }, () => ({ code: u8(), field: u16(), value: i64() }));
  });
  const due = (): Due => ({ kind: u8(), at: i64(), field: u16() });
  const steps = stepOff.map((at, i): StepDef => {
    o = at;
    const kind = u8(),
      role = u8(),
      join = u8(),
      flags = u8(),
      guard = u16();
    const nc = u8(),
      no = u8(),
      nn = u8(),
      ns = u8();
    const timer = flags & 1 ? due() : null;
    const until = flags & 2 ? due() : null;
    const captures = Array.from({ length: nc }, () => ({
      field: u16(),
      source: u8(),
      expr: u16(),
      min: i64(),
      max: i64(),
    }));
    const ops = Array.from({ length: no }, () => ({
      kind: u8(),
      asset: u8(),
      fromRole: u8(),
      toRole: u8(),
      amount: u16(),
      asset2: u8(),
      fromRole2: u8(),
      toRole2: u8(),
      amount2: u16(),
      retire: u8() !== 0,
    }));
    const next = Array.from({ length: nn }, () => ({ target: u16(), cond: u16(), isDefault: u8() !== 0 }));
    const sends = Array.from({ length: ns }, u16);
    return { id: m.steps[i], kind, role, timer, guard, captures, ops, until, next, sends, join, milestone: flags >> 4 };
  });
  if (m.roles.length !== nRoles) throw new Error('definition meta does not match its core');
  return {
    version: 1,
    name: m.name,
    meta: m.meta,
    roles: m.roles,
    roleFlags,
    fields: fieldKinds.map((kind, i) => ({ name: m.fields[i], kind })),
    assets,
    exprs,
    steps,
  };
}

// ---- ABI helpers for what the engine is sent (no dependency on viem, so the CRE workflow can bundle this) ----

const word = (v: bigint) => BigInt.asUintN(256, v).toString(16).padStart(64, '0');

/**
 * A CRE report: abi.encode(uint256 processId, uint16 step, int256[] values).
 * step 0xFFFF = just advance (due timers); 0xFFFE is reserved for cross-chain payouts.
 */
export function encodeEvmReport(processId: bigint, step: number, values: bigint[]): Uint8Array {
  const hex =
    word(processId) + word(BigInt(step)) + word(96n) + word(BigInt(values.length)) + values.map(word).join('');
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** One step input as the engine takes it: (uint8 tag, bytes32 data). */
export interface EvmInput {
  tag: number;
  data: `0x${string}`;
}
export const evmInput = {
  /** Fixed-point decimals (10 places) and plain integers (dates, ints, bools). */
  number: (v: bigint): EvmInput => ({ tag: 1, data: `0x${word(v)}` }),
  /** UTF-8, up to 32 bytes, left-aligned. */
  text: (s: string): EvmInput => {
    const b = new TextEncoder().encode(s);
    if (b.length > 32) throw new Error('text inputs are at most 32 bytes');
    return {
      tag: 2,
      data: `0x${Array.from(b, (x: number) => x.toString(16).padStart(2, '0'))
        .join('')
        .padEnd(64, '0')}`,
    };
  },
  /** An address, right-aligned. */
  party: (addr: string): EvmInput => ({ tag: 3, data: `0x${addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` }),
};

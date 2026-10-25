/**
 * Compile a workflow IR into the engine's WorkflowDef (programs/flow_engine/
 * src/def.rs) and its Borsh bytes. The definition is content-addressed: its
 * on-chain address is derived from the SHA-256 of these bytes, so the same
 * workflow compiles to the same account (Flow's __PKGHASH__, on Solana).
 */
import { sha256 } from '@noble/hashes/sha256';
import { compileExpr, compilePred, parseExpr, parsePred, RESERVED_WORDS, type AccountResolver, type Op } from './expr';
import { dec } from './decimal';
import { encodeEvmDef } from './compile-evm';
import {
  MILESTONES,
  openPoolIds,
  type AssetOperation,
  type IrNode,
  type Issue,
  type TemplateField,
  type WorkflowIR,
} from './types';

export const DEF_VERSION = 1;
export const NO_EXPR = 0xffff;

export const KIND = { START: 0, END: 1, USER: 2, SERVICE: 3, RECEIVE: 4, XOR: 5, AND: 6, CATCH: 7 } as const;
export const FKIND = { Decimal: 0, Int: 1, Date: 2, Text: 3, Party: 4, Bool: 5 } as const;
export const SRC = { INPUT: 0, ORACLE: 1, EXPR: 2 } as const;
export const OP = { NONE: 0, MINT: 1, BURN: 2, TRANSFER: 3, SWAP: 4, DEPOSIT: 5, DISTRIBUTE: 6 } as const;
export const AKIND = { issued: 0, cash: 1 } as const;
export const CARRIED = '__carried__';
/** Role flags (WorkflowDef.roleFlags). */
export const ROLE_ESCROW = 1;
/** Engine caps (FlowEngine.MAX_*): a definition past them is refused on-chain, so compile refuses it first. */
export const LIMITS = { roles: 8, fields: 64, assets: 8, coreBytes: 24_575 } as const;

export type { Due, Capture, AssetOpDef, Edge, StepDef, WorkflowDef } from './def-types';
import type { Due, Capture, AssetOpDef, StepDef, WorkflowDef } from './def-types';

export interface Compiled {
  def: WorkflowDef;
  bytes: Uint8Array;
  hash: Uint8Array;
  /** Node id -> step index; field name -> index; role (pool) name -> index. */
  stepIndex: Record<string, number>;
  fieldIndex: Record<string, number>;
  roleIndex: Record<string, number>;
  assetIndex: Record<string, number>;
}

export class CompileError extends Error {
  constructor(public issues: Issue[]) {
    super(issues.map((i) => i.message).join('; '));
  }
}

/** Unix seconds from an ISO date/time or a number string. */
export function toUnix(v: string): bigint {
  if (/^\d+$/.test(v.trim())) return BigInt(v.trim());
  const t = Date.parse(/T/.test(v) ? v : `${v}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`not a date: ${v}`);
  return BigInt(Math.floor(t / 1000));
}

export function compile(ir: WorkflowIR, meta: unknown = {}): Compiled {
  const issues: Issue[] = [];
  const bad = (code: string, message: string, nodeId?: string) => {
    issues.push({ code, message, nodeId });
    return 0;
  };

  // Fields: every template field across the workflow, one slot each.
  const fields: Array<{ name: string; kind: number }> = [];
  const fieldIndex: Record<string, number> = {};
  for (const n of ir.nodes)
    for (const f of n.props.templateFields ?? []) {
      const k = FKIND[f.type];
      if (k === undefined) {
        bad('FIELD_TYPE', `${n.name}: unknown field type ${f.type}`, n.id);
        continue;
      }
      if (RESERVED_WORDS.includes(f.name)) {
        bad('FIELD_RESERVED', `'${f.name}' is a reserved word in expressions; rename the field`, n.id);
        continue;
      }
      if (f.name in fieldIndex) {
        if (fields[fieldIndex[f.name]].kind !== k)
          bad('FIELD_TYPE_CONFLICT', `Field '${f.name}' is declared with two types`, n.id);
        continue;
      }
      fieldIndex[f.name] = fields.length;
      fields.push({ name: f.name, kind: k });
    }
  const fieldOf = (name: string, nodeId?: string) => {
    if (!(name in fieldIndex)) {
      bad('UNKNOWN_FIELD', `'${name}' is not a workflow field`, nodeId);
      return 0;
    }
    return fieldIndex[name];
  };

  const roleIndex: Record<string, number> = {};
  ir.pools.forEach((p, i) => {
    roleIndex[p.name] = i;
    roleIndex[p.id] = i;
  });
  const roleOf = (name: string | undefined, nodeId: string) => {
    if (!name || !(name in roleIndex)) return bad('UNKNOWN_ROLE', `'${name ?? ''}' is not a pool`, nodeId);
    return roleIndex[name];
  };
  const assetIndex: Record<string, number> = {};
  ir.assets.forEach((a, i) => {
    assetIndex[a.id] = i;
  });
  const assetOf = (id: string | undefined, nodeId: string) => {
    if (!id || !(id in assetIndex)) return bad('UNKNOWN_ASSET', `'${id ?? ''}' is not a defined asset`, nodeId);
    return assetIndex[id];
  };

  // Expressions, de-duplicated.
  const exprs: Op[][] = [];
  const exprKey = new Map<string, number>();
  const intern = (ops: Op[]) => {
    const k = JSON.stringify(ops, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    if (!exprKey.has(k)) {
      exprKey.set(k, exprs.length);
      exprs.push(ops);
    }
    return exprKey.get(k)!;
  };
  // balance(Pool, asset): a pool by name or id that has an account (not an open role), an asset by id.
  const openPools = openPoolIds(ir);
  const accounts = (nodeId: string): AccountResolver => ({
    role: (name) => {
      const pool = ir.pools.find(
        (p) => p.name === name || p.id === name || p.name.replace(/[^A-Za-z0-9_]/g, '') === name,
      );
      if (!pool) return bad('UNKNOWN_ROLE', `balance(${name}, ...): '${name}' is not a pool`, nodeId);
      if (openPools.has(pool.id))
        return bad(
          'OPEN_ROLE_BALANCE',
          `balance(${name}, ...): '${pool.name}' is open to anyone, so it has no single account to read`,
          nodeId,
        );
      return roleIndex[pool.name];
    },
    asset: (name) => assetOf(name, nodeId),
  });
  const expr = (src: string, nodeId: string) => {
    const r = parseExpr(src);
    if (!r.ok) return bad('BAD_EXPR', `'${src}': ${r.error}`, nodeId);
    return intern(compileExpr(r.ast, (n) => fieldOf(n, nodeId), accounts(nodeId)));
  };
  const pred = (src: string, nodeId: string) => {
    const r = parsePred(src);
    if (!r.ok) return bad('BAD_CONDITION', `'${src}': ${r.error}`, nodeId);
    return intern(compilePred(r.ast, (n) => fieldOf(n, nodeId), accounts(nodeId)));
  };
  const amountExpr = (
    src: AssetOperation['params']['amountSource'],
    literal: string | undefined,
    fieldName: string | undefined,
    e: string | undefined,
    nodeId: string,
  ) => {
    if (src === 'field') return expr(fieldName ?? '', nodeId);
    if (src === 'expr') return expr(e ?? '', nodeId);
    return expr(literal ?? '', nodeId);
  };
  const due = (t: { date?: string; dateField?: string } | undefined, nodeId: string): Due | null => {
    if (!t) return null;
    if (t.dateField) return { kind: 1, at: 0n, field: fieldOf(t.dateField, nodeId) };
    if (t.date) {
      try {
        return { kind: 0, at: toUnix(t.date), field: 0 };
      } catch {
        bad('BAD_TIMER', `timer date '${t.date}' is not a date`, nodeId);
      }
    }
    return null;
  };

  const stepIndex: Record<string, number> = {};
  ir.nodes.forEach((n, i) => {
    stepIndex[n.id] = i;
  });
  const flowById = new Map(ir.flows.map((f) => [f.id, f]));

  const op = (o: AssetOperation, n: IrNode): AssetOpDef => {
    const p = o.params ?? {};
    const none: AssetOpDef = {
      kind: OP.NONE,
      asset: 0,
      fromRole: 0,
      toRole: 0,
      amount: NO_EXPR,
      asset2: 0,
      fromRole2: 0,
      toRole2: 0,
      amount2: NO_EXPR,
      retire: false,
    };
    const asset = assetOf(o.assetId, n.id);
    const amt = () => amountExpr(p.amountSource, p.amount, p.amountField, p.amountExpr, n.id);
    const self = roleIndex[ir.pools.find((x) => x.id === n.pool)!.name];
    switch (o.operation) {
      case 'mint':
        return { ...none, kind: OP.MINT, asset, toRole: roleOf(p.owner, n.id), amount: amt() };
      case 'burn':
        return { ...none, kind: OP.BURN, asset, fromRole: roleOf(p.from ?? p.owner, n.id), amount: amt() };
      case 'transfer':
        return {
          ...none,
          kind: OP.TRANSFER,
          asset,
          fromRole: roleOf(p.from, n.id),
          toRole: roleOf(p.to, n.id),
          amount: amt(),
        };
      case 'deposit':
        return { ...none, kind: OP.DEPOSIT, asset, fromRole: self, amount: amt() };
      case 'swap': {
        const d = roleOf(p.deliveryParty, n.id),
          pay = roleOf(p.paymentParty, n.id);
        return {
          ...none,
          kind: OP.SWAP,
          asset,
          fromRole: d,
          toRole: pay,
          amount: amt(),
          asset2: assetOf(p.counterAssetId, n.id),
          fromRole2: pay,
          toRole2: d,
          amount2: amountExpr(p.counterAmountSource, p.counterAmount, p.counterAmountField, p.counterAmountExpr, n.id),
        };
      }
      case 'distribute':
        return {
          ...none,
          kind: OP.DISTRIBUTE,
          asset,
          fromRole: roleOf(p.payer, n.id),
          amount: amt(),
          asset2: assetOf(p.holdingAssetId, n.id),
          retire: !!p.retire,
        };
      default:
        bad('BAD_OPERATION', `${n.name}: unknown operation ${(o as AssetOperation).operation}`, n.id);
        return none;
    }
  };

  const capture = (f: TemplateField, n: IrNode): Capture | null => {
    const idx = fieldOf(f.name, n.id);
    if (f.formula === CARRIED) return null; // one process account: nothing to carry
    if (f.oracle) {
      try {
        return { field: idx, source: SRC.ORACLE, expr: NO_EXPR, min: dec(f.oracle.min), max: dec(f.oracle.max) };
      } catch {
        bad('BAD_ORACLE_BOUNDS', `${n.name}: oracle bounds for '${f.name}' must be numbers`, n.id);
        return null;
      }
    }
    if (f.formula) return { field: idx, source: SRC.EXPR, expr: expr(f.formula, n.id), min: 0n, max: 0n };
    return { field: idx, source: SRC.INPUT, expr: NO_EXPR, min: 0n, max: 0n };
  };

  const KIND_OF: Record<string, number> = {
    startEvent: KIND.START,
    endEvent: KIND.END,
    userTask: KIND.USER,
    serviceTask: KIND.SERVICE,
    task: KIND.SERVICE,
    sendTask: KIND.SERVICE,
    receiveTask: KIND.RECEIVE,
    exclusiveGateway: KIND.XOR,
    parallelGateway: KIND.AND,
    intermediateCatchEvent: KIND.CATCH,
  };

  const steps: StepDef[] = ir.nodes.map((n) => {
    const kind = KIND_OF[n.type];
    const ops = [...(n.props.assetOperation ? [n.props.assetOperation] : []), ...(n.props.assetOperations ?? [])].map(
      (o) => op(o, n),
    );
    return {
      id: n.id,
      kind,
      role:
        roleIndex[ir.pools.find((p) => p.id === n.pool)?.name ?? ''] ??
        bad('NO_POOL', `${n.name} is not in a pool`, n.id),
      timer: due(n.props.timer, n.id),
      guard: n.props.receiveGuard ? pred(n.props.receiveGuard, n.id) : NO_EXPR,
      captures: (n.props.templateFields ?? []).map((f) => capture(f, n)).filter((c): c is Capture => !!c),
      ops,
      until: due(n.props.until, n.id),
      next: n.outgoing.map((fid) => {
        const f = flowById.get(fid)!;
        return {
          target: stepIndex[f.target],
          cond: f.condition ? pred(f.condition, n.id) : NO_EXPR,
          isDefault: n.defaultFlow === fid,
        };
      }),
      // Notice flows are drawn for people, not token handoffs (types.ts IrMessageFlow).
      sends: ir.messageFlows
        .filter((m) => m.source === n.id && !m.notice && m.target in stepIndex)
        .map((m) => stepIndex[m.target]),
      join: kind === KIND.AND && n.incoming.length > 1 ? n.incoming.length : 0,
      milestone: n.props.milestone
        ? (MILESTONES[n.props.milestone] ??
          bad('BAD_MILESTONE', `${n.name}: unknown milestone '${n.props.milestone}'`, n.id))
        : 0,
    };
  });
  for (const p of ir.pools)
    if (p.escrow && ir.nodes.some((n) => n.pool === p.id))
      bad('ESCROW_STEPS', `Pool '${p.name}' is an escrow account: nobody acts in it, so it holds no steps`);
  if (ir.pools.length > LIMITS.roles)
    bad('TOO_MANY_POOLS', `${ir.pools.length} pools; the engine runs at most ${LIMITS.roles}`);
  if (fields.length > LIMITS.fields)
    bad(
      'TOO_MANY_FIELDS',
      `${fields.length} fields; the engine holds at most ${LIMITS.fields} per note (use fewer observations or underlyings)`,
    );
  if (ir.assets.length > LIMITS.assets)
    bad(
      'TOO_MANY_ASSETS',
      `${ir.assets.length} assets; the engine holds at most ${LIMITS.assets} per note (note, cash, deliverable tokens and collateral together)`,
    );

  if (issues.length) throw new CompileError(issues);
  // Which price feed backs each oracle field: the CRE workflow reads it here.
  const oracles: Record<string, { feed: string; feedChain?: string; staleness?: number }> = {};
  for (const n of ir.nodes)
    for (const f of n.props.templateFields ?? []) {
      if (f.oracle)
        oracles[f.name] = {
          feed: f.oracle.feed,
          ...(f.oracle.feedChain ? { feedChain: f.oracle.feedChain } : {}),
          ...(f.oracle.staleness ? { staleness: f.oracle.staleness } : {}),
        };
    }
  const def: WorkflowDef = {
    // Step names and pools, so any definition can be redrawn and labelled from chain alone.
    // Notifications (notify.ts) are for people: META only, so the engine runs the same CORE without them.
    version: DEF_VERSION,
    name: ir.name,
    meta: JSON.stringify({
      ...(meta as object),
      oracles,
      names: Object.fromEntries(ir.nodes.map((n) => [n.id, n.name])),
      ...(ir.nodes.some((n) => n.props.notify?.length)
        ? {
            notify: Object.fromEntries(
              ir.nodes.filter((n) => n.props.notify?.length).map((n) => [n.id, n.props.notify]),
            ),
          }
        : {}),
    }),
    roles: ir.pools.map((p) => p.name),
    roleFlags: ir.pools.map((p) => (p.escrow ? ROLE_ESCROW : 0)),
    fields,
    assets: ir.assets.map((a) => ({ name: a.name, kind: AKIND[a.kind], decimals: a.decimals ?? 0 })),
    exprs,
    steps,
  };
  const bytes = encodeDef(def);
  const coreLen = ((bytes[8] << 24) >>> 0) + (bytes[9] << 16) + (bytes[10] << 8) + bytes[11];
  if (coreLen > LIMITS.coreBytes)
    throw new CompileError([
      {
        code: 'TOO_LARGE',
        message: `The compiled workflow is ${coreLen.toLocaleString('en-US')} bytes; the engine stores at most ${LIMITS.coreBytes.toLocaleString('en-US')} (use fewer observations or underlyings)`,
      },
    ]);
  return { def, bytes, hash: sha256(bytes), stepIndex, fieldIndex, roleIndex, assetIndex };
}

// ---- Encoding: see compile-evm.ts (CORE for the engine ‖ META for people) ----

/** A workflow's canonical bytes (what its id hashes). */
export const encodeDef = encodeEvmDef;

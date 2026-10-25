/**
 * Flow expression language v1 (ported from Flow's compiler/expr.ts) plus its
 * compilation to the engine's RPN programs.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := NUMBER | IDENT | FN '(' expr (',' expr)+ ')' | 'balance' '(' ROLE ',' ASSET ')' | 'now'
 *            | '(' expr ')' | '-' factor
 *   FN      := 'min' | 'max'   (e.g. worst-of: min(eth / ethStrike, btc / btcStrike))
 *   balance(Escrow, cash): what a pool's account holds of an asset in this note, now (engine fixed point).
 *     Pools are named by their pool name or id; open pools (anyone) have no account and cannot be read.
 *   now: the block time, unix seconds (compare with Date fields: `now >= payDate + grace`).
 *   pred    := cmpChain (('or' | '||') cmpChain)*      ('and' binds tighter)
 *   cmpChain:= cmp (('and' | '&&') cmp)*
 *   cmp     := expr OP expr      OP in > < >= <= == !=
 */
import { dec } from './decimal';

export type ExprAst =
  | { k: 'num'; v: string }
  | { k: 'ref'; name: string }
  | { k: 'neg'; a: ExprAst }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: ExprAst; b: ExprAst }
  | { k: 'fn'; f: 'min' | 'max'; a: ExprAst; b: ExprAst }
  | { k: 'bal'; role: string; asset: string }
  | { k: 'now' };

/** Words the language reserves: no field may be named after them. */
export const RESERVED_WORDS = ['min', 'max', 'balance', 'now', 'and', 'or'];

export type PredAst =
  | { k: 'cmp'; op: '>' | '<' | '>=' | '<=' | '==' | '!='; a: ExprAst; b: ExprAst }
  | { k: 'and'; a: PredAst; b: PredAst }
  | { k: 'or'; a: PredAst; b: PredAst }
  | { k: 'not'; a: PredAst };

/** `refs`: the fields an expression reads; `balances`: the "Role.asset" accounts it reads. */
export type Parsed<T> =
  { ok: true; ast: T; refs: string[]; balances: string[] } | { ok: false; error: string; pos: number };

export function parseExpr(src: string): Parsed<ExprAst> {
  const s = src.trim();
  let i = 0;
  const refs = new Set<string>();
  const bals = new Set<string>();
  let err: { ok: false; error: string; pos: number } | null = null;
  const fail = (error: string) => {
    err = { ok: false, error, pos: i };
    return null;
  };
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };

  function factor(): ExprAst | null {
    ws();
    if (i >= s.length) return fail('unexpected end of expression');
    const c = s[i];
    if (c === '(') {
      i++;
      const e = expr();
      if (!e) return null;
      ws();
      if (s[i] !== ')') return fail("expected ')'");
      i++;
      return e;
    }
    if (c === '-') {
      i++;
      const f = factor();
      return f ? { k: 'neg', a: f } : null;
    }
    const num = /^[0-9]+(\.[0-9]+)?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return { k: 'num', v: num[0] };
    }
    const id = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i));
    if (id) {
      i += id[0].length;
      ws();
      if (id[0] === 'balance' && s[i] === '(') {
        i++;
        ws();
        const role = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i));
        if (!role) return fail('balance(...) needs a pool name first, e.g. balance(Escrow, cash)');
        i += role[0].length;
        ws();
        if (s[i] !== ',') return fail("expected ',' after the pool in balance(...)");
        i++;
        ws();
        const asset = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i));
        if (!asset) return fail('balance(...) needs an asset id second, e.g. balance(Escrow, cash)');
        i += asset[0].length;
        ws();
        if (s[i] !== ')') return fail("expected ')' after balance(pool, asset)");
        i++;
        bals.add(`${role[0]}.${asset[0]}`);
        return { k: 'bal', role: role[0], asset: asset[0] };
      }
      if (id[0] === 'now') return { k: 'now' };
      if ((id[0] === 'min' || id[0] === 'max') && s[i] === '(') {
        i++;
        const args: ExprAst[] = [];
        for (;;) {
          const e = expr();
          if (!e) return null;
          args.push(e);
          ws();
          if (s[i] === ',') {
            i++;
            continue;
          }
          if (s[i] === ')') {
            i++;
            break;
          }
          return fail(`expected ',' or ')' in ${id[0]}(...)`);
        }
        if (args.length < 2) return fail(`${id[0]}(...) needs at least two values`);
        const f = id[0] as 'min' | 'max';
        return args.slice(1).reduce<ExprAst>((a, b) => ({ k: 'fn', f, a, b }), args[0]);
      }
      refs.add(id[0]);
      return { k: 'ref', name: id[0] };
    }
    return fail(`unexpected character '${c}'`);
  }
  function term(): ExprAst | null {
    let a = factor();
    while (a) {
      ws();
      const op = s[i];
      if (op === '*' || op === '/') {
        i++;
        const b = factor();
        if (!b) return null;
        a = { k: 'bin', op, a, b };
      } else break;
    }
    return a;
  }
  function expr(): ExprAst | null {
    let a = term();
    while (a) {
      ws();
      const op = s[i];
      if (op === '+' || op === '-') {
        i++;
        const b = term();
        if (!b) return null;
        a = { k: 'bin', op, a, b };
      } else break;
    }
    return a;
  }
  const ast = expr();
  if (err) return err;
  if (!ast) return { ok: false, error: 'empty expression', pos: i };
  ws();
  if (i < s.length) return { ok: false, error: `unexpected trailing input '${s.slice(i)}'`, pos: i };
  return { ok: true, ast, refs: [...refs].sort(), balances: [...bals].sort() };
}

function splitTopLevel(s: string, symbols: string[], words: string[]): string[] {
  const parts: string[] = [];
  let depth = 0,
    start = 0,
    i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      let m: string | null = symbols.find((o) => s.startsWith(o, i)) ?? null;
      if (!m)
        m =
          words.find(
            (w) =>
              s.startsWith(w, i) &&
              (i === 0 || !/\w/.test(s[i - 1])) &&
              (i + w.length >= s.length || !/\w/.test(s[i + w.length])),
          ) ?? null;
      if (m) {
        parts.push(s.slice(start, i));
        i += m.length;
        start = i;
        continue;
      }
    }
    i++;
  }
  parts.push(s.slice(start));
  return parts;
}

const CMP = ['>=', '<=', '==', '!=', '>', '<'] as const;

function parseCmp(src: string): Parsed<PredAst> {
  let depth = 0;
  let found: { op: (typeof CMP)[number]; at: number } | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')') {
      depth--;
      continue;
    }
    if (depth) continue;
    const op = CMP.find((o) => src.startsWith(o, i));
    if (op) {
      if (found) return { ok: false, error: 'more than one comparison in one term (combine with and/or)', pos: i };
      found = { op, at: i };
      i += op.length - 1;
    }
  }
  if (!found) return { ok: false, error: 'expected a comparison (>, <, >=, <=, ==, !=)', pos: 0 };
  const a = parseExpr(src.slice(0, found.at));
  if (!a.ok) return { ok: false, error: `left of ${found.op}: ${a.error}`, pos: a.pos };
  const b = parseExpr(src.slice(found.at + found.op.length));
  if (!b.ok) return { ok: false, error: `right of ${found.op}: ${b.error}`, pos: found.at + b.pos };
  return {
    ok: true,
    ast: { k: 'cmp', op: found.op, a: a.ast, b: b.ast },
    refs: [...new Set([...a.refs, ...b.refs])].sort(),
    balances: [...new Set([...a.balances, ...b.balances])].sort(),
  };
}

export function parsePred(src: string): Parsed<PredAst> {
  const s = src.trim();
  if (!s) return { ok: false, error: 'empty condition', pos: 0 };
  let ast: PredAst | null = null;
  const refs = new Set<string>();
  const bals = new Set<string>();
  for (const orPart of splitTopLevel(s, ['||'], ['or'])) {
    let and: PredAst | null = null;
    for (const atom of splitTopLevel(orPart, ['&&'], ['and'])) {
      if (!atom.trim()) return { ok: false, error: 'empty term beside and/or', pos: 0 };
      const c = parseCmp(atom);
      if (!c.ok) return c;
      c.refs.forEach((r) => refs.add(r));
      c.balances.forEach((b) => bals.add(b));
      and = and ? { k: 'and', a: and, b: c.ast } : c.ast;
    }
    if (!and) return { ok: false, error: 'empty term beside and/or', pos: 0 };
    ast = ast ? { k: 'or', a: ast, b: and } : and;
  }
  return ast
    ? { ok: true, ast, refs: [...refs].sort(), balances: [...bals].sort() }
    : { ok: false, error: 'empty condition', pos: 0 };
}

export type { Op } from './op';
import type { Op } from './op';

const BIN: Record<string, number> = { '+': 2, '-': 3, '*': 4, '/': 5 };
const FN: Record<string, number> = { min: 16, max: 17 };
const CMPC: Record<string, number> = { '<': 7, '<=': 8, '>': 9, '>=': 10, '==': 11, '!=': 12 };
/** balance(role, asset): op 18, field = role << 8 | asset. now: op 19. */
export const OP_BALANCE = 18;
export const OP_NOW = 19;

/** Resolves a pool name to its role index and an asset id to its index (for balance(...)). */
export interface AccountResolver {
  role: (name: string) => number;
  asset: (name: string) => number;
}
const noAccounts: AccountResolver = {
  role: (n) => {
    throw new Error(`balance(${n}, ...) is not available here`);
  },
  asset: (n) => {
    throw new Error(`balance(..., ${n}) is not available here`);
  },
};

/** Compile to RPN; `fieldIndex` resolves a field name (throws if unknown). */
export function compileExpr(
  ast: ExprAst,
  fieldIndex: (name: string) => number,
  accounts: AccountResolver = noAccounts,
): Op[] {
  const out: Op[] = [];
  const walk = (n: ExprAst): void => {
    if (n.k === 'num') {
      const v = dec(n.v);
      if (v > 2n ** 63n - 1n) throw new Error(`constant ${n.v} is too large (max about 922 million)`);
      out.push({ code: 0, field: 0, value: v });
    } else if (n.k === 'ref') out.push({ code: 1, field: fieldIndex(n.name), value: 0n });
    else if (n.k === 'bal')
      out.push({ code: OP_BALANCE, field: (accounts.role(n.role) << 8) | accounts.asset(n.asset), value: 0n });
    else if (n.k === 'now') out.push({ code: OP_NOW, field: 0, value: 0n });
    else if (n.k === 'neg') {
      walk(n.a);
      out.push({ code: 6, field: 0, value: 0n });
    } else if (n.k === 'fn') {
      walk(n.a);
      walk(n.b);
      out.push({ code: FN[n.f], field: 0, value: 0n });
    } else {
      walk(n.a);
      walk(n.b);
      out.push({ code: BIN[n.op], field: 0, value: 0n });
    }
  };
  walk(ast);
  return out;
}

export function compilePred(
  ast: PredAst,
  fieldIndex: (name: string) => number,
  accounts: AccountResolver = noAccounts,
): Op[] {
  const out: Op[] = [];
  const walk = (n: PredAst): void => {
    if (n.k === 'cmp') {
      out.push(...compileExpr(n.a, fieldIndex, accounts), ...compileExpr(n.b, fieldIndex, accounts), {
        code: CMPC[n.op],
        field: 0,
        value: 0n,
      });
    } else if (n.k === 'not') {
      walk(n.a);
      out.push({ code: 15, field: 0, value: 0n });
    } else {
      walk(n.a);
      walk(n.b);
      out.push({ code: n.k === 'and' ? 13 : 14, field: 0, value: 0n });
    }
  };
  walk(ast);
  return out;
}

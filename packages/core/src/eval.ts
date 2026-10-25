/**
 * The engine's expression evaluator in TypeScript, op for op (FlowEngine._eval): RPN over 10-decimal fixed
 * point, truncation toward zero, comparisons yield SCALE or 0. Apps use it to know an amount before sending a
 * transaction, e.g. how much stablecoin a deposit step will pull (so the wallet approves exactly that).
 */
import { SCALE } from './decimal';
import type { Op } from './op';

const F_DECIMAL = 0,
  F_INT = 1,
  F_DATE = 2,
  F_BOOL = 5;

/** What an expression may read besides fields: account balances (balance(role, asset)) and the time. */
export interface EvalEnv {
  /** A role's balance of an asset, engine fixed point; null when unknown (an open role has no account). */
  balance?: (role: number, asset: number) => bigint | null;
  /** Unix seconds (FlowEngine reads block.timestamp). */
  now?: () => number;
}

/**
 * `value(f)`: field f's raw value (engine form: fixed point for decimals, plain for ints/dates), or null if unset.
 * Null as a result: something the expression reads is not known yet (the engine waits in that case).
 */
export function evalExpr(
  ops: Op[],
  fieldKinds: number[],
  value: (field: number) => bigint | null,
  env: EvalEnv = {},
): bigint | null {
  const st: bigint[] = [];
  for (const op of ops) {
    if (op.code === 0) {
      st.push(op.value);
      continue;
    }
    if (op.code === 18) {
      const b = env.balance ? env.balance(op.field >> 8, op.field & 0xff) : null;
      if (b === null) return null;
      st.push(b);
      continue;
    }
    if (op.code === 19) {
      if (!env.now) return null;
      st.push(BigInt(Math.floor(env.now())) * SCALE);
      continue;
    }
    if (op.code === 1) {
      const raw = value(op.field);
      if (raw === null) return null;
      const kind = fieldKinds[op.field];
      if (kind === F_DECIMAL) st.push(raw);
      else if (kind === F_INT || kind === F_DATE || kind === F_BOOL) st.push(raw * SCALE);
      else return null; // text and parties have no number
      continue;
    }
    if (op.code === 6 || op.code === 15) {
      const x = st.pop();
      if (x === undefined) throw new Error('bad expression');
      st.push(op.code === 6 ? -x : x === 0n ? SCALE : 0n);
      continue;
    }
    const y = st.pop(),
      a = st.pop();
    if (a === undefined || y === undefined) throw new Error('bad expression');
    const t = (b: boolean) => (b ? SCALE : 0n);
    switch (op.code) {
      case 2:
        st.push(a + y);
        break;
      case 3:
        st.push(a - y);
        break;
      case 4:
        st.push((a * y) / SCALE);
        break;
      case 5:
        if (y === 0n) throw new Error('divide by zero');
        st.push((a * SCALE) / y);
        break;
      case 7:
        st.push(t(a < y));
        break;
      case 8:
        st.push(t(a <= y));
        break;
      case 9:
        st.push(t(a > y));
        break;
      case 10:
        st.push(t(a >= y));
        break;
      case 11:
        st.push(t(a === y));
        break;
      case 12:
        st.push(t(a !== y));
        break;
      case 13:
        st.push(t(a !== 0n && y !== 0n));
        break;
      case 14:
        st.push(t(a !== 0n || y !== 0n));
        break;
      case 16:
        st.push(a < y ? a : y);
        break;
      case 17:
        st.push(a > y ? a : y);
        break;
      default:
        throw new Error(`bad expression op ${op.code}`);
    }
  }
  if (st.length !== 1) throw new Error('bad expression');
  return st[0];
}

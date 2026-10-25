/**
 * 10-decimal fixed point as bigint: the engine's number type (solana
 * programs/flow_engine/src/expr.rs). Multiplication and division truncate
 * toward zero, exactly like the program.
 */
export const SCALE = 10_000_000_000n;

export function dec(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v * SCALE;
  const s = typeof v === 'number' ? v.toFixed(10) : v.trim();
  const m = s.match(/^(-)?(\d+)(?:\.(\d*))?$/);
  if (!m) throw new Error(`not a decimal: ${v}`);
  const frac = (m[3] ?? '').slice(0, 10).padEnd(10, '0');
  const x = BigInt(m[2]) * SCALE + BigInt(frac || '0');
  return m[1] ? -x : x;
}

export function decToString(x: bigint): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

/** Truncating division toward zero (bigint `/` already truncates). */
export const mul = (a: bigint, b: bigint) => (a * b) / SCALE;
export const div = (a: bigint, b: bigint) => {
  if (b === 0n) throw new Error('division by zero');
  return (a * SCALE) / b;
};

/** Fixed point to SPL base units (truncated), as the program does. */
export const toBase = (x: bigint, decimals: number) => (x * 10n ** BigInt(decimals)) / SCALE;
export const fromBase = (base: bigint, decimals: number) => (base * SCALE) / 10n ** BigInt(decimals);

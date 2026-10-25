/**
 * Cloudflare D1: the store for everything notes.markets keeps (the indexer's read model, templates, email
 * subscriptions and the notification outbox).
 *
 * The D1 shapes are declared here (the subset used) instead of pulling in @cloudflare/workers-types, so the
 * package type-checks in Node too; Miniflare's D1 (tests) and the Workers binding both satisfy them.
 *
 * D1 has no interactive transactions. A write that must be atomic is built as a list of statements and run with
 * `batch()`, which D1 executes as one transaction: if any statement fails, none of them apply. A batch that must
 * only commit while some row still holds an expected value starts with `guard()`, a statement that raises an
 * error otherwise and so rolls the whole batch back (optimistic concurrency, in place of SELECT … FOR UPDATE).
 */

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number; rows_read?: number; rows_written?: number; duration?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(col?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<unknown>;
}

/** D1 refuses `undefined`; JSON objects are stored as text; bigints as decimal strings. */
export function bindable(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * D1 with a count of the queries made: a Worker invocation may run 1,000 D1 queries on the paid plan (50 on
 * free), and each statement in a batch counts as one. The cron spends from one budget across all its work.
 */
export class Store {
  queries = 0;
  constructor(readonly db: D1Database) {}

  stmt(sql: string, params: unknown[] = []): D1PreparedStatement {
    return this.db.prepare(sql).bind(...params.map(bindable));
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.queries++;
    return (await this.stmt(sql, params).all<T>()).results;
  }

  async first<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.queries++;
    return this.stmt(sql, params).first<T>();
  }

  async run(sql: string, params: unknown[] = []): Promise<D1Result> {
    this.queries++;
    return this.stmt(sql, params).run();
  }

  /** Run statements as one atomic transaction. */
  async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    if (!stmts.length) return [];
    this.queries += stmts.length;
    return this.db.batch(stmts);
  }
}

/**
 * A statement that fails (rolling back its batch) unless `sql` (a scalar subquery) equals `expected`. SQLite's
 * json() raises "malformed JSON" on its argument, which is only evaluated when the condition is false.
 */
export function guard(
  store: Store,
  sql: string,
  params: unknown[],
  expected: unknown,
  reason: string,
): D1PreparedStatement {
  const n = params.length + 1;
  return store.stmt(`SELECT CASE WHEN (${sql}) IS ?${n} THEN 1 ELSE json(?${n + 1}) END AS ok`, [
    ...params,
    expected,
    `guard: ${reason}`,
  ]);
}

/** True when an error is a failed `guard` (another writer got there first), not a real failure. */
export const isGuardFailure = (e: unknown) => /malformed JSON/i.test(e instanceof Error ? e.message : String(e));

/**
 * Multi-row INSERTs within D1's 100-bound-parameters limit: `rows` are split so each statement binds at most
 * 100 values. `head` is everything before VALUES (e.g. "INSERT OR IGNORE INTO t (a, b)"), `tail` anything after.
 */
export function insertRows(store: Store, head: string, rows: unknown[][], tail = ''): D1PreparedStatement[] {
  if (!rows.length) return [];
  const width = rows[0].length;
  const per = Math.max(1, Math.floor(100 / width));
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    let k = 0;
    const values = chunk.map(() => `(${Array.from({ length: width }, () => `?${++k}`).join(', ')})`).join(', ');
    out.push(store.stmt(`${head} VALUES ${values} ${tail}`.trim(), chunk.flat()));
  }
  return out;
}

/** `?1, ?2, …` for an IN list starting at `from`. */
export const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(', ');

/** Split a list for IN queries within the bound-parameter limit. */
export function chunks<T>(xs: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Apply migration files (tests and `wrangler dev` without the CLI): each statement in order, once. */
export async function applyMigrations(db: D1Database, migrations: Array<{ name: string; sql: string }>) {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)',
    )
    .run();
  const done = new Set(
    (await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map((r) => r.name),
  );
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    const stmts = m.sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch([
      ...stmts.map((s) => db.prepare(s)),
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?1)').bind(m.name),
    ]);
  }
}

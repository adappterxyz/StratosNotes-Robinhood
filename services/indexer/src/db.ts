/**
 * The database the indexer writes and the API reads: PostgreSQL. `Db` is the small surface both use, with two
 * implementations: node-postgres (production and local dev) and PGlite, Postgres compiled to WASM, for tests,
 * so tests run the same SQL as production with no server.
 */
import pg from 'pg';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Run `fn` in one transaction (BEGIN … COMMIT, ROLLBACK on error). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** LISTEN on a channel; returns an unlisten function. */
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export function pgDb(url: string, opts: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  // An idle client that loses its connection must not crash the process; the pool replaces it.
  pool.on('error', (e) => console.error(`postgres: ${e.message}`));
  // Postgres bigint/numeric come back as strings: keep them exact (callers convert).
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn({
          query: async <R>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as R[],
        });
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    async listen(channel, onPayload) {
      if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error('bad channel name');
      // A dedicated connection that re-LISTENs after a drop (database restart, failover, network blip).
      let client: pg.PoolClient | null = null;
      let stopped = false;
      const connect = async (): Promise<void> => {
        try {
          const c = await pool.connect();
          c.on('notification', (n) => {
            if (n.channel === channel && n.payload !== undefined) onPayload(n.payload);
          });
          c.on('error', (e) => {
            console.error(`postgres LISTEN ${channel}: ${e.message}; reconnecting`);
            c.release(true);
            if (client === c) client = null;
            if (!stopped)
              setTimeout(() => {
                void connect();
              }, 1000);
          });
          await c.query(`LISTEN ${channel}`);
          client = c;
          if (stopped) {
            await c.query(`UNLISTEN ${channel}`).catch(() => {});
            c.release();
            client = null;
          }
        } catch (e) {
          if (!stopped)
            setTimeout(() => {
              void connect();
            }, 2000);
          if (!client)
            console.error(`postgres LISTEN ${channel}: ${e instanceof Error ? e.message : String(e)}; retrying`);
        }
      };
      await connect();
      return async () => {
        stopped = true;
        const c = client;
        client = null;
        if (c) {
          await c.query(`UNLISTEN ${channel}`).catch(() => {});
          c.release();
        }
      };
    },
    close: () => pool.end(),
  };
}

/** PGlite (in-process Postgres) for tests. */
export async function pgliteDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  // PGlite runs one statement stream; serialise transactions so concurrent callers cannot interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  return {
    query: q,
    tx<T>(fn: (x: Queryable) => Promise<T>) {
      const run = chain.then(() =>
        db.transaction(async (t) =>
          fn({ query: async <R>(sql: string, params: unknown[] = []) => (await t.query<R>(sql, params)).rows }),
        ),
      );
      chain = run.catch(() => {});
      return run;
    },
    async listen(channel, onPayload) {
      return db.listen(channel, onPayload);
    },
    close: () => db.close(),
  };
}

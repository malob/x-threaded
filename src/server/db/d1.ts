import { MAX_SQL_PARAMS, type SqlDriver, type SqlStatement } from "./driver";

/**
 * Minimal structural types for the D1 binding — just the surface this driver
 * uses. Declared locally instead of pulling in @cloudflare/workers-types,
 * whose globals collide with Bun's in a single tsconfig.
 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

/**
 * SqlDriver over Cloudflare D1, for the Worker. The schema comes from
 * migrations/ (wrangler d1 migrations apply), never from here.
 */
export function d1Driver(db: D1Database): SqlDriver {
  const prepare = (sql: string, params: unknown[]): D1PreparedStatement => {
    const statement = db.prepare(sql);
    // bind() with no values is not a documented no-op, and every query that
    // takes no parameters is fine without it.
    return params.length === 0 ? statement : statement.bind(...params);
  };

  return {
    maxParams: MAX_SQL_PARAMS,

    async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      return await prepare(sql, params).first<T>();
    },

    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const { results } = await prepare(sql, params).all<T>();
      return results;
    },

    async run(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
      const { meta } = await prepare(sql, params).run();
      return { rowsAffected: meta.changes };
    },

    async batch(statements: SqlStatement[]): Promise<void> {
      if (statements.length === 0) return;
      await db.batch(statements.map(({ sql, params }) => prepare(sql, params)));
    },
  };
}

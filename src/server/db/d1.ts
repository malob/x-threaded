import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { SqlDriver, SqlRunResult, SqlStatement } from "./driver";

/**
 * SqlDriver over Cloudflare D1, for the Worker. The schema comes from
 * migrations/ (wrangler d1 migrations apply), never from here.
 *
 * The binding types come from @cloudflare/workers-types, imported as a module
 * rather than pulled in as ambient globals — which is what lets this file be
 * typechecked from the Worker project (workerd globals) and from the test
 * project (Bun globals) without the two runtimes' globals ever meeting.
 */
export function d1Driver(db: D1Database): SqlDriver {
  const prepare = (sql: string, params: unknown[]): D1PreparedStatement => {
    const statement = db.prepare(sql);
    // bind() with no values is not a documented no-op, and every query that
    // takes no parameters is fine without it.
    return params.length === 0 ? statement : statement.bind(...params);
  };

  return {
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

    async batch(statements: SqlStatement[]): Promise<SqlRunResult[]> {
      if (statements.length === 0) return [];
      const results = await db.batch(statements.map(({ sql, params }) => prepare(sql, params)));
      return results.map(({ meta }) => ({ rowsAffected: meta.changes }));
    },
  };
}

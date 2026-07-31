import { Database, type SQLQueryBindings } from "bun:sqlite";
import { MAX_SQL_PARAMS, type SqlDriver, type SqlStatement } from "./driver";
import { applyMigrations, loadMigrations } from "./migrations";

/**
 * SqlDriver over bun:sqlite, for the Bun server and for tests, with the
 * database migrated up to migrations/ before it is handed back.
 *
 * `path` is a file path, or ":memory:" for a throwaway database. Async because
 * migrating is: bun:sqlite itself is synchronous under the hood, but the
 * migration runner is shared with D1, which is not.
 */
export async function bunDriver(path: string, migrationsDir?: string): Promise<SqlDriver> {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  const driver = bunDriverFor(db);
  await applyMigrations(driver, loadMigrations(migrationsDir));
  return driver;
}

/**
 * The driver over an already-open database, with its schema left exactly as
 * found. `bunDriver` builds on this; the migration tests use it to drive
 * `applyMigrations` against databases they set up themselves.
 */
export function bunDriverFor(db: Database): SqlDriver {
  return {
    maxParams: MAX_SQL_PARAMS,

    async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      return db.query<T, SQLQueryBindings[]>(sql).get(...bind(params)) ?? null;
    },

    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.query<T, SQLQueryBindings[]>(sql).all(...bind(params));
    },

    async run(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
      const { changes } = db.query<unknown, SQLQueryBindings[]>(sql).run(...bind(params));
      return { rowsAffected: changes };
    },

    async batch(statements: SqlStatement[]): Promise<void> {
      if (statements.length === 0) return;
      db.transaction(() => {
        for (const { sql, params } of statements) {
          db.query<unknown, SQLQueryBindings[]>(sql).run(...bind(params));
        }
      })();
    },
  };
}

function bind(params: unknown[]): SQLQueryBindings[] {
  return params as SQLQueryBindings[];
}

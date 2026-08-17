import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlDriver, SqlRunResult, SqlStatement } from "./driver";
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
  // bun:sqlite creates the file but not the directory holding it, and the
  // default DB_PATH lives in data/, which is gitignored — so a fresh clone has
  // no such directory and the server died on SQLITE_CANTOPEN before it could
  // serve anything. Cheap to do for any DB_PATH rather than just that one: a
  // user pointing this somewhere new should not have to mkdir first.
  if (path !== ":memory:" && path !== "") mkdirSync(dirname(path), { recursive: true });
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

    async batch(statements: SqlStatement[]): Promise<SqlRunResult[]> {
      if (statements.length === 0) return [];
      return db.transaction(() => {
        const results: SqlRunResult[] = [];
        for (const { sql, params } of statements) {
          const { changes } = db.query<unknown, SQLQueryBindings[]>(sql).run(...bind(params));
          results.push({ rowsAffected: changes });
        }
        return results;
      })();
    },

    async batchFirst<T>(statements: SqlStatement[], query: SqlStatement): Promise<T | null> {
      return db.transaction(() => {
        for (const statement of statements) {
          db.query<unknown, SQLQueryBindings[]>(statement.sql).run(...bind(statement.params));
        }
        return db.query<T, SQLQueryBindings[]>(query.sql).get(...bind(query.params)) ?? null;
      })();
    },
  };
}

function bind(params: unknown[]): SQLQueryBindings[] {
  return params as SQLQueryBindings[];
}

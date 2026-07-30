import { Database, type SQLQueryBindings } from "bun:sqlite";
import { SCHEMA } from "../storage";
import { MAX_SQL_PARAMS, type SqlDriver, type SqlStatement } from "./driver";

/**
 * SqlDriver over bun:sqlite, for the Bun server and for tests. Synchronous
 * under the hood; async only to satisfy the shared seam.
 *
 * `path` is a file path, or ":memory:" for a throwaway database.
 */
export function bunDriver(path: string): SqlDriver {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  applySchema(db);
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

/**
 * Bring a local database up to the current schema.
 *
 * The Worker gets its schema from migrations/ instead; this is the local
 * twin of that, and Stage 2b replaces both halves with one migration ledger —
 * at which point `SCHEMA` and the column repair below both retire.
 */
function applySchema(db: Database): void {
  db.run(SCHEMA);
  // CREATE TABLE IF NOT EXISTS won't add columns to a table that predates
  // them, so bring older local databases forward.
  addMissingColumns(db, "posts", {
    entities_json: "TEXT",
    quoted_post_id: "TEXT",
    media_json: "TEXT",
    bookmarks: "INTEGER NOT NULL DEFAULT 0",
  });
  addMissingColumns(db, "oauth_tokens", { user_id: "TEXT" });
}

function addMissingColumns(db: Database, table: string, columns: Record<string, string>): void {
  const existing = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

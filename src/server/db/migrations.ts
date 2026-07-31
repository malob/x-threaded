import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlDriver } from "./driver";

/**
 * migrations/ is the only schema source in the repo.
 *
 * The Worker never runs this code — its D1 database is migrated out of band by
 * `wrangler d1 migrations apply` (see the recipe in wrangler.jsonc). Everything
 * that runs under Bun (the local server, the fakes, the workerd contract leg)
 * runs the same files through `applyMigrations`, tracked in the same
 * `d1_migrations` ledger wrangler writes — so the two paths can never disagree
 * about which migrations a database has seen. Verified 2026-07-30:
 * `wrangler d1 migrations apply x-threaded --local` reports "No migrations to
 * apply!" against a database this module migrated.
 *
 * This replaces the pre-Stage-2b arrangement, where a `SCHEMA` constant, the
 * migration files, and an `addMissingColumns` column repair each described the
 * schema separately (2026-07-30 review, M8).
 */

export interface Migration {
  /**
   * The file name, e.g. "0001_init.sql". This exact string is what wrangler
   * records in the ledger, so it is the migration's identity, not a label.
   */
  name: string;
  sql: string;
}

/** migrations/ at the repo root. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));

/**
 * Every migration in `dir`, in the order wrangler applies them: lexical by
 * file name, which the zero-padded numeric prefixes make chronological.
 *
 * Reads the filesystem, so only Bun-side callers may use it. Keeping it in
 * this module rather than in the driver is deliberate: `applyMigrations`
 * itself takes migrations as data, so nothing in the apply path needs fs.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** The ledger wrangler maintains, byte-for-byte its own DDL (d1/migrations/helpers.ts). */
const CREATE_LEDGER_SQL = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const LEDGER_TABLE = "d1_migrations";
const RECORD_SQL = `INSERT INTO "d1_migrations" (name) VALUES (?)`;

/**
 * The table whose presence means "this database already has a schema".
 *
 * `posts` is created by the first migration and by every path that ever
 * produced a schema here, and no migration drops it, so it is the one table a
 * populated database is guaranteed to have.
 */
const SCHEMA_SENTINEL_TABLE = "posts";

/**
 * The migrations the retired `SCHEMA` constant was equivalent to.
 *
 * Baselining needs to know *which* migrations a pre-ledger database already
 * satisfies, and for this repo the answer is exact rather than inferred: the
 * retired local path ran the whole of `SCHEMA` — the post-0004 shape — on
 * every startup with `CREATE TABLE IF NOT EXISTS`, then patched the columns
 * `SCHEMA` could not add to an existing table (`addMissingColumns`, which was
 * 0003 re-implemented in TypeScript). So any database with a `posts` table in
 * it necessarily has all four of these and nothing more.
 *
 * Listing them rather than baselining "everything currently in migrations/"
 * matters for later stages: when 0005 ships, a legacy database opened for the
 * first time after that must still *apply* 0005, not silently record it.
 */
const BASELINE_MIGRATIONS = [
  "0001_init.sql",
  "0002_oauth_tokens.sql",
  "0003_oauth_user_id.sql",
  "0004_settings_and_saved.sql",
];

/**
 * Bring `driver`'s database up to date with `migrations`, recording each in a
 * wrangler-compatible `d1_migrations` ledger. Already-recorded migrations are
 * skipped; each remaining one runs as a single atomic batch together with its
 * own ledger row, so a migration is either fully applied and recorded or
 * neither.
 *
 * Baselining: a database that has no ledger but *does* already have a schema
 * predates Stage 2b — it was built by the retired `SCHEMA` + `addMissingColumns`
 * path (Malo's data/x-threaded.sqlite, most importantly). Re-running the
 * migrations on it would throw the first time it hit 0003's
 * `ALTER TABLE oauth_tokens ADD COLUMN user_id`, because the column is already
 * there. So those migrations are recorded as applied without being executed,
 * and only migrations beyond the baseline actually run. A genuinely fresh
 * database has no sentinel table and runs everything.
 */
export async function applyMigrations(driver: SqlDriver, migrations: Migration[]): Promise<void> {
  const hadLedger = await tableExists(driver, LEDGER_TABLE);
  if (!hadLedger) {
    await driver.run(CREATE_LEDGER_SQL);
    if (await tableExists(driver, SCHEMA_SENTINEL_TABLE)) {
      await driver.batch(
        migrations
          .filter((migration) => BASELINE_MIGRATIONS.includes(migration.name))
          .map((migration) => ({ sql: RECORD_SQL, params: [migration.name] })),
      );
    }
  }

  const rows = await driver.all<{ name: string }>(`SELECT name FROM "d1_migrations"`);
  const applied = new Set(rows.map((row) => row.name));

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await driver.batch([
      ...splitStatements(migration.sql).map((sql) => ({ sql, params: [] })),
      { sql: RECORD_SQL, params: [migration.name] },
    ]);
  }
}

async function tableExists(driver: SqlDriver, name: string): Promise<boolean> {
  const row = await driver.first<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return row !== null;
}

/**
 * Split a migration file into the statements to run, one at a time.
 *
 * Both drivers take a single statement per call, so the `;` boundaries have to
 * be found here — and naively splitting on `;` is wrong, because a semicolon
 * inside a comment or a string literal is not a boundary. This walks the text
 * instead: comments are dropped, quoted runs are copied through untouched, and
 * only a bare `;` ends a statement. Doing it in one pass is what keeps
 * apostrophes in prose comments ("the authenticated user's ID", 0003) from
 * being read as the start of a string literal.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) statements.push(trimmed);
    current = "";
  };

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i] as string;
    const next = sql[i + 1];

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      current += "\n";
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 1;
      current += " ";
    } else if (char === "'" || char === '"') {
      // A doubled quote inside a literal ('it''s') closes and reopens here,
      // which lands in the same place: still inside a literal at the `;`.
      const end = sql.indexOf(char, i + 1);
      const close = end === -1 ? sql.length : end;
      current += sql.slice(i, close + 1);
      i = close;
    } else if (char === ";") {
      flush();
    } else {
      current += char;
    }
  }
  flush();

  return statements;
}

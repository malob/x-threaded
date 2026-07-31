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
 * Whether a database already contains what a migration creates, decided per
 * migration by probing for its distinctive schema artifact.
 *
 * Pre-ledger databases were built by the retired `SCHEMA` + `addMissingColumns`
 * path, so their migrations must be *recorded*, not re-run (0003's ALTER TABLE
 * throws on a column that already exists). An earlier draft inferred all four
 * from one `posts` sentinel; the Stage 2b adversarial review showed that
 * over-claims on databases from older schema eras (posts present, oauth_tokens
 * never created) — recording migrations that never ran and leaving the tables
 * missing for good. Probing each migration for its own artifact records
 * exactly what is present and runs exactly what is not, whatever era the
 * database stopped at — and makes replay after a half-completed baseline
 * impossible, since an unrecorded-but-present migration is re-detected on the
 * next boot rather than re-executed.
 *
 * Migrations without a probe (0005 onward) always run when unrecorded: only
 * the pre-ledger era needs detection, and it ended with these four.
 */
const BASELINE_PROBES: Record<string, (driver: SqlDriver) => Promise<boolean>> = {
  "0001_init.sql": (driver) => tableExists(driver, "posts"),
  "0002_oauth_tokens.sql": (driver) => tableExists(driver, "oauth_tokens"),
  "0003_oauth_user_id.sql": (driver) => columnExists(driver, "oauth_tokens", "user_id"),
  "0004_settings_and_saved.sql": (driver) => tableExists(driver, "settings"),
};

/**
 * Bring `driver`'s database up to date with `migrations`, recording each in a
 * wrangler-compatible `d1_migrations` ledger. Already-recorded migrations are
 * skipped; each remaining one runs as a single atomic batch together with its
 * own ledger row, so a migration is either fully applied and recorded or
 * neither.
 *
 * Baselining: any migration that is unrecorded but whose probe finds its
 * artifact already present (see BASELINE_PROBES) is recorded without being
 * executed. Probing runs before anything is written, and the ledger's creation
 * commits in the same batch as the baseline rows — so an interruption at any
 * point leaves either nothing (re-probed next boot) or a consistent ledger,
 * never an empty ledger that would replay 0003 into a duplicate-column error
 * (Stage 2b adversarial review, finding 2). A genuinely fresh database probes
 * false everywhere and runs everything.
 */
export async function applyMigrations(driver: SqlDriver, migrations: Migration[]): Promise<void> {
  const hadLedger = await tableExists(driver, LEDGER_TABLE);
  const applied = new Set<string>(
    hadLedger
      ? (await driver.all<{ name: string }>(`SELECT name FROM "d1_migrations"`)).map(
          (row) => row.name,
        )
      : [],
  );

  const preApplied: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    const probe = BASELINE_PROBES[migration.name];
    if (probe && (await probe(driver))) preApplied.push(migration.name);
  }

  const setup: { sql: string; params: unknown[] }[] = [];
  if (!hadLedger) setup.push({ sql: CREATE_LEDGER_SQL, params: [] });
  setup.push(...preApplied.map((name) => ({ sql: RECORD_SQL, params: [name] })));
  if (setup.length > 0) await driver.batch(setup);
  for (const name of preApplied) applied.add(name);

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

async function columnExists(driver: SqlDriver, table: string, column: string): Promise<boolean> {
  if (!(await tableExists(driver, table))) return false;
  const row = await driver.first<{ name: string }>(
    `SELECT name FROM pragma_table_info(?) WHERE name = ?`,
    [table, column],
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

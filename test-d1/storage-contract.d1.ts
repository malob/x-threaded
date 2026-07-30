/**
 * The storage contract against a real local-workerd D1 binding.
 *
 * Scope, honestly: this leg verifies D1's API shapes (what `first`/`all`/`run`
 * actually return), batch/transaction semantics, and that migrations/ produces
 * a schema the store can work against. It does NOT prove the 100-bound-
 * parameter limit — that is a D1 *service* policy, and local workerd passes
 * parameters straight through to its SQLite (MAX_VARIABLE_NUMBER = 32766), so
 * an over-limit query passes here and fails in production. The parameter limit
 * is owned by FakeD1Database's throw (test/storage-contract.test.ts) plus the
 * one-time probe against the deployed Worker on 2026-07-30.
 *
 * Kept out of the default `bun test` run: this boots workerd and is slow, and
 * `bun test` discovers any *.test.ts anywhere in the project, so the filename
 * deliberately does not match. Run it with `bun run test:d1`.
 */
import { afterAll } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { d1Driver, type D1Database } from "../src/server/db/d1";
import { SqlStore } from "../src/server/db/store";
import { describeStorageContract } from "../test/storage-contract";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Every table the store touches, for the reset between cases. */
const TABLES = ["conversations", "posts", "read_state", "oauth_tokens", "settings", "saved_items"];

const proxy = await getPlatformProxy<{ DB: D1Database }>();
const db = proxy.env.DB;
await applyMigrations(db);

describeStorageContract("workerd D1", async () => {
  // The local database persists in .wrangler/state, so each case starts by
  // emptying it rather than by getting a fresh one.
  for (const table of TABLES) await db.prepare(`DELETE FROM ${table}`).run();
  return new SqlStore(d1Driver(db));
});

afterAll(async () => {
  await proxy.dispose();
});

/**
 * Apply migrations/ in order, tracked in the same `d1_migrations` ledger
 * wrangler uses, so re-running this suite doesn't re-apply an ALTER TABLE.
 * (Stage 2b gives the Bun store the same treatment and retires `SCHEMA`.)
 */
async function applyMigrations(database: D1Database): Promise<void> {
  await database
    .prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT UNIQUE,
         applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    )
    .run();
  const { results } = await database
    .prepare(`SELECT name FROM d1_migrations`)
    .all<{ name: string }>();
  const applied = new Set(results.map((row) => row.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
    for (const statement of splitStatements(sql)) {
      await database.prepare(statement).run();
    }
    await database.prepare(`INSERT INTO d1_migrations (name) VALUES (?)`).bind(file).run();
  }
}

/**
 * Split a migration into statements. Line comments go first, because they
 * contain semicolons of their own ("Initial schema; keep in sync with…");
 * no `;` appears inside a string literal in migrations/.
 */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The migration runner.
 *
 * Until 2026-08-15 this file was dominated by baselining — deciding whether an
 * existing database should have each migration *run* or merely *recorded* —
 * because databases existed that predated the ledger. Folding 0001-0006 into
 * one baseline retired that whole question, and the tests for it went with it.
 * What remains is the property that replaced them, pinned first below: a
 * database whose ledger already names a migration is not touched by it. That
 * is what lets a live deployment survive the fold, so it is the one to keep
 * passing.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunDriver, bunDriverFor } from "../src/server/db/bun";
import type { SqlDriver } from "../src/server/db/driver";
import {
  applyMigrations,
  loadMigrations,
  splitStatements,
  type Migration,
} from "../src/server/db/migrations";

/** A stand-in for the migrations later stages will add. */
const FUTURE: Migration = {
  name: "0008_future.sql",
  sql: `-- A later migration; note the semicolon and the apostrophe in X's prose.
ALTER TABLE settings ADD COLUMN note TEXT;`,
};

const MIGRATIONS = loadMigrations();
const MIGRATION_NAMES = MIGRATIONS.map((migration) => migration.name);

/** The wrangler-shaped ledger, as `applyMigrations` creates it. */
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;

/** A driver over an empty in-memory database, with nothing applied to it. */
function emptyDriver(): SqlDriver {
  return bunDriverFor(new Database(":memory:"));
}

async function ledger(driver: SqlDriver): Promise<string[]> {
  const rows = await driver.all<{ name: string }>(`SELECT name FROM d1_migrations ORDER BY id`);
  return rows.map((row) => row.name);
}

async function tables(driver: SqlDriver): Promise<string[]> {
  const rows = await driver.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  );
  return rows.map((row) => row.name);
}

async function columns(driver: SqlDriver, table: string): Promise<string[]> {
  const rows = await driver.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((row) => row.name);
}

describe("loadMigrations", () => {
  it("reads migrations/ in applied order", () => {
    expect(MIGRATION_NAMES).toEqual([
      "0001_init.sql",
      "0007_conversation_run_lease.sql",
    ]);
    expect(MIGRATIONS.every((migration) => migration.sql.length > 0)).toBe(true);
  });
});

/**
 * The fold's load-bearing guarantee. Every database that existed when
 * 0001-0006 became one file has 0001_init.sql in its ledger, and the baseline
 * kept that name precisely so those databases skip it. If this ever fails, a
 * deployment's schema is being rewritten under it.
 */
describe("applyMigrations — a database whose ledger already names the migration", () => {
  it("does not run it, whatever the file now contains", async () => {
    const db = new Database(":memory:");
    db.run(LEDGER_DDL);
    db.run(`INSERT INTO d1_migrations (name) VALUES ('0001_init.sql')`);
    // A table the baseline would create, deliberately the wrong shape: if the
    // migration ran, this CREATE ... IF NOT EXISTS would be a silent no-op and
    // the column would be missing, so assert on something a re-run destroys.
    db.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, sentinel TEXT)`);
    db.run(`INSERT INTO settings (key, sentinel) VALUES ('k', 'untouched')`);
    const driver = bunDriverFor(db);

    await applyMigrations(driver, [MIGRATIONS[0]!]);

    expect(await driver.all(`SELECT sentinel FROM settings`)).toEqual([{ sentinel: "untouched" }]);
    expect(await ledger(driver)).toEqual(["0001_init.sql"]);
    // And the tables the baseline would have made are still absent, proving
    // the skip was total rather than partial.
    expect(await tables(driver)).not.toContain("posts");
  });

  it("still applies a migration added after it", async () => {
    const db = new Database(":memory:");
    db.run(LEDGER_DDL);
    db.run(`INSERT INTO d1_migrations (name) VALUES ('0001_init.sql')`);
    db.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`CREATE TABLE conversations (root_id TEXT PRIMARY KEY)`);
    const driver = bunDriverFor(db);

    await applyMigrations(driver, [...MIGRATIONS, FUTURE]);

    expect(await ledger(driver)).toEqual([...MIGRATION_NAMES, FUTURE.name]);
    expect(await columns(driver, "conversations")).toContain("run_id");
    expect(await columns(driver, "settings")).toContain("note");
  });
});

describe("applyMigrations — a fresh database", () => {
  it("runs every migration and records each one", async () => {
    const driver = emptyDriver();

    await applyMigrations(driver, MIGRATIONS);

    expect(await tables(driver)).toEqual([
      "conversations",
      "d1_migrations",
      "oauth_tokens",
      "posts",
      "read_state",
      "saved_items",
      "settings",
      "sqlite_sequence",
    ]);
    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
  });

  /**
   * The columns the folded 0002-0006 contributed, plus the additive run lease.
   * Spelled out because a dropped schema-evolution column can otherwise hide
   * until the first production query that depends on it.
   */
  it("carries every column the folded migrations added", async () => {
    const driver = emptyDriver();

    await applyMigrations(driver, MIGRATIONS);

    expect(await columns(driver, "conversations")).toEqual(
      expect.arrayContaining([
        "status",
        "full_read_at",
        "run_id",
        "run_lease_until",
        "run_wrote_posts",
        "run_previous_status",
        "run_previous_fetched_at",
        "run_previous_full_read_at",
      ]),
    );
    expect(await columns(driver, "oauth_tokens")).toEqual(
      expect.arrayContaining([
        "user_id",
        "state",
        "lease_id",
        "lease_until",
        "recovery_used",
        "broken_reason",
        "username",
        "display_name",
      ]),
    );
    // The lease protocol reads an untouched row as ready and unleased.
    await driver.run(
      `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, updated_at)
       VALUES ('self', 'a', 'r', 1, '2024-01-01')`,
    );
    expect(
      await driver.first<{ state: string; recovery_used: number }>(
        `SELECT state, recovery_used FROM oauth_tokens WHERE id = 'self'`,
      ),
    ).toEqual({ state: "ready", recovery_used: 0 });
  });

  it("keeps the ledger in wrangler's shape", async () => {
    const driver = emptyDriver();

    await applyMigrations(driver, MIGRATIONS);

    expect(await columns(driver, "d1_migrations")).toEqual(["id", "name", "applied_at"]);
    const row = await driver.first<{ applied_at: string }>(
      `SELECT applied_at FROM d1_migrations WHERE name = ?`,
      ["0001_init.sql"],
    );
    expect(typeof row?.applied_at).toBe("string");
  });

  it("is not deterred by unrelated tables sharing the database", async () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE unrelated (id TEXT PRIMARY KEY)`);
    const driver = bunDriverFor(db);

    await applyMigrations(driver, MIGRATIONS);

    expect(await tables(driver)).toContain("posts");
    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
  });

  it("re-runs after a crash that left the ledger created but empty", async () => {
    const db = new Database(":memory:");
    db.run(LEDGER_DDL);
    const driver = bunDriverFor(db);

    await applyMigrations(driver, MIGRATIONS);

    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
    expect(await tables(driver)).toContain("posts");
  });

  it("is what bunDriver gives you", async () => {
    const driver = await bunDriver(":memory:");

    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
  });

  /**
   * A fresh clone has no data/ — it is gitignored — and bun:sqlite creates the
   * file but not the directory above it, so `bun run dev:server` died on
   * SQLITE_CANTOPEN before serving anything. Found by cloning the repo and
   * following the README, which is the only way this one shows up: every other
   * caller either uses :memory: or a directory that already exists.
   */
  it("creates the directory its database file lives in", async () => {
    const root = mkdtempSync(join(tmpdir(), "x-threaded-db-"));
    const nested = join(root, "data", "deeper", "x-threaded.sqlite");

    const driver = await bunDriver(nested);

    expect(existsSync(nested)).toBe(true);
    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Not just presence: the live store must read and write against a database
   * built from the baseline alone. This is the test that would have caught a
   * column dropped in the fold.
   */
  it("produces a schema the store can actually use", async () => {
    const driver = await bunDriver(":memory:");
    const { SqlStore } = await import("../src/server/db/store");
    const { makePost } = await import("./fixtures");
    const store = new SqlStore(driver);

    const post = makePost({ text: "built from the baseline" });
    await store.upsertPosts([post]);
    expect(await store.getPost(post.id)).toEqual(post);
    await store.setReadState([post.id], true);
    expect(await store.getUnreadIds(post.conversationId)).toEqual([]);
    await store.putOAuthTokens("self", {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
      scope: "s",
      userId: "42",
    });
    expect((await store.getOAuthTokens("self"))?.userId).toBe("42");
  });
});

describe("applyMigrations — an already-ledgered database", () => {
  it("is a no-op when re-run", async () => {
    const driver = emptyDriver();
    await applyMigrations(driver, MIGRATIONS);
    const before = await driver.all(`SELECT id, name FROM d1_migrations ORDER BY id`);

    await applyMigrations(driver, MIGRATIONS);
    await applyMigrations(driver, MIGRATIONS);

    expect(await driver.all(`SELECT id, name FROM d1_migrations ORDER BY id`)).toEqual(before);
  });

  it("applies only the migrations it has not seen", async () => {
    const driver = emptyDriver();
    await applyMigrations(driver, MIGRATIONS);

    await applyMigrations(driver, [...MIGRATIONS, FUTURE]);

    expect(await ledger(driver)).toEqual([...MIGRATION_NAMES, FUTURE.name]);
    expect(await columns(driver, "settings")).toContain("note");
  });

  it("rolls a failing migration back whole, and does not record it", async () => {
    const driver = emptyDriver();
    const broken: Migration = {
      name: "0007_broken.sql",
      sql: `CREATE TABLE half_done (id TEXT);
            INSERT INTO no_such_table (id) VALUES ('x');`,
    };

    await expect(applyMigrations(driver, [...MIGRATIONS, broken])).rejects.toThrow();

    expect(await tables(driver)).not.toContain("half_done");
    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
  });
});

describe("splitStatements", () => {
  it("splits on bare semicolons and trims", () => {
    expect(splitStatements(`SELECT 1; SELECT 2;`)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("tolerates a missing trailing semicolon", () => {
    expect(splitStatements(`SELECT 1`)).toEqual(["SELECT 1"]);
  });

  it("drops line comments, semicolons and apostrophes included", () => {
    expect(splitStatements(`-- what's this; really\nSELECT 1;`)).toEqual(["SELECT 1"]);
  });

  it("drops block comments", () => {
    expect(splitStatements(`/* a; b */ SELECT 1;`)).toEqual(["SELECT 1"]);
  });

  it("keeps a semicolon inside a string literal", () => {
    expect(splitStatements(`INSERT INTO t VALUES ('a;b');`)).toEqual([
      `INSERT INTO t VALUES ('a;b')`,
    ]);
  });

  it("keeps a doubled quote and the semicolon after it together", () => {
    expect(splitStatements(`INSERT INTO t VALUES ('it''s;');`)).toEqual([
      `INSERT INTO t VALUES ('it''s;')`,
    ]);
  });

  it("does not treat a comment marker inside a literal as a comment", () => {
    expect(splitStatements(`INSERT INTO t VALUES ('a--b'); SELECT 1;`)).toEqual([
      `INSERT INTO t VALUES ('a--b')`,
      `SELECT 1`,
    ]);
  });

  it("finds every statement in the real migrations", () => {
    const statements = MIGRATIONS.flatMap((migration) => splitStatements(migration.sql));
    expect(statements).toHaveLength(13);
    expect(statements.every((statement) => !statement.includes("--"))).toBe(true);
  });
});

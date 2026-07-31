/**
 * The migration runner, with the baselining case front and centre.
 *
 * Baselining is the one piece of this that can destroy something: it decides
 * whether an existing database gets its migrations *run* or merely *recorded*.
 * Guess wrong towards running and 0003's ALTER TABLE throws on Malo's real
 * data/x-threaded.sqlite; guess wrong towards recording and a fresh database
 * silently comes up with no tables. So all three shapes are pinned here —
 * fresh, pre-ledger-with-data, and already-ledgered.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { bunDriver, bunDriverFor } from "../src/server/db/bun";
import type { SqlDriver } from "../src/server/db/driver";
import {
  applyMigrations,
  loadMigrations,
  splitStatements,
  type Migration,
} from "../src/server/db/migrations";

/**
 * The schema a pre-Stage-2b local database has, verbatim: the retired `SCHEMA`
 * constant from src/server/storage.ts, which `applySchema` ran on every
 * startup. Copied here rather than imported because the point of the stage was
 * to delete it — this is a fixture describing databases that already exist on
 * disk, not a schema anything should still be producing.
 */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  root_id TEXT PRIMARY KEY,
  root_author_handle TEXT NOT NULL,
  root_text TEXT NOT NULL,
  root_created_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_id TEXT,
  author_id TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_avatar_url TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  quotes INTEGER NOT NULL DEFAULT 0,
  bookmarks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  entities_json TEXT,
  quoted_post_id TEXT,
  media_json TEXT,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_conversation ON posts(conversation_id);

CREATE TABLE IF NOT EXISTS read_state (
  post_id TEXT PRIMARY KEY,
  read_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  user_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_items (
  post_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  added_at TEXT NOT NULL
);
`;

/** A stand-in for the migrations later stages will add. */
const FUTURE: Migration = {
  name: "0005_future.sql",
  sql: `-- A later migration; note the semicolon and the apostrophe in X's prose.
ALTER TABLE settings ADD COLUMN note TEXT;`,
};

const MIGRATIONS = loadMigrations();
const MIGRATION_NAMES = MIGRATIONS.map((migration) => migration.name);

/** A driver over an empty in-memory database, with nothing applied to it. */
function emptyDriver(): SqlDriver {
  return bunDriverFor(new Database(":memory:"));
}

/** A driver over a database in the shape the retired `SCHEMA` produced. */
function legacyDriver(): SqlDriver {
  const db = new Database(":memory:");
  db.run(LEGACY_SCHEMA);
  return bunDriverFor(db);
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
      "0002_oauth_tokens.sql",
      "0003_oauth_user_id.sql",
      "0004_settings_and_saved.sql",
    ]);
    expect(MIGRATIONS.every((migration) => migration.sql.length > 0)).toBe(true);
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
    // 0003 is an ALTER TABLE, so its column proves the file ran rather than
    // the CREATE TABLE in 0002 happening to include it.
    expect(await columns(driver, "oauth_tokens")).toContain("user_id");
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

  it("does not baseline a database whose tables are none of ours", async () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE unrelated (id TEXT PRIMARY KEY)`);
    const driver = bunDriverFor(db);

    await applyMigrations(driver, MIGRATIONS);

    expect(await tables(driver)).toContain("posts");
    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
  });

  it("is what bunDriver gives you", async () => {
    const driver = await bunDriver(":memory:");

    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
  });
});

describe("applyMigrations — a pre-ledger database with data", () => {
  /** A legacy database with a row in it, as Malo's data/x-threaded.sqlite is. */
  async function seededLegacyDriver(): Promise<SqlDriver> {
    const driver = legacyDriver();
    await driver.run(
      `INSERT INTO posts (id, conversation_id, author_id, author_handle, author_name,
         text, created_at, fetched_at)
       VALUES ('1', '1', '100', 'someone', 'Someone', 'hello', '2024-01-01', '2024-01-01')`,
    );
    await driver.run(
      `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scope, user_id,
         updated_at)
       VALUES ('self', 'a', 'r', 1, 'tweet.read', '42', '2024-01-01')`,
    );
    return driver;
  }

  it("records the migrations instead of running them, keeping the data", async () => {
    const driver = await seededLegacyDriver();

    // Without baselining this throws: 0003 adds oauth_tokens.user_id, which
    // addMissingColumns already added to this database.
    await applyMigrations(driver, MIGRATIONS);

    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
    expect(await driver.all(`SELECT id FROM posts`)).toEqual([{ id: "1" }]);
    expect(await driver.all(`SELECT user_id FROM oauth_tokens`)).toEqual([{ user_id: "42" }]);
  });

  it("still applies a migration newer than the baseline", async () => {
    const driver = await seededLegacyDriver();

    await applyMigrations(driver, [...MIGRATIONS, FUTURE]);

    expect(await ledger(driver)).toEqual([...MIGRATION_NAMES, FUTURE.name]);
    expect(await columns(driver, "settings")).toContain("note");
    expect(await driver.all(`SELECT id FROM posts`)).toEqual([{ id: "1" }]);
  });

  it("baselines only once — a later run behaves like any other", async () => {
    const driver = await seededLegacyDriver();
    await applyMigrations(driver, MIGRATIONS);

    await applyMigrations(driver, [...MIGRATIONS, FUTURE]);

    expect(await ledger(driver)).toEqual([...MIGRATION_NAMES, FUTURE.name]);
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
      name: "0005_broken.sql",
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
    expect(splitStatements("SELECT 1;\n\nSELECT 2;\n")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("tolerates a missing trailing semicolon", () => {
    expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("drops line comments, semicolons and apostrophes included", () => {
    const sql = `-- Cache the user's ID; it is billable to look up.
SELECT 1;`;
    expect(splitStatements(sql)).toEqual(["SELECT 1"]);
  });

  it("drops block comments", () => {
    expect(splitStatements("/* one; two */ SELECT 1;")).toEqual(["SELECT 1"]);
  });

  it("keeps a semicolon inside a string literal", () => {
    expect(splitStatements(`INSERT INTO t VALUES ('a;b');`)).toEqual([
      `INSERT INTO t VALUES ('a;b')`,
    ]);
  });

  it("keeps a doubled quote and the semicolon after it together", () => {
    expect(splitStatements(`INSERT INTO t VALUES ('it''s;fine');`)).toEqual([
      `INSERT INTO t VALUES ('it''s;fine')`,
    ]);
  });

  it("does not treat a comment marker inside a literal as a comment", () => {
    expect(splitStatements(`SELECT '-- not a comment';`)).toEqual([`SELECT '-- not a comment'`]);
  });

  it("finds every statement in the real migrations", () => {
    const statements = MIGRATIONS.flatMap((migration) => splitStatements(migration.sql));
    expect(statements).toHaveLength(8);
    expect(statements.every((statement) => !statement.includes("--"))).toBe(true);
  });
});

/**
 * Databases from schema eras older than the retired SCHEMA constant: the
 * Stage 2b adversarial review showed a single posts-table sentinel would
 * falsely record migrations these never ran.
 */
describe("applyMigrations — historical partial schemas", () => {
  it("records only what is present and runs the rest (pre-oauth era)", async () => {
    // The 0001-era shape: posts/conversations/read_state, nothing later.
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE posts (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
      CREATE TABLE conversations (root_id TEXT PRIMARY KEY);
      CREATE TABLE read_state (post_id TEXT PRIMARY KEY);
    `);
    db.run(`INSERT INTO posts (id, conversation_id) VALUES ('1', '1')`);
    const driver = bunDriverFor(db);

    await applyMigrations(driver, MIGRATIONS);

    // All four end up in the ledger — 0001 by detection, the rest by running.
    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
    const present = await tables(driver);
    for (const table of ["oauth_tokens", "settings", "saved_items"]) {
      expect(present).toContain(table);
    }
    expect(await columns(driver, "oauth_tokens")).toContain("user_id");
    expect(await driver.first(`SELECT id FROM posts WHERE id = '1'`)).not.toBeNull();
  });

  it("survives a crash that left the ledger created but empty", async () => {
    // A legacy database plus an empty ledger: the pre-fix code replayed the
    // migrations here and died on 0003's duplicate column.
    const db = new Database(":memory:");
    db.run(LEGACY_SCHEMA);
    const driver = bunDriverFor(db);
    await driver.run(`CREATE TABLE IF NOT EXISTS "d1_migrations"(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);

    await applyMigrations(driver, MIGRATIONS);

    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
    // Re-run stays a no-op.
    await applyMigrations(driver, MIGRATIONS);
    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
  });
});

describe("applyMigrations — interrupted legacy schemas self-heal", () => {
  it("fills in read_state when a legacy crash left only posts/conversations", async () => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE posts (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
      CREATE TABLE conversations (root_id TEXT PRIMARY KEY);
    `);
    const driver = bunDriverFor(db);

    await applyMigrations(driver, MIGRATIONS);

    expect(await tables(driver)).toContain("read_state");
    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
  });

  it("fills in saved_items when settings exists without it", async () => {
    const db = new Database(":memory:");
    db.run(LEGACY_SCHEMA);
    db.run(`DROP TABLE saved_items`);
    const driver = bunDriverFor(db);

    await applyMigrations(driver, MIGRATIONS);

    expect(await tables(driver)).toContain("saved_items");
    expect(await ledger(driver)).toEqual(MIGRATION_NAMES);
  });
});

describe("applyMigrations — restored early-era backups", () => {
  it("repairs columns that arrived after their table's CREATE, then the store works", async () => {
    // A backup from before posts gained entities/quoted/media/bookmarks and
    // before oauth_tokens gained user_id — the shape addMissingColumns fixed.
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE conversations (
        root_id TEXT PRIMARY KEY, root_author_handle TEXT NOT NULL,
        root_text TEXT NOT NULL, root_created_at TEXT NOT NULL, fetched_at TEXT NOT NULL);
      CREATE TABLE posts (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT,
        author_id TEXT NOT NULL, author_handle TEXT NOT NULL, author_name TEXT NOT NULL,
        author_avatar_url TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL,
        likes INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
        reposts INTEGER NOT NULL DEFAULT 0, quotes INTEGER NOT NULL DEFAULT 0,
        impressions INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL);
      CREATE TABLE read_state (post_id TEXT PRIMARY KEY, read_at TEXT NOT NULL);
      CREATE TABLE oauth_tokens (
        id TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL, scope TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const driver = bunDriverFor(db);

    await applyMigrations(driver, MIGRATIONS);

    // Not just presence: the live store must read and write (the failure mode
    // was "no column named bookmarks" on first upsert after certification).
    const { SqlStore } = await import("../src/server/db/store");
    const { makePost } = await import("./fixtures");
    const store = new SqlStore(driver);
    const post = makePost({ text: "restored backup" });
    await store.upsertPosts([post]);
    expect(await store.getPost(post.id)).toEqual(post);
    await store.setReadState([post.id], true);
    expect(await store.getUnreadIds(post.conversationId)).toEqual([]);
    await store.putOAuthTokens("self", {
      accessToken: "a", refreshToken: "r", expiresAt: 1, scope: "s", userId: "42",
    });
    expect((await store.getOAuthTokens("self"))?.userId).toBe("42");
  });
});

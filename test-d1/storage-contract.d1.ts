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
import { getPlatformProxy } from "wrangler";
import { d1Driver, type D1Database } from "../src/server/db/d1";
import { applyMigrations, loadMigrations } from "../src/server/db/migrations";
import { SqlStore } from "../src/server/db/store";
import { describeStorageContract } from "../test/storage-contract";

/** Every table the store touches, for the reset between cases. */
const TABLES = ["conversations", "posts", "read_state", "oauth_tokens", "settings", "saved_items"];

const proxy = await getPlatformProxy<{ DB: D1Database }>();
const db = proxy.env.DB;
// The same runner the Bun driver uses, against a real D1 binding — which is
// the point of this leg: it proves migrations/ produces a working schema on
// workerd, and that the ledger survives a re-run.
await applyMigrations(d1Driver(db), loadMigrations());

describeStorageContract("workerd D1", async () => {
  // The local database persists in .wrangler/state, so each case starts by
  // emptying it rather than by getting a fresh one.
  for (const table of TABLES) await db.prepare(`DELETE FROM ${table}`).run();
  return new SqlStore(d1Driver(db));
});

afterAll(async () => {
  await proxy.dispose();
});

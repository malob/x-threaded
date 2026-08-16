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
import { afterAll, expect } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import { d1Driver } from "../src/server/db/d1";
import { applyMigrations, loadMigrations } from "../src/server/db/migrations";
import { SqlStore } from "../src/server/db/store";
import { describeStorageContract } from "../test/storage-contract";

/** Every table the store touches, for the reset between cases. */
const TABLES = ["conversations", "posts", "read_state", "oauth_tokens", "settings", "saved_items"];

type StateFingerprint = Readonly<{ sha256: string; files: number; bytes: number }>;

const REPO_WRANGLER_STATE = resolve(import.meta.dir, "../.wrangler/state");

/** A content-only fingerprint: useful for equality, but reveals no stored values. */
async function fingerprintState(root: string): Promise<StateFingerprint> {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update("missing\0");
        return;
      }
      throw error;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        hash.update(`D\0${name}\0`);
        await visit(path);
      } else if (entry.isFile()) {
        const data = await readFile(path);
        hash.update(`F\0${name}\0${data.byteLength}\0`);
        hash.update(data);
        files += 1;
        bytes += data.byteLength;
      } else {
        // Do not follow symlinks or other special entries out of the state tree.
        hash.update(`O\0${name}\0`);
      }
    }
  }

  await visit(root);
  return { sha256: hash.digest("hex"), files, bytes };
}

const repoStateBefore = await fingerprintState(REPO_WRANGLER_STATE);
const proxy = await getPlatformProxy<{ DB: D1Database }>({
  persist: false,
  remoteBindings: false,
  envFiles: [],
});

afterAll(async () => {
  try {
    await proxy.dispose();
  } finally {
    expect(await fingerprintState(REPO_WRANGLER_STATE)).toEqual(repoStateBefore);
  }
});

const db = proxy.env.DB;
// The same runner the Bun driver uses, against a real D1 binding — which is
// the point of this leg: it proves migrations/ produces a working schema on
// workerd, and that the ledger survives a re-run.
await applyMigrations(d1Driver(db), loadMigrations());

describeStorageContract("workerd D1", async () => {
  // Each case resets only this test file's hermetic, in-memory binding.
  for (const table of TABLES) await db.prepare(`DELETE FROM ${table}`).run();
  return new SqlStore(d1Driver(db));
});

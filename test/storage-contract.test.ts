/**
 * The storage contract against both drivers the app ships with.
 *
 * The D1 leg runs over FakeD1Database, which is the only harness anywhere that
 * enforces D1's 100-bound-parameter ceiling — neither bun:sqlite nor local
 * workerd does. That makes this file, not `bun run test:d1`, the guard on
 * chunking; see test-d1/storage-contract.d1.ts for what that leg does cover.
 */
import { bunDriver } from "../src/server/db/bun";
import { d1Driver } from "../src/server/db/d1";
import { SqlStore } from "../src/server/db/store";
import { FakeD1Database } from "./fake-d1";
import { describeStorageContract } from "./storage-contract";

describeStorageContract("bun:sqlite", () => new SqlStore(bunDriver(":memory:")));

describeStorageContract("D1 fake", () => new SqlStore(d1Driver(new FakeD1Database())));

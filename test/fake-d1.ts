import type {
  D1Database,
  D1DatabaseSession,
  D1ExecResult,
  D1PreparedStatement,
  D1Response,
  D1Result,
} from "@cloudflare/workers-types";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { d1Driver } from "../src/server/db/d1";
import { applyMigrations, loadMigrations, type Migration } from "../src/server/db/migrations";

/**
 * D1 rejects a statement carrying more than this many bound parameters
 * (probed against the deployed Worker: 100 passes, 101 fails). Neither
 * bun:sqlite (40k+ accepted in probes) nor local workerd enforces it, so the
 * limit is only testable through a fake that does.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * The parts of D1 this fake does not emulate. They are declared so the fake
 * satisfies the real binding types rather than a local approximation of them —
 * a driver that starts calling one of these fails loudly here instead of
 * passing against a hand-rolled interface that never mentioned it.
 */
function unsupported(method: string): never {
  throw new Error(`FakeD1Database: ${method}() is not emulated`);
}

/** D1 reports far more than bun:sqlite knows; the rest is filled with zeros. */
function meta(changes: number, lastRowId: number): D1Response["meta"] {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
}

class FakeD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly params: SQLQueryBindings[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    if (values.length > D1_MAX_BOUND_PARAMS) {
      throw new Error("D1_ERROR: too many SQL variables");
    }
    // A new statement, not a mutation: the D1 driver may bind one prepared
    // statement once per row and batch the results.
    return new FakeD1PreparedStatement(this.db, this.sql, values as SQLQueryBindings[]);
  }

  async first<T = unknown>(colName: string): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(colName?: string): Promise<T | null> {
    if (colName !== undefined) unsupported("first(colName)");
    return this.db.query<T, SQLQueryBindings[]>(this.sql).get(...this.params) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.db.query<T, SQLQueryBindings[]>(this.sql).all(...this.params);
    return { success: true, meta: meta(0, 0), results };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  raw(): never {
    return unsupported("raw");
  }

  /** Sync form, so batch() can drive it inside a bun:sqlite transaction. */
  execute<T = Record<string, unknown>>(): D1Result<T> {
    const changes = this.db.query<unknown, SQLQueryBindings[]>(this.sql).run(...this.params);
    return {
      success: true,
      meta: meta(changes.changes, Number(changes.lastInsertRowid)),
      results: [],
    };
  }
}

/**
 * D1 stand-in backed by in-memory SQLite, faithful on the two behaviors that
 * bite: the bound-parameter ceiling and transactional batches.
 *
 * Built by `create()` rather than `new`, because its schema comes from
 * migrations/ — the same files the Bun driver and the workerd leg apply — and
 * applying them goes through the async driver seam.
 */
export class FakeD1Database implements D1Database {
  private readonly db = new Database(":memory:");

  private constructor() {}

  /** An empty database migrated up to `migrations` (migrations/ by default). */
  static async create(migrations: Migration[] = loadMigrations()): Promise<FakeD1Database> {
    const database = new FakeD1Database();
    await applyMigrations(d1Driver(database), migrations);
    return database;
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeD1PreparedStatement(this.db, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const prepared = statements.map((statement) => {
      if (!(statement instanceof FakeD1PreparedStatement)) {
        throw new Error("FakeD1Database.batch: statement did not come from this database");
      }
      return statement;
    });
    const transaction = this.db.transaction(() => prepared.map((s) => s.execute<T>()));
    return transaction();
  }

  exec(): Promise<D1ExecResult> {
    return unsupported("exec");
  }

  withSession(): D1DatabaseSession {
    return unsupported("withSession");
  }

  dump(): Promise<ArrayBuffer> {
    return unsupported("dump");
  }
}

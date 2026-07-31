import { Database, type SQLQueryBindings } from "bun:sqlite";
import { d1Driver, type D1Database, type D1PreparedStatement } from "../src/server/db/d1";
import { applyMigrations, loadMigrations, type Migration } from "../src/server/db/migrations";

/**
 * D1 rejects a statement carrying more than this many bound parameters
 * (probed against the deployed Worker: 100 passes, 101 fails). Neither
 * bun:sqlite (40k+ accepted in probes) nor local workerd enforces it, so the
 * limit is only testable through a fake that does.
 */
export const D1_MAX_BOUND_PARAMS = 100;

interface RunResult {
  success: true;
  meta: { changes: number; last_row_id: number };
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

  async first<T>(): Promise<T | null> {
    return this.db.query<T, SQLQueryBindings[]>(this.sql).get(...this.params) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.query<T, SQLQueryBindings[]>(this.sql).all(...this.params) };
  }

  async run(): Promise<RunResult> {
    return this.execute();
  }

  /** Sync form, so batch() can drive it inside a bun:sqlite transaction. */
  execute(): RunResult {
    const changes = this.db.query<unknown, SQLQueryBindings[]>(this.sql).run(...this.params);
    return {
      success: true,
      meta: { changes: changes.changes, last_row_id: Number(changes.lastInsertRowid) },
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

  async batch(statements: D1PreparedStatement[]): Promise<unknown> {
    const prepared = statements.map((statement) => {
      if (!(statement instanceof FakeD1PreparedStatement)) {
        throw new Error("FakeD1Database.batch: statement did not come from this database");
      }
      return statement;
    });
    const transaction = this.db.transaction(() => prepared.map((s) => s.execute()));
    return transaction();
  }
}

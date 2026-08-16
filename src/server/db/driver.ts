/**
 * The platform seam.
 *
 * bun:sqlite and D1 differ only in how a statement is handed to the database;
 * the SQL itself is identical. So this is the whole abstraction — four methods
 * and a number — and `SqlStore` above it writes every query exactly once.
 * (Before this, two stores hand-maintained ~640 lines of the same SQL and had
 * already drifted; 2026-07-30 review, S1.)
 */
export interface SqlDriver {
  /** The first matching row, or null when the query matched nothing. */
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * A write. `rowsAffected` is load-bearing, not decoration: the OAuth token
   * lease claims the grant with a conditional UPDATE and reads the count to
   * learn whether it won the race (`SqlStore.claimTokenLease`).
   */
  run(sql: string, params?: unknown[]): Promise<SqlRunResult>;
  /** All or nothing: a transaction on bun:sqlite, `db.batch` on D1. */
  batch(statements: SqlStatement[]): Promise<SqlRunResult[]>;
}

export interface SqlRunResult {
  rowsAffected: number;
}

export interface SqlStatement {
  sql: string;
  params: unknown[];
}

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
   * A write. `rowsAffected` is load-bearing, not decoration: Stage 3's OAuth
   * lease claims the token with a conditional UPDATE and reads the count to
   * learn whether it won the race.
   */
  run(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  /** All or nothing: a transaction on bun:sqlite, `db.batch` on D1. */
  batch(statements: SqlStatement[]): Promise<void>;
  /**
   * Bound parameters this driver accepts in one statement. The store sizes its
   * `IN (…)` lists against it — a raw driver can't parse SQL, so it can't
   * count a caller's placeholders for it.
   */
  readonly maxParams: number;
}

export interface SqlStatement {
  sql: string;
  params: unknown[];
}

/**
 * Ceiling on bound parameters per SQL statement, for both drivers.
 *
 * D1 rejects a statement carrying more than 100 — probed against the deployed
 * Worker on 2026-07-30 by bisection: 100 params returned 200, 101 returned
 * `D1_ERROR: too many SQL variables`. It's a D1 service policy, so nothing
 * local reproduces it: bun:sqlite swallowed 40,000 parameters in one `IN (…)`
 * when probed the same day, and local workerd doesn't enforce it either.
 *
 * Both drivers declare this one number as their `maxParams` rather than each
 * taking its own runtime's limit, so a query that works locally can't turn out
 * to be over the line in production.
 */
export const MAX_SQL_PARAMS = 100;

/**
 * Split `items` into consecutive runs of at most `size`. Empty in, empty out —
 * so a caller can loop over the result without a length check first.
 */
export function chunked<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunked: size must be a positive integer, got ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** `?,?,?` for an `IN (…)` list of `count` bound parameters. */
export function placeholders(count: number): string {
  return Array(count).fill("?").join(",");
}

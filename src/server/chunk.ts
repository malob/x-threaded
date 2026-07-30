/**
 * Ceiling on bound parameters per SQL statement, for both stores.
 *
 * D1 rejects a statement carrying more than 100 — probed against the deployed
 * Worker on 2026-07-30 by bisection: 100 params returned 200, 101 returned
 * `D1_ERROR: too many SQL variables`. It's a D1 service policy, so nothing
 * local reproduces it: bun:sqlite swallowed 40,000 parameters in one `IN (…)`
 * when probed the same day, and local workerd doesn't enforce it either.
 *
 * Both stores build their `IN (…)` lists against this one number rather than
 * each taking its own runtime's limit, so a query that works locally can't
 * turn out to be over the line in production.
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

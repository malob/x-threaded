/** The X snowflake epoch: ms between the Unix epoch and 2010-11-04T01:42:54.657Z. */
const SNOWFLAKE_EPOCH_MS = 1288834974657;

/**
 * Creation time encoded in a post ID (snowflake: ms since the X epoch), or
 * null when the ID isn't a snowflake at all.
 *
 * Shared rather than client-side because the server dates conversations from
 * their root ID too — a post's ID is the only timestamp available before the
 * post itself has been fetched.
 *
 * Total by design: IDs reach this from URLs, deep links and stored rows, and
 * `BigInt("not-an-id")` throws. A caller that can't proceed without a date
 * should say so itself rather than have a SyntaxError surface from here.
 */
export function snowflakeMs(postId: string): number | null {
  if (!/^\d+$/.test(postId)) return null;
  return Number(BigInt(postId) >> 22n) + SNOWFLAKE_EPOCH_MS;
}

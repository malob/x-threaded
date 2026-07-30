/**
 * Creation time encoded in a post ID (snowflake: ms since the X epoch).
 *
 * Shared rather than client-side because the server dates conversations from
 * their root ID too — a post's ID is the only timestamp available before the
 * post itself has been fetched.
 */
export function snowflakeMs(postId: string): number {
  return Number(BigInt(postId) >> 22n) + 1288834974657;
}

import { parseIntStrict } from "../shared/num";

/**
 * Environment parsing for the two entry points. Invalid config throws rather
 * than degrading: these values gate spending, and a silently-wrong one costs
 * real money (see the 2026-07-30 review, finding C2).
 */

/** Posts fetched per conversation when MAX_POSTS_PER_FETCH is unset. */
const DEFAULT_MAX_POSTS = 500;
const MIN_MAX_POSTS = 1;
const MAX_MAX_POSTS = 5000;

/**
 * The per-conversation fetch cap, or a throw naming the bad value.
 *
 * The old `Number(raw ?? 500)` turned a typo like "5OO" into NaN, and
 * `posts.length >= NaN` is false forever — the cap vanished and the fetch ran
 * until X ran out of posts to bill for. Refusing to boot is the last point
 * where that's still cheap.
 */
export function resolveMaxPosts(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_POSTS;
  const parsed = parseIntStrict(raw);
  if (parsed === null || parsed < MIN_MAX_POSTS || parsed > MAX_MAX_POSTS) {
    throw new Error(
      `MAX_POSTS_PER_FETCH must be an integer from ${MIN_MAX_POSTS} to ${MAX_MAX_POSTS}, ` +
        `got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

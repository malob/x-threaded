import { parseIntStrict } from "../shared/num";

/**
 * Environment parsing for the two entry points. Invalid config throws rather
 * than degrading: this value bounds main search-result spending, and a
 * silently-wrong one costs real money (see the 2026-07-30 review, finding C2).
 * Referenced posts and follow-up lookups are metered separately, so this is not
 * a total spend cap.
 */

/** Main conversation-search results allowed per run when the setting is unset. */
const DEFAULT_MAX_POSTS = 500;
/**
 * /tweets/search/all refuses pages smaller than 10, and main-result pagination
 * will not request below that floor — so a cap under 10 would boot fine and
 * then silently fetch nothing.
 */
const MIN_MAX_POSTS = 10;
const MAX_MAX_POSTS = 5000;

/**
 * The per-run main conversation-search result cap, or a throw naming the bad
 * value. Search-response includes and later enrichment calls do not consume it.
 *
 * The old `Number(raw ?? 500)` turned a typo like "5OO" into NaN, and
 * `posts.length >= NaN` is false forever — the main-result bound vanished and
 * search ran until X ran out of posts to bill for. Refusing to boot is the last
 * point where that is still cheap.
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

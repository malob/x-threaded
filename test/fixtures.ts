import type { Post } from "../src/shared/types";
import { snowflakeMs } from "../src/shared/snowflake";

/** The X snowflake epoch, as encoded in snowflakeMs (src/shared/snowflake.ts). */
const SNOWFLAKE_EPOCH_MS = 1288834974657;

/**
 * Inverse of snowflakeMs: a post ID that decodes back to `when`. Fixture IDs
 * have to be snowflake-consistent with createdAt because the thread model
 * compares the two when placing gaps (`attachGaps` in
 * src/web/thread/model.ts), and the stores order posts by ID.
 */
export function snowflakeId(when: string | number): string {
  const ms = typeof when === "number" ? when : Date.parse(when);
  if (!Number.isFinite(ms)) throw new Error(`snowflakeId: unparseable time ${String(when)}`);
  if (ms < SNOWFLAKE_EPOCH_MS) {
    throw new Error(`snowflakeId: ${String(when)} predates the snowflake epoch`);
  }
  return String((BigInt(ms) - BigInt(SNOWFLAKE_EPOCH_MS)) << 22n);
}

/** Fixed base so unspecified posts land in the same, boring hour every run. */
const BASE_MS = Date.parse("2024-06-01T12:00:00.000Z");
const STEP_MS = 60_000;
let nextIndex = 0;

/**
 * Auto-generated identities are distinct and increasing, but their absolute
 * values depend on how many posts the process has already made — derive an ID
 * from an explicit time when a test needs to name it.
 */
function identity(
  id: string | undefined,
  createdAt: string | undefined,
): { id: string; createdAt: string } {
  if (id !== undefined && createdAt !== undefined) return { id, createdAt };
  if (id !== undefined) {
    const ms = snowflakeMs(id);
    if (ms === null) {
      throw new Error(
        `makePost: id ${id} is not a snowflake, so createdAt can't be derived — pass createdAt too`,
      );
    }
    return { id, createdAt: new Date(ms).toISOString() };
  }
  if (createdAt !== undefined) return { id: snowflakeId(createdAt), createdAt };
  const ms = BASE_MS + nextIndex++ * STEP_MS;
  return { id: snowflakeId(ms), createdAt: new Date(ms).toISOString() };
}

/**
 * A complete valid Post whose id and createdAt agree: pass either one and the
 * other is derived. fetchedAt defaults to now, as the real XApi sets it, so a
 * fresh fixture counts as already read today unless a test says otherwise.
 */
export function makePost(overrides: Partial<Post> = {}): Post {
  const { id, createdAt } = identity(overrides.id, overrides.createdAt);
  const base: Post = {
    id,
    conversationId: id,
    parentId: null,
    authorId: "100",
    authorHandle: "tester",
    authorName: "Test Author",
    authorAvatarUrl: null,
    text: "post text",
    createdAt,
    metrics: { likes: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: 0, impressions: 0 },
    entities: null,
    quotedPostId: null,
    media: null,
    fetchedAt: new Date().toISOString(),
  };
  // Identity last, so a half-specified (or explicitly undefined) override
  // keeps the derived half rather than losing it.
  return { ...base, ...overrides, id, createdAt };
}

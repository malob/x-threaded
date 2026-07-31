/**
 * The X API wire contract, and the OAuth token endpoint's, as schemas.
 *
 * Everything the server believes about a response body from X is declared
 * here once and enforced where the body arrives. The application types
 * (`Post` and friends in shared/types) stay hand-written: those are what
 * `toPost` builds out of this, not what the wire hands us.
 *
 * Tolerance is deliberate. We do not own this wire, and X adds fields and
 * variants without notice: unknown keys are ignored, `type` discriminators
 * stay plain strings rather than picklists, and every field the code already
 * treats as possibly-absent stays optional. What these catch is the
 * structural lie — `data` arriving as an object where the code loops over an
 * array — which a cast lets through to silently produce an empty result.
 */
import * as v from "valibot";

const UrlEntitySchema = v.object({
  url: v.string(),
  expanded_url: v.string(),
  display_url: v.string(),
});

const EntitiesSchema = v.object({ urls: v.optional(v.array(UrlEntitySchema)) });

export const ApiTweetSchema = v.object({
  id: v.string(),
  text: v.string(),
  author_id: v.string(),
  created_at: v.string(),
  conversation_id: v.string(),
  // `type` is a string, never a picklist: a reference kind X adds tomorrow
  // must not turn a whole page of posts into a parse failure.
  referenced_tweets: v.optional(v.array(v.object({ type: v.string(), id: v.string() }))),
  entities: v.optional(EntitiesSchema),
  attachments: v.optional(v.object({ media_keys: v.optional(v.array(v.string())) })),
  /** Full text of long posts; the plain text field is truncated to ~280. */
  note_tweet: v.optional(v.object({ text: v.string(), entities: v.optional(EntitiesSchema) })),
  public_metrics: v.optional(
    v.object({
      like_count: v.number(),
      reply_count: v.number(),
      retweet_count: v.number(),
      quote_count: v.number(),
      bookmark_count: v.optional(v.number()),
      impression_count: v.number(),
    }),
  ),
});
export type ApiTweet = v.InferOutput<typeof ApiTweetSchema>;

export const ApiUserSchema = v.object({
  id: v.string(),
  name: v.string(),
  username: v.string(),
  profile_image_url: v.optional(v.string()),
});
export type ApiUser = v.InferOutput<typeof ApiUserSchema>;

export const ApiMediaSchema = v.object({
  media_key: v.string(),
  /** Also a plain string — new media types show up on X before they do here. */
  type: v.string(),
  url: v.optional(v.string()),
  preview_image_url: v.optional(v.string()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
});
export type ApiMedia = v.InferOutput<typeof ApiMediaSchema>;

export const IncludesSchema = v.object({
  users: v.optional(v.array(ApiUserSchema)),
  tweets: v.optional(v.array(ApiTweetSchema)),
  media: v.optional(v.array(ApiMediaSchema)),
});
export type Includes = v.InferOutput<typeof IncludesSchema>;

/** Any endpoint returning a list of posts: search, lookup-by-ids, a timeline. */
export const SearchPageSchema = v.object({
  data: v.optional(v.array(ApiTweetSchema)),
  includes: v.optional(IncludesSchema),
  // result_count is optional even though X always sends it: nothing here
  // reads it, and a required-but-unread field can only ever cause a failure.
  meta: v.optional(v.object({ next_token: v.optional(v.string()), result_count: v.optional(v.number()) })),
});
export type SearchPage = v.InferOutput<typeof SearchPageSchema>;

export const TweetLookupSchema = v.object({
  data: v.optional(ApiTweetSchema),
  includes: v.optional(IncludesSchema),
  errors: v.optional(
    v.array(v.object({ title: v.optional(v.string()), detail: v.optional(v.string()) })),
  ),
});
export type TweetLookup = v.InferOutput<typeof TweetLookupSchema>;

/** /2/users/me — the authenticated user. */
export const MeResponseSchema = v.object({
  data: v.optional(v.object({ id: v.string(), username: v.string(), name: v.string() })),
});
export type MeResponse = v.InferOutput<typeof MeResponseSchema>;

export const BookmarkFoldersSchema = v.object({
  data: v.optional(v.array(v.object({ id: v.string(), name: v.string() }))),
});
export type BookmarkFolders = v.InferOutput<typeof BookmarkFoldersSchema>;

/**
 * One page of a bookmark folder. This endpoint takes no field or expansion
 * parameters, so its posts really are bare `{id}` stubs.
 */
export const BookmarkFolderPageSchema = v.object({
  data: v.optional(v.array(v.object({ id: v.string() }))),
  meta: v.optional(v.object({ next_token: v.optional(v.string()) })),
});
export type BookmarkFolderPage = v.InferOutput<typeof BookmarkFolderPageSchema>;

/**
 * The OAuth token endpoint's answer, to both the code exchange and a refresh.
 *
 * Every field is optional because an error response is the same body with
 * `error`/`error_description` instead of a token pair, and the refresh
 * failure classification reads exactly those. Callers check what they need
 * and treat an unparseable body as no usable answer.
 */
export const TokenResponseSchema = v.object({
  access_token: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  scope: v.optional(v.string()),
  error: v.optional(v.string()),
  error_description: v.optional(v.string()),
});
export type TokenResponse = v.InferOutput<typeof TokenResponseSchema>;

/** How a rejected value is described: by type, never by its own contents. */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Past this, a summary stops being a summary. */
const MAX_REPORTED_ISSUES = 3;

/**
 * Why a parse failed: where it failed and what was expected there.
 *
 * The offending value never appears. Valibot's own issue messages quote the
 * input, and neither an X response nor a client's request body is something
 * to put in a log line or hand back to the other side — this is the only
 * formatter either boundary uses, so that holds for both.
 */
export function summarizeIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const where = v.getDotPath(issue) ?? "(body)";
    if (issue.input === undefined) return `${where}: missing`;
    const expected = issue.expected ?? "a different type";
    return `${where}: expected ${expected}, got ${typeName(issue.input)}`;
  });
  const rest = issues.length - shown.length;
  return rest > 0 ? `${shown.join("; ")} (+${rest} more)` : shown.join("; ");
}

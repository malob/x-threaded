import * as v from "valibot";
import { NO_READS, addReceipts, ownedReads, postReads, type Receipt } from "../shared/pricing";
import { snowflakeMs } from "../shared/snowflake";
import type { MediaItem, Post, PostEntities } from "../shared/types";
import {
  BookmarkFolderPageSchema,
  BookmarkFoldersSchema,
  MeResponseSchema,
  SearchPageSchema,
  TweetLookupSchema,
  summarizeIssues,
  type ApiMedia,
  type ApiTweet,
  type ApiUser,
  type Includes,
} from "./x-wire";

const API_BASE = "https://api.x.com/2";
const POST_FIELDS =
  "created_at,public_metrics,author_id,conversation_id,referenced_tweets,entities,attachments,note_tweet";
const EXPANSIONS =
  "author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys";
const USER_FIELDS = "name,username,profile_image_url";
const MEDIA_FIELDS = "type,url,preview_image_url,width,height";
const PAGE_SIZE = 100;
/** Smallest page /tweets/search/all accepts; asking for less is a 400. */
const MIN_PAGE_SIZE = 10;
const PAGE_DELAY_MS = 1100;
/**
 * How far before the root's own timestamp the search window opens. The root
 * can't have replies older than itself; the margin only absorbs the slop
 * between a snowflake's encoded time and X's indexing time.
 */
const START_TIME_MARGIN_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * RFC3339 at second precision, the grammar /tweets/search/all documents for
 * start_time — toISOString's milliseconds aren't part of it. Truncation lands
 * in the past, which only widens the window.
 */
function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class XApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

/**
 * X answered, but not with the shape this endpoint is documented to return.
 *
 * Distinct from XApiError, which is X telling us something went wrong: this
 * is the wire itself having moved. The message names the endpoint and the
 * fields that disagreed — never the body, which is a response we don't
 * control being echoed into logs and back to a client.
 */
export class XApiShapeError extends Error {
  constructor(
    readonly path: string,
    readonly issues: string,
  ) {
    super(`X API returned an unexpected shape on ${path}: ${issues}`);
    this.name = "XApiShapeError";
  }
}

export interface FetchedConversation {
  posts: Post[];
  /** Referenced posts from includes (quoted posts, recovered parents). */
  referenced: Post[];
  truncated: boolean;
}

/**
 * A value from X and an estimate of what reading it billed.
 *
 * Every method below returns one. This layer is the only one that knows an
 * endpoint's billing unit — which posts count, at which rate, and whether a
 * nested call added its own — so it is the layer that says so, rather than a
 * route inferring spend from whatever ended up in a variable afterwards
 * (2026-07-30 review, H1). Charging the receipt through a meter is also how
 * the value gets unwrapped, so a call whose cost goes unreported has to be
 * written to look wrong.
 *
 * The counts are estimates: X deduplicates a post read within a 24h UTC day,
 * calls that dedup soft, and only /2/usage/tweets knows what it really
 * charged. Where two of our calls read the same post, the receipts add — the
 * conservative direction.
 */
export interface Billed<T> {
  readonly value: T;
  readonly receipt: Receipt;
}

/** The v2 API HTML-escapes &, <, > in post text; x.com renders them unescaped. */
function unescapeText(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function toPost(
  tweet: ApiTweet,
  users: Map<string, ApiUser>,
  mediaByKey: Map<string, ApiMedia>,
  fetchedAt: string,
): Post {
  const author = users.get(tweet.author_id);
  const parent = tweet.referenced_tweets?.find((r) => r.type === "replied_to");
  const quoted = tweet.referenced_tweets?.find((r) => r.type === "quoted");
  const text = tweet.note_tweet?.text ?? tweet.text;
  const urls = tweet.note_tweet?.entities?.urls ?? tweet.entities?.urls;
  const entities: PostEntities | null = urls?.length
    ? { urls: urls.map(({ url, expanded_url, display_url }) => ({ url, expanded_url, display_url })) }
    : null;
  const media: MediaItem[] = (tweet.attachments?.media_keys ?? [])
    .map((key) => mediaByKey.get(key))
    .filter((m) => m !== undefined)
    .map((m) => ({
      mediaKey: m.media_key,
      type: m.type,
      url: m.url ?? null,
      previewImageUrl: m.preview_image_url ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
    }));
  const m = tweet.public_metrics;
  return {
    id: tweet.id,
    conversationId: tweet.conversation_id,
    parentId: parent?.id ?? null,
    authorId: tweet.author_id,
    authorHandle: author?.username ?? "unknown",
    authorName: author?.name ?? "Unknown",
    authorAvatarUrl: author?.profile_image_url ?? null,
    text: unescapeText(text),
    createdAt: tweet.created_at,
    metrics: {
      likes: m?.like_count ?? 0,
      replies: m?.reply_count ?? 0,
      reposts: m?.retweet_count ?? 0,
      quotes: m?.quote_count ?? 0,
      bookmarks: m?.bookmark_count ?? 0,
      impressions: m?.impression_count ?? 0,
    },
    entities,
    quotedPostId: quoted?.id ?? null,
    media: media.length > 0 ? media : null,
    fetchedAt,
  };
}

function mediaMap(includes: Includes | undefined): Map<string, ApiMedia> {
  return new Map((includes?.media ?? []).map((m) => [m.media_key, m]));
}

/**
 * The X API surface the routes actually use. XApi's private members make the
 * class nominal, so depending on the class would force every test double to
 * be the real network client.
 */
export type XApiClient = Pick<
  XApi,
  | "getPost"
  | "getPostsByIds"
  | "fetchConversation"
  | "getMe"
  | "getOwnPosts"
  | "getBookmarkFolders"
  | "getBookmarksByFolder"
>;

export interface XApiOptions {
  /** Pause between paginated requests; 0 in tests, which don't rate-limit. */
  pageDelayMs?: number;
}

export class XApi {
  private readonly pageDelayMs: number;

  constructor(
    private readonly bearerToken: string,
    opts: XApiOptions = {},
  ) {
    this.pageDelayMs = opts.pageDelayMs ?? PAGE_DELAY_MS;
  }

  /**
   * @param schema the shape this endpoint promises; the body is held to it
   * rather than asserted into place, so a wire change surfaces here instead
   * of as an empty conversation further down.
   * @param token overrides the app-only bearer, for user-context endpoints
   * (own posts, bookmarks) that the app-only token can't reach.
   */
  private async get<TSchema extends v.GenericSchema>(
    path: string,
    schema: TSchema,
    params: Record<string, string>,
    token?: string,
  ): Promise<v.InferOutput<TSchema>> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const headers = { Authorization: `Bearer ${token ?? this.bearerToken}` };
    let response = await fetch(url, { headers });
    if (response.status === 429 || response.status >= 500) {
      const resetHeader = response.headers.get("x-rate-limit-reset");
      const waitMs =
        response.status === 429
          ? resetHeader
            ? Math.max(0, Number(resetHeader) * 1000 - Date.now()) + 1000
            : 5000
          : 2000;
      await sleep(Math.min(waitMs, 60_000));
      response = await fetch(url, { headers });
    }
    if (!response.ok) {
      // X's own error JSON is short; an intermediary's error page is not.
      // This message travels into logs and API responses, so the body is
      // capped — the useful part of an error description fits well inside it.
      const body = (await response.text()).slice(0, 300);
      throw new XApiError(`X API ${response.status} on ${path}: ${body}`, response.status);
    }
    const parsed = v.safeParse(schema, await response.json());
    if (!parsed.success) throw new XApiShapeError(path, summarizeIssues(parsed.issues));
    return parsed.output;
  }

  /**
   * The authenticated user (user-context). Confirms the token works, and
   * bills one user read at the post-read rate.
   */
  async getMe(
    accessToken: string,
  ): Promise<Billed<{ id: string; username: string; name: string }>> {
    const result = await this.get("/users/me", MeResponseSchema, {}, accessToken);
    if (!result.data) throw new XApiError("could not resolve the authenticated user", 401);
    return { value: result.data, receipt: postReads(1) };
  }

  /**
   * One page of the signed-in user's own posts (Owned Read, $0.001 each).
   *
   * exclude=replies drops replies to other people but keeps the user's own
   * thread continuations (verified: of 49 posts returned, 23 were replies
   * and 22 of those continued a thread whose root was also in the page). So
   * it yields exactly what thread grouping needs, without paying to read
   * every reply the user made inside someone else's conversation.
   */
  async getOwnPosts(
    accessToken: string,
    userId: string,
    opts: { max?: number; paginationToken?: string } = {},
  ): Promise<Billed<{ posts: Post[]; nextToken?: string }>> {
    const params: Record<string, string> = {
      max_results: String(Math.min(Math.max(opts.max ?? 50, 5), 100)),
      exclude: "replies,retweets",
      "tweet.fields": POST_FIELDS,
      expansions: EXPANSIONS,
      "user.fields": USER_FIELDS,
      "media.fields": MEDIA_FIELDS,
    };
    if (opts.paginationToken) params.pagination_token = opts.paginationToken;
    const page = await this.get(`/users/${userId}/tweets`, SearchPageSchema, params, accessToken);
    const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
    const media = mediaMap(page.includes);
    const fetchedAt = new Date().toISOString();
    const posts = (page.data ?? []).map((tweet) => toPost(tweet, users, media, fetchedAt));
    return {
      value: { posts, nextToken: page.meta?.next_token },
      receipt: ownedReads(posts.length),
    };
  }

  /**
   * The user's bookmark folders (user context; requires bookmark.read).
   * Folders aren't posts, so nothing here is a read X bills for.
   */
  async getBookmarkFolders(
    accessToken: string,
    userId: string,
  ): Promise<Billed<{ id: string; name: string }[]>> {
    const result = await this.get(
      `/users/${userId}/bookmarks/folders`,
      BookmarkFoldersSchema,
      {},
      accessToken,
    );
    return { value: result.data ?? [], receipt: NO_READS };
  }

  /**
   * Posts saved in one bookmark folder.
   *
   * This endpoint accepts only id/folder_id/max_results/pagination_token —
   * no field or expansion parameters — so it yields bare post stubs. The IDs
   * are then hydrated through the lookup endpoint to get authors, entities,
   * and media.
   *
   * `complete` is false when maxPages ran out with the folder still going.
   * Callers reconcile against this list, and a partial one is indistinguishable
   * from the user having un-bookmarked everything past the cap — so the flag
   * is what lets them refuse to act on a half-read folder.
   *
   * Two rates in one receipt: the folder pages are Owned Reads of the stubs
   * they return, and the hydration below is a lookup at the post-read rate.
   * X's dedup may well forgive the second reading of an id it just served as
   * a stub; counting both is the estimate that can't understate the bill.
   */
  async getBookmarksByFolder(
    accessToken: string,
    userId: string,
    folderId: string,
    maxPages = 10,
  ): Promise<Billed<{ posts: Post[]; ids: string[]; complete: boolean }>> {
    const ids: string[] = [];
    let paginationToken: string | undefined;
    let complete = false;
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { max_results: "100" };
      if (paginationToken) params.pagination_token = paginationToken;
      const result = await this.get(
        `/users/${userId}/bookmarks/folders/${folderId}`,
        BookmarkFolderPageSchema,
        params,
        accessToken,
      );
      ids.push(...(result.data ?? []).map((t) => t.id));
      paginationToken = result.meta?.next_token;
      if (!paginationToken) {
        complete = true;
        break;
      }
    }
    // ids and posts are returned separately: hydration can silently drop a
    // post whose author went private or deleted it, and a bookmark that
    // failed to hydrate is still a bookmark — reconciling removals against
    // the hydrated subset would delete it (Stage 0 adversarial review).
    const hydrated =
      ids.length > 0 ? await this.getPostsByIds(ids) : { value: [], receipt: NO_READS };
    return {
      value: { posts: hydrated.value, ids, complete },
      receipt: addReceipts(ownedReads(ids.length), hydrated.receipt),
    };
  }

  /** Look up a single post ($0.005). */
  async getPost(id: string): Promise<Billed<Post>> {
    const result = await this.get(`/tweets/${id}`, TweetLookupSchema, {
      "tweet.fields": POST_FIELDS,
      expansions: EXPANSIONS,
      "user.fields": USER_FIELDS,
      "media.fields": MEDIA_FIELDS,
    });
    if (!result.data) {
      const detail = result.errors?.[0]?.detail ?? "post not found or unavailable";
      throw new XApiError(detail, 404);
    }
    const users = new Map((result.includes?.users ?? []).map((u) => [u.id, u]));
    return {
      value: toPost(result.data, users, mediaMap(result.includes), new Date().toISOString()),
      receipt: postReads(1),
    };
  }

  /**
   * Fetch specific posts by ID (up to 100 per request), media fully resolved.
   * Billed per post returned, so ids X had nothing for cost nothing.
   */
  async getPostsByIds(ids: string[]): Promise<Billed<Post[]>> {
    const results: Post[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const page = await this.get("/tweets", SearchPageSchema, {
        ids: ids.slice(i, i + 100).join(","),
        "tweet.fields": POST_FIELDS,
        expansions: EXPANSIONS,
        "user.fields": USER_FIELDS,
        "media.fields": MEDIA_FIELDS,
      });
      const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
      const media = mediaMap(page.includes);
      const fetchedAt = new Date().toISOString();
      for (const tweet of page.data ?? []) {
        results.push(toPost(tweet, users, media, fetchedAt));
      }
    }
    return { value: results, receipt: postReads(results.length) };
  }

  /**
   * Fetch every post in a conversation via full-archive search, paginated.
   * Never requests more than maxPosts allows, stopping at or below it and
   * reporting truncation.
   *
   * Billed $0.005 per post a page returned, `includes` posts included: we
   * ingest and render those, so we count them. A post a page returns twice —
   * as a result and again as another post's referenced parent — is one read;
   * one page is one response, and X cannot bill the same post twice for
   * serving it once. The media re-lookup below is a second response, so its
   * receipt adds (2026-07-30 review, H1).
   */
  async fetchConversation(
    conversationId: string,
    maxPosts: number,
    sinceId?: string,
  ): Promise<Billed<FetchedConversation>> {
    const fetchedAt = new Date().toISOString();
    const posts: Post[] = [];
    const referencedById = new Map<string, Post>();
    const unresolvedMedia = new Set<string>();
    let nextToken: string | undefined;
    let truncated = false;
    let receipt = NO_READS;

    // Without start_time, /tweets/search/all quietly searches only the last 30
    // days and an older conversation comes back missing its history — no error,
    // no truncation flag. The root's ID dates the conversation, so bound the
    // window there. since_id already bounds it, and the two can't both apply.
    // A conversation ID that isn't a snowflake can't date anything: send no
    // start_time and let X apply its default rather than fabricate a bound —
    // the search itself will come back empty for an ID this malformed anyway.
    const conversationMs = sinceId ? null : snowflakeMs(conversationId);
    const startTime =
      conversationMs === null ? undefined : rfc3339(conversationMs - START_TIME_MARGIN_MS);

    for (;;) {
      // Ask for no more than the budget allows: checking the cap only after a
      // full 100-post page would bill for up to 99 posts past it. The API
      // won't serve a page smaller than MIN_PAGE_SIZE, so a budget with less
      // than that left ends the fetch short rather than overshooting.
      const remaining = maxPosts - posts.length;
      if (remaining < MIN_PAGE_SIZE) {
        truncated = true;
        break;
      }

      const params: Record<string, string> = {
        query: `conversation_id:${conversationId}`,
        max_results: String(Math.min(PAGE_SIZE, remaining)),
        "tweet.fields": POST_FIELDS,
        expansions: EXPANSIONS,
        "user.fields": USER_FIELDS,
        "media.fields": MEDIA_FIELDS,
      };
      if (sinceId) params.since_id = sinceId;
      if (startTime) params.start_time = startTime;
      if (nextToken) params.next_token = nextToken;

      const page = await this.get("/tweets/search/all", SearchPageSchema, params);
      const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
      const media = mediaMap(page.includes);
      const pageIds = new Set<string>();
      for (const tweet of page.data ?? []) {
        posts.push(toPost(tweet, users, media, fetchedAt));
        pageIds.add(tweet.id);
      }
      for (const tweet of page.includes?.tweets ?? []) {
        const post = toPost(tweet, users, media, fetchedAt);
        referencedById.set(post.id, post);
        pageIds.add(post.id);
        if ((tweet.attachments?.media_keys?.length ?? 0) > 0 && post.media === null) {
          unresolvedMedia.add(post.id);
        }
      }
      receipt = addReceipts(receipt, postReads(pageIds.size));

      nextToken = page.meta?.next_token;
      if (!nextToken) break;
      await sleep(this.pageDelayMs);
    }

    // Referenced posts arrive without their media objects (the API only ships
    // media for main results); re-look them up to resolve images.
    const postIds = new Set(posts.map((p) => p.id));
    const toRefetch = [...unresolvedMedia].filter((id) => !postIds.has(id));
    if (toRefetch.length > 0) {
      const refetched = await this.getPostsByIds(toRefetch);
      for (const post of refetched.value) {
        referencedById.set(post.id, post);
      }
      receipt = addReceipts(receipt, refetched.receipt);
    }

    return { value: { posts, referenced: [...referencedById.values()], truncated }, receipt };
  }
}

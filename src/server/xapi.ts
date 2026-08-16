import * as v from "valibot";
import {
  NO_READS,
  addReceipts,
  ownedReads,
  postReads,
  receiptCount,
  userReads,
  type Receipt,
} from "../shared/pricing";
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
/** Bound token-chasing; at the endpoint's maximum page size this covers 1,000 folders. */
const MAX_BOOKMARK_FOLDER_PAGES = 10;
/** Largest page we ask /tweets/search/all for. */
export const SEARCH_PAGE_SIZE = 100;
/** Smallest page /tweets/search/all accepts; asking for less is a 400. */
export const MIN_SEARCH_PAGE_SIZE = 10;
/**
 * Gap between paginated requests. Full-archive search paces at roughly 1 req/s
 * on this tier and answers 429 above it, so the extra 100ms is headroom, not
 * an arbitrary round number — "optimizing" this toward zero buys rate limits
 * (docs/x-api-notes.md N7).
 */
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

/** One /tweets/search/all response, parsed. */
export interface ConversationPage {
  posts: Post[];
  /** Referenced posts from includes (quoted posts, recovered parents). */
  referenced: Post[];
  /**
   * Referenced posts X shipped with media keys but no media objects — the
   * endpoint only attaches media to main results (docs/x-api-notes.md N9).
   * Looking them up again is how their images resolve, and that is a second
   * response, so the caller decides whether it is worth another read.
   */
  unresolvedMediaIds: string[];
  /** Absent when this was the last page: the search has nothing more. */
  nextToken?: string;
}

/** A requested post the lookup couldn't return. */
export interface MissingPost {
  id: string;
  /** X's stated reason ("Not Found Error", "Authorization Error") when it gave one. */
  reason?: string;
}

export interface SearchPageOptions {
  /** Between MIN_SEARCH_PAGE_SIZE and SEARCH_PAGE_SIZE; the caller's budget. */
  maxResults: number;
  /** Only posts newer than this ID. */
  sinceId?: string;
  /** Only posts older than this ID; exclusive, per the endpoint's docs. */
  untilId?: string;
  /** Continues a search; the pacing gap is taken before the request. */
  nextToken?: string;
  /**
   * Lower bound on time, from `conversationStartTime`. Ignored when `sinceId`
   * is set — that already bounds the range, and the two can't both apply.
   */
  startTime?: string;
}

export interface PostLookupOptions {
  /** Durable ownership/progress check immediately before each 100-id request. */
  beforeRequest?: () => void | Promise<void>;
}

export interface BookmarkFolderLookupOptions {
  /** Bound enumeration even if X keeps returning pagination tokens. */
  maxPages?: number;
  /** Durable ownership check before every enumeration and hydration request. */
  beforeRequest?: () => void | Promise<void>;
}

/**
 * Where a conversation's search window opens, or undefined when it can't be
 * derived.
 *
 * Sending start_time at all is what stops /tweets/search/all from silently
 * searching just the last 30 days and returning an old conversation shorn of
 * its history, with no error and no truncation flag (docs/x-api-notes.md N6).
 * The root's ID dates the conversation, so the window is bounded there. A
 * conversation ID that isn't a snowflake can't date anything: send no
 * start_time and let X apply its default rather than fabricate a bound — the
 * search itself will come back empty for an ID this malformed anyway.
 */
export function conversationStartTime(conversationId: string): string | undefined {
  const conversationMs = snowflakeMs(conversationId);
  return conversationMs === null ? undefined : rfc3339(conversationMs - START_TIME_MARGIN_MS);
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
 * The counts are estimates — X's same-day dedup is observed, not contractual
 * (docs/x-api-notes.md N2). Where two of our calls read the same post the
 * receipts add, which is the conservative direction.
 */
export interface Billed<T> {
  readonly value: T;
  readonly receipt: Receipt;
}

/** An error can leave a paginated call with reads already billed behind it. */
interface SpentCarrier {
  spentReceipt?: Receipt;
}

/**
 * Attach the reads a failing call had already billed before it threw, merging
 * with whatever an inner call attached on the way up. A paginated fetch that
 * dies on page five bought pages one through four whether or not a value ever
 * comes back — without this, that spend would vanish with the throw, and the
 * error handler would disclose nothing.
 */
function withSpent(err: unknown, receipt: Receipt): unknown {
  if (!(err instanceof Error)) return err;
  const carrier = err as Error & SpentCarrier;
  const total = addReceipts(carrier.spentReceipt ?? NO_READS, receipt);
  if (receiptCount(total) > 0) carrier.spentReceipt = total;
  return err;
}

/** The reads an error carried out of a failed call, if any. */
export function spentOnFailure(err: unknown): Receipt | null {
  const receipt = err instanceof Error ? (err as Error & SpentCarrier).spentReceipt : undefined;
  return receipt ?? null;
}

/**
 * Undo the API's HTML escaping, which x.com's own rendering doesn't show
 * (docs/x-api-notes.md N11). `&amp;` goes last so an escaped `&amp;lt;`
 * decodes once rather than twice.
 */
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
  // Past 280 characters `text` is only a preview and `note_tweet` holds the
  // whole post — entities included, so both have to come from the same one or
  // links past the cut vanish silently (docs/x-api-notes.md N10).
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
  | "searchConversationPage"
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
    beforeRequest?: () => void | Promise<void>,
  ): Promise<v.InferOutput<TSchema>> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const headers = { Authorization: `Bearer ${token ?? this.bearerToken}` };
    await beforeRequest?.();
    let response = await fetch(url, { headers });
    // Exactly one retry, and a bounded wait. Once, because a call that fails
    // twice is a condition that won't clear inside a page load, and each
    // attempt of a *successful* call is money; bounded, because this runs
    // inside a request holding an open spend meter, and a reset header far in
    // the future would otherwise park it there until the runtime kills it.
    if (response.status === 429 || response.status >= 500) {
      const resetHeader = response.headers.get("x-rate-limit-reset");
      const waitMs =
        response.status === 429
          ? resetHeader
            ? Math.max(0, Number(resetHeader) * 1000 - Date.now()) + 1000
            : 5000
          : 2000;
      await sleep(Math.min(waitMs, 60_000));
      await beforeRequest?.();
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
   * bills one User Read — $0.010, twice a post read and the priciest single
   * call this app makes (docs/x-api-notes.md N1).
   */
  async getMe(
    accessToken: string,
  ): Promise<Billed<{ id: string; username: string; name: string }>> {
    const result = await this.get("/users/me", MeResponseSchema, {}, accessToken);
    if (!result.data) throw new XApiError("could not resolve the authenticated user", 401);
    return { value: result.data, receipt: userReads(1) };
  }

  /**
   * One page of the signed-in user's own posts (Owned Read, $0.001 each).
   *
   * exclude=replies drops replies to other people but keeps the user's own
   * thread continuations (verified: of 49 posts returned, 23 were replies
   * and 22 of those continued a thread whose root was also in the page). So
   * it yields exactly what thread grouping needs, without paying to read
   * every reply the user made inside someone else's conversation.
   *
   * X's docs say otherwise, and this repo asserted the docs' version — just
   * as confidently — until it was measured. Before flipping it back, read
   * docs/x-api-notes.md N3, which keeps the history so a third flip needs new
   * numbers rather than new confidence.
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
    const folders: { id: string; name: string }[] = [];
    let paginationToken: string | undefined;
    for (let page = 0; page < MAX_BOOKMARK_FOLDER_PAGES; page++) {
      const params: Record<string, string> = { max_results: "100" };
      if (paginationToken) {
        params.pagination_token = paginationToken;
      }
      const result = await this.get(
        `/users/${userId}/bookmarks/folders`,
        BookmarkFoldersSchema,
        params,
        accessToken,
      );
      // Unlike bookmark-item sync, this route has nowhere to represent an
      // incomplete result. Returning the data beside errors would make a
      // partial page look like the user's complete folder picker.
      if ((result.errors?.length ?? 0) > 0) {
        throw new XApiError("X returned an incomplete bookmark folder list", 502);
      }
      folders.push(...(result.data ?? []));
      paginationToken = result.meta?.next_token;
      if (!paginationToken) return { value: folders, receipt: NO_READS };
    }
    throw new XApiError(
      `bookmark folder list exceeded the ${MAX_BOOKMARK_FOLDER_PAGES}-page safety limit`,
      502,
    );
  }

  /**
   * Posts saved in one bookmark folder.
   *
   * This endpoint accepts only id/folder_id/max_results/pagination_token —
   * no field or expansion parameters — so it yields bare post stubs
   * (docs/x-api-notes.md N8). The IDs are then hydrated through the lookup
   * endpoint to get authors, entities, and media.
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
    opts: BookmarkFolderLookupOptions = {},
  ): Promise<
    Billed<{ posts: Post[]; ids: string[]; missing: MissingPost[]; complete: boolean }>
  > {
    const maxPages = opts.maxPages ?? 10;
    const ids: string[] = [];
    let paginationToken: string | undefined;
    let complete = false;
    let sawEnumerationError = false;
    try {
      for (let page = 0; page < maxPages; page++) {
        const params: Record<string, string> = { max_results: "100" };
        if (paginationToken) params.pagination_token = paginationToken;
        const result = await this.get(
          `/users/${userId}/bookmarks/folders/${folderId}`,
          BookmarkFolderPageSchema,
          params,
          accessToken,
          opts.beforeRequest,
        );
        // A 2xx response can contain data and errors together, or only
        // errors. Keep any IDs it did enumerate so additions can still make
        // progress, but never call the overall scan complete: missing IDs
        // are not affirmative evidence that the user un-bookmarked them.
        sawEnumerationError ||= (result.errors?.length ?? 0) > 0;
        ids.push(...(result.data ?? []).map((t) => t.id));
        paginationToken = result.meta?.next_token;
        if (!paginationToken) {
          complete = !sawEnumerationError;
          break;
        }
      }
      // ids and posts are returned separately: hydration can drop a post
      // whose author went private or deleted it, and a bookmark that failed
      // to hydrate is still a bookmark — reconciling removals against the
      // hydrated subset would delete it (Stage 0 adversarial review).
      // `missing` names those drops so callers can report them.
      const hydrated =
        ids.length > 0
          ? await this.getPostsByIds(ids, { beforeRequest: opts.beforeRequest })
          : { value: { posts: [], missing: [] }, receipt: NO_READS };
      return {
        value: { ...hydrated.value, ids, complete },
        receipt: addReceipts(ownedReads(ids.length), hydrated.receipt),
      };
    } catch (err) {
      throw withSpent(err, ownedReads(ids.length));
    }
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
   *
   * Requested ids that come back without a post are returned in `missing`
   * rather than silently dropped — a bookmark whose author went private is
   * still a bookmark, and callers can only say so when the loss is visible.
   * A partial failure here is an HTTP 200 with entries in `errors[]`, whose
   * shape varies by variant, so reasons are attributed by id where one is
   * given and absence-from-data is the backstop for the rest
   * (docs/x-api-notes.md N12).
   */
  async getPostsByIds(
    ids: string[],
    opts: PostLookupOptions = {},
  ): Promise<Billed<{ posts: Post[]; missing: MissingPost[] }>> {
    const posts: Post[] = [];
    const reasons = new Map<string, string | undefined>();
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const page = await this.get("/tweets", SearchPageSchema, {
          ids: ids.slice(i, i + 100).join(","),
          "tweet.fields": POST_FIELDS,
          expansions: EXPANSIONS,
          "user.fields": USER_FIELDS,
          "media.fields": MEDIA_FIELDS,
        }, undefined, opts.beforeRequest);
        const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
        const media = mediaMap(page.includes);
        const fetchedAt = new Date().toISOString();
        for (const tweet of page.data ?? []) {
          posts.push(toPost(tweet, users, media, fetchedAt));
        }
        for (const error of page.errors ?? []) {
          const id = error.resource_id ?? error.value;
          if (id) reasons.set(id, error.title ?? error.detail);
        }
      }
    } catch (err) {
      throw withSpent(err, postReads(posts.length));
    }
    const returned = new Set(posts.map((p) => p.id));
    const missing = ids
      .filter((id) => !returned.has(id))
      .map((id) => ({ id, reason: reasons.get(id) }));
    return { value: { posts, missing }, receipt: postReads(posts.length) };
  }

  /**
   * One page of a conversation from full-archive search: one request, one
   * response, no loop. Paging, budgets and what to keep are the caller's;
   * this end only knows the wire.
   *
   * No token is passed, deliberately: /tweets/search/all works with the
   * app-only bearer and rejects user-context tokens, so collapsing this class
   * down to one token would break conversation fetching entirely
   * (docs/x-api-notes.md N5).
   *
   * Billed $0.005 per post the page returned, `includes` posts included: we
   * ingest and render those, so we count them. A post the page returns twice —
   * as a result and again as another post's referenced parent — is one read;
   * one page is one response, and X cannot bill the same post twice for
   * serving it once (2026-07-30 review, H1).
   */
  async searchConversationPage(
    conversationId: string,
    opts: SearchPageOptions,
  ): Promise<Billed<ConversationPage>> {
    const params: Record<string, string> = {
      query: `conversation_id:${conversationId}`,
      max_results: String(opts.maxResults),
      "tweet.fields": POST_FIELDS,
      expansions: EXPANSIONS,
      "user.fields": USER_FIELDS,
      "media.fields": MEDIA_FIELDS,
    };
    if (opts.sinceId) params.since_id = opts.sinceId;
    if (opts.untilId) params.until_id = opts.untilId;
    // since_id already bounds the range, and the two can't both apply.
    if (opts.startTime && !opts.sinceId) params.start_time = opts.startTime;
    // Pacing belongs with the request rather than with the caller's loop: any
    // caller walking this endpoint owes X the same gap between pages.
    if (opts.nextToken) {
      params.next_token = opts.nextToken;
      await sleep(this.pageDelayMs);
    }

    const page = await this.get("/tweets/search/all", SearchPageSchema, params);
    const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
    const media = mediaMap(page.includes);
    const fetchedAt = new Date().toISOString();
    const pageIds = new Set<string>();
    const posts: Post[] = [];
    const referenced: Post[] = [];
    const unresolvedMediaIds: string[] = [];
    for (const tweet of page.data ?? []) {
      posts.push(toPost(tweet, users, media, fetchedAt));
      pageIds.add(tweet.id);
    }
    for (const tweet of page.includes?.tweets ?? []) {
      const post = toPost(tweet, users, media, fetchedAt);
      referenced.push(post);
      pageIds.add(post.id);
      if ((tweet.attachments?.media_keys?.length ?? 0) > 0 && post.media === null) {
        unresolvedMediaIds.push(post.id);
      }
    }
    return {
      value: { posts, referenced, unresolvedMediaIds, nextToken: page.meta?.next_token },
      receipt: postReads(pageIds.size),
    };
  }
}

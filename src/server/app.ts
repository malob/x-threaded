import { Hono, type Context } from "hono";
import * as v from "valibot";
import { clamp, parseIntStrict } from "../shared/num";
import { ownedReads, postReads } from "../shared/pricing";
import type {
  ApiError,
  AuthRequiredError,
  AuthStatus,
  ConversationResponse,
  FetchCost,
  FoldersResponse,
  OkResponse,
  OwnPostsResponse,
  OwnThread,
  Post,
  RefreshResponse,
  ResolveResponse,
  SavedListResponse,
  SettingsResponse,
  SyncResponse,
} from "../shared/types";
import { parsePostUrl } from "../shared/urls";
import { runConversationFetch } from "./conversation-fetch";
import { conversationResponse } from "./conversations";
import { SpendMeter } from "./meter";
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  newState,
  OAuthError,
  SELF_ID,
  type OAuthConfig,
} from "./oauth";
import { jsonBody } from "./request";
import { getQuotedFor, type Storage } from "./storage";
import { groupOwnThreads } from "./threads";
import { userContext } from "./user-context";
import { spentOnFailure, XApiError, XApiShapeError, type XApiClient } from "./xapi";

export interface AppDeps {
  store: Storage;
  xapi: XApiClient;
  /** Safety cap on posts fetched per conversation load. */
  maxPosts: number;
  /** Null when the deployment has no OAuth user context configured. */
  oauth?: OAuthConfig | null;
}

/** Where every "you need to (re)connect" answer points. */
const LOGIN_URL = "/auth/login";

const BOOKMARK_FOLDER_KEY = "bookmark_folder_id";
const BOOKMARK_FOLDER_NAME_KEY = "bookmark_folder_name";

/** How many of the user's threads /api/me/posts returns when it isn't told. */
const DEFAULT_THREADS = 10;
/** Every extra thread asked for is more timeline to page through, and pages bill. */
const MAX_THREADS = 50;

/**
 * X statuses that mean something to the client and so travel unchanged:
 * "sign in again", "you lack the scope", "not there", "slow down". Every
 * other X failure is the upstream being upstream, and reads as a 502.
 */
const PRESERVED_STATUSES = [401, 403, 404, 429] as const;
type PreservedStatus = (typeof PRESERVED_STATUSES)[number];

function isPreserved(status: number): status is PreservedStatus {
  return PRESERVED_STATUSES.includes(status as PreservedStatus);
}

/**
 * Per-request state. The meter is optional because it is created on the first
 * X call and not before: a request that reads nothing has nothing to meter,
 * and the error handler tells the two apart by its absence.
 */
type AppEnv = { Variables: { meter?: SpendMeter } };

/** The app `buildApp` returns, carrying its per-request variables. */
export type ApiApp = Hono<AppEnv>;

/** This request's spend meter, created on first use. */
function meterOf(c: Context<AppEnv>): SpendMeter {
  const existing = c.get("meter");
  if (existing) return existing;
  const meter = new SpendMeter();
  c.set("meter", meter);
  return meter;
}

/** What POST /api/conversations accepts; `url` is validated by parsePostUrl. */
const ConversationRequest = v.object({
  url: v.optional(v.string()),
  force: v.optional(v.boolean()),
});

/**
 * Patch semantics, so absent and null are different answers: no
 * bookmarkFolderId at all leaves the choice alone, an explicit null clears
 * it. The schema has to admit both for the route to keep telling them apart.
 */
const SettingsPatch = v.object({
  bookmarkFolderId: v.optional(v.nullable(v.string())),
  bookmarkFolderName: v.optional(v.string()),
});

const ReadStateRequest = v.object({
  postIds: v.array(v.string()),
  read: v.boolean(),
});

/** The API routes, independent of runtime (Bun server or Cloudflare Worker). */
export function buildApp({ store, xapi, maxPosts, oauth = null }: AppDeps): ApiApp {
  const app = new Hono<AppEnv>();

  /**
   * Queue a conversation for reading unless something already stands for it:
   * an entry on any post in the thread (a bookmarked mid-thread reply is the
   * common one), or it being the user's own thread, which the Your posts tab
   * covers. That last check applies only while OAuth is configured — a userId
   * left behind by a removed setup must not suppress the one place the
   * thread would still be findable.
   */
  async function saveUnlessRepresented(rootId: string, rootAuthorId: string | null): Promise<void> {
    const self = oauth ? ((await store.getOAuthTokens(SELF_ID))?.userId ?? null) : null;
    if (self !== null && rootAuthorId === self) return;
    if (await store.hasSavedConversation(rootId)) return;
    await store.addSavedItems([
      { postId: rootId, source: "manual", addedAt: new Date().toISOString() },
    ]);
  }

  app.onError((err, c) => {
    // Money moves before a request finishes, and the reads it already paid
    // for are not refunded by throwing. Every error body carries the estimate
    // when there is one to carry — including the pages a paginated call
    // bought before it died, which ride out on the error itself because no
    // value ever came back to charge (2026-07-30 review, H1).
    const failed = spentOnFailure(err);
    const meter = failed ? meterOf(c) : c.get("meter");
    if (failed && meter) meter.absorb(failed);
    const spent: { cost?: FetchCost } = meter?.spent ? { cost: meter.cost() } : {};

    if (err instanceof XApiError) {
      console.error(`X API error (${err.status}): ${err.message}`);
      return c.json(
        { error: err.message, ...spent } satisfies ApiError,
        isPreserved(err.status) ? err.status : 502,
      );
    }
    if (err instanceof XApiShapeError) {
      // The full issue list is for us; the client gets the endpoint only.
      console.error(`X API shape error on ${err.path}: ${err.issues}`);
      return c.json({ error: err.message, ...spent } satisfies ApiError, 502);
    }
    if (err instanceof OAuthError) {
      // A grant that is gone or unusable is an authentication problem, and
      // the only thing the user can do about it is connect again.
      console.error(err);
      return c.json(
        { error: err.message, loginUrl: LOGIN_URL, ...spent } satisfies AuthRequiredError,
        401,
      );
    }
    // Anything unclassified is ours, and its message is an internal detail —
    // a stack-adjacent string, a driver error, whatever threw. Log it in
    // full; tell the client only that it happened.
    console.error(err);
    return c.json({ error: "internal error", ...spent } satisfies ApiError, 500);
  });

  /**
   * Interactive consent. Tokens minted in the developer portal lack
   * bookmark.read, so this flow is how the app gets a fully-scoped token.
   * The PKCE verifier and state ride in a short-lived httpOnly cookie
   * rather than server state.
   */
  app.get("/auth/login", async (c) => {
    if (!oauth) return c.json({ error: "OAuth is not configured" } satisfies ApiError, 400);
    const { verifier, challenge } = await createPkce();
    const state = newState();
    const redirectUri = new URL("/auth/callback", c.req.url).toString();
    c.header(
      "Set-Cookie",
      `x_pkce=${verifier}.${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`,
    );
    return c.redirect(authorizeUrl(oauth, redirectUri, state, challenge));
  });

  app.get("/auth/callback", async (c) => {
    if (!oauth) return c.json({ error: "OAuth is not configured" } satisfies ApiError, 400);
    const code = c.req.query("code");
    const state = c.req.query("state");
    const denied = c.req.query("error");
    if (denied) {
      return c.json({ error: `authorization denied: ${denied}` } satisfies ApiError, 400);
    }
    if (!code || !state) return c.json({ error: "missing code or state" } satisfies ApiError, 400);

    const cookie = /(?:^|;\s*)x_pkce=([^;]+)/.exec(c.req.header("Cookie") ?? "")?.[1];
    const [verifier, expectedState] = (cookie ?? "").split(".");
    if (!verifier || !expectedState || expectedState !== state) {
      return c.json({ error: "state mismatch — restart the login" } satisfies ApiError, 400);
    }

    const redirectUri = new URL("/auth/callback", c.req.url).toString();
    await exchangeCode(store, oauth, code, verifier, redirectUri);
    c.header("Set-Cookie", "x_pkce=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0");
    // Back to the app rather than a JSON dump; the inbox reflects the new state.
    return c.redirect("/");
  });

  /** Bookmark folders, for choosing which one feeds the saved tab. */
  app.get("/api/bookmarks/folders", async (c) => {
    const meter = meterOf(c);
    const { token, userId } = await userContext(store, xapi, oauth, meter);
    return c.json({
      folders: meter.charge(await xapi.getBookmarkFolders(token, userId)),
      // Folders are free, but the first-ever call here pays a getMe to learn
      // who "the user" is — spend that would otherwise leave no trace.
      ...(meter.spent ? { cost: meter.cost() } : {}),
    } satisfies FoldersResponse);
  });

  app.get("/api/settings", async (c) => {
    return c.json({
      bookmarkFolderId: await store.getSetting(BOOKMARK_FOLDER_KEY),
      bookmarkFolderName: await store.getSetting(BOOKMARK_FOLDER_NAME_KEY),
    } satisfies SettingsResponse);
  });

  app.patch("/api/settings", async (c) => {
    const parsed = await jsonBody(c.req.raw, SettingsPatch);
    if (!parsed.ok) return c.json({ error: parsed.error } satisfies ApiError, 400);
    const body = parsed.body;
    if (body.bookmarkFolderId !== undefined) {
      await store.setSetting(BOOKMARK_FOLDER_KEY, body.bookmarkFolderId ?? "");
      await store.setSetting(BOOKMARK_FOLDER_NAME_KEY, body.bookmarkFolderName ?? "");
    }
    return c.json({
      bookmarkFolderId: await store.getSetting(BOOKMARK_FOLDER_KEY),
      bookmarkFolderName: await store.getSetting(BOOKMARK_FOLDER_NAME_KEY),
    } satisfies SettingsResponse);
  });

  /**
   * Mirror the chosen bookmark folder into the saved list, one-way from X:
   * bookmarking adds, un-bookmarking removes. Only entries this sync owns
   * (source "bookmark") are reconciled — posts added by hand in the app are
   * left alone — and removal drops the queue entry only, never the cached
   * conversation or its read state.
   *
   * Removal happens only when the folder scan finished; a folder past the
   * scan's page cap syncs additions and reports `complete: false` rather than
   * treating everything it didn't reach as un-bookmarked.
   */
  app.post("/api/bookmarks/sync", async (c) => {
    const folderId = await store.getSetting(BOOKMARK_FOLDER_KEY);
    if (!folderId) {
      return c.json({ error: "no bookmark folder selected" } satisfies ApiError, 400);
    }
    const meter = meterOf(c);
    const { token, userId } = await userContext(store, xapi, oauth, meter);
    const { posts, ids, complete } = meter.charge(
      await xapi.getBookmarksByFolder(token, userId, folderId),
    );
    // Before the upsert, which overwrites fetched_at: hydrating a post read
    // earlier today is the part X's same-day dedup covers. The folder pages
    // themselves are not credited — they enumerate rather than return posts,
    // and whether that dedups is exactly the soft part of the rule.
    meter.credit(postReads((await store.postIdsReadToday(posts.map((p) => p.id))).size));
    await store.upsertPosts(posts);

    // Identity comes from the enumerated folder IDs, not the hydrated posts:
    // hydration drops posts that went private or were deleted, and those are
    // still bookmarks — not removals.
    const inFolder = new Set(ids);
    const existing = await store.listSavedItems();
    const known = new Set(existing.map((i) => i.postId));

    const fresh = posts.filter((p) => !known.has(p.id));
    await store.addSavedItems(
      fresh.map((p) => ({ postId: p.id, source: "bookmark", addedAt: new Date().toISOString() })),
    );

    // Removing is only safe once the whole folder has been enumerated: on a
    // partial scan the unread tail is indistinguishable from un-bookmarking,
    // so a large folder would delete its own live entries. Adding is safe
    // either way, so an incomplete sync still makes progress.
    const gone = complete
      ? existing.filter((i) => i.source === "bookmark" && !inFolder.has(i.postId))
      : [];
    await store.removeSavedItems(gone.map((i) => i.postId));

    return c.json({
      synced: posts.length,
      added: fresh.length,
      removed: gone.length,
      complete,
      cost: meter.cost(),
    } satisfies SyncResponse);
  });

  /** The saved queue: bookmarked and manually added posts, newest first. */
  app.get("/api/saved", async (c) => {
    const items = await store.listSavedItems();
    const posts = await store.getPostsByIds(items.map((i) => i.postId));
    const byId = new Map(posts.map((p) => [p.id, p]));
    const hydrated = items.flatMap((item) => {
      const post = byId.get(item.postId);
      return post ? [{ item, post }] : [];
    });
    // A conversation is "loaded" when we've cached its whole tree. One query
    // for the page rather than one per row (2026-07-30 review, S3).
    const loaded = await store.hasConversations([
      ...new Set(hydrated.map(({ post }) => post.conversationId)),
    ]);
    const entries = hydrated.map(({ item, post }) => ({
      post,
      source: item.source,
      addedAt: item.addedAt,
      rootId: post.conversationId,
      loaded: loaded.has(post.conversationId),
    }));
    return c.json({
      items: entries,
      quoted: await getQuotedFor(store, posts),
    } satisfies SavedListResponse);
  });

  app.delete("/api/saved/:postId", async (c) => {
    const postId = c.req.param("postId");
    const item = await store.getSavedItem(postId);
    if (item?.source === "bookmark") {
      // Removing it here would be undone by the next sync; the folder on X is
      // the source of truth for these.
      return c.json(
        { error: "un-bookmark it on x.com — sync will remove it here" } satisfies ApiError,
        409,
      );
    }
    await store.removeSavedItem(postId);
    return c.json({ ok: true } satisfies OkResponse);
  });

  /**
   * The user's recent threads, one entry each (Owned Reads).
   *
   * The timeline's exclude=replies doesn't drop self-thread continuations, so
   * a five-part thread would otherwise appear five times. Group the scanned
   * posts by conversation and represent each by its root, dropping
   * conversations rooted by someone else — those are replies into other
   * people's threads, not the user's own posts.
   */
  app.get("/api/me/posts", async (c) => {
    // Parse before spending: Number("abc") is NaN, which makes both loop
    // guards below permanently false and pages the whole timeline for an
    // empty response (2026-07-30 review, C2).
    const raw = c.req.query("threads");
    const requestedThreads = raw === undefined ? DEFAULT_THREADS : parseIntStrict(raw);
    if (requestedThreads === null) {
      return c.json({ error: "threads must be an integer" } satisfies ApiError, 400);
    }
    const target = clamp(requestedThreads, 1, MAX_THREADS);

    const meter = meterOf(c);
    const { token, userId } = await userContext(store, xapi, oauth, meter);
    // Keep scanning until there are enough threads the user actually
    // started. Counting raw conversations would overshoot, because replies
    // into other people's threads get filtered out afterwards.
    // Re-scanning for a larger target is nearly free: posts already read
    // today don't bill again (24h dedup), so only new ground costs.
    const MAX_SCAN = Math.min(Math.max(target * 30, 300), 900);
    const posts: Post[] = [];
    let paginationToken: string | undefined;
    let items: OwnThread[] = [];
    for (;;) {
      const page = meter.charge(
        await xapi.getOwnPosts(token, userId, { max: 50, paginationToken }),
      );
      posts.push(...page.posts);
      paginationToken = page.nextToken;
      // Credit before the upsert overwrites fetched_at — the same ordering
      // ingest depends on, and what makes the re-scan above actually cheap.
      meter.credit(ownedReads((await store.postIdsReadToday(page.posts.map((p) => p.id))).size));
      await store.upsertPosts(page.posts);
      items = await groupOwnThreads(store, xapi, meter, posts, userId);
      if (items.length >= target || !paginationToken || page.posts.length === 0) break;
      if (posts.length >= MAX_SCAN) break;
    }

    const shown = items.slice(0, target);
    return c.json({
      items: shown,
      quoted: await getQuotedFor(
        store,
        shown.map((i) => i.root),
      ),
      // More to find if the timeline isn't exhausted, or we trimmed the list.
      hasMore: items.length > target || paginationToken !== undefined,
      cost: meter.cost(),
    } satisfies OwnPostsResponse);
  });

  /**
   * Whether user-context features (own posts, bookmarks) are available.
   *
   * Answered entirely from the stored row: the inbox mounts this on every
   * visit, and the old version paid a billable /2/users/me and could burn a
   * single-use refresh token to answer it (2026-07-30 review, H1). An expired
   * token still reads as authorized — renewing it is the next real request's
   * job. A grant the token manager has given up on reads as `broken`, which
   * is the one state the user has to act on, so it carries the login link and
   * the reason with it.
   */
  app.get("/api/auth/status", async (c) => {
    if (!oauth) return c.json({ state: "unconfigured" } satisfies AuthStatus);
    const stored = await store.getOAuthTokens(SELF_ID);
    if (!stored) {
      return c.json({ state: "unauthorized", loginUrl: LOGIN_URL } satisfies AuthStatus);
    }
    if (stored.state === "broken") {
      return c.json({
        state: "broken",
        reason: stored.brokenReason ?? "unknown",
        loginUrl: LOGIN_URL,
      } satisfies AuthStatus);
    }
    return c.json({
      state: "authorized",
      // Null until a getMe has been paid for elsewhere; never resolved here.
      user: stored.username
        ? { username: stored.username, name: stored.displayName ?? stored.username }
        : null,
      scopes: stored.scope ? stored.scope.split(" ") : [],
      expiresAt: stored.expiresAt,
    } satisfies AuthStatus);
  });

  // Resolve a post ID to its cached conversation, without touching the X API.
  // null means the conversation isn't cached; the client offers to fetch it.
  app.get("/api/resolve/:postId", async (c) => {
    const post = await store.getPost(c.req.param("postId"));
    const rootId =
      post && (await store.hasConversation(post.conversationId)) ? post.conversationId : null;
    // The reply count lets the client estimate a fetch before committing to
    // it; null when we've never seen the post, so no estimate is shown.
    return c.json({
      rootId,
      replyCount: post?.metrics.replies ?? null,
    } satisfies ResolveResponse);
  });

  app.get("/api/conversations/:rootId", async (c) => {
    const rootId = c.req.param("rootId");
    if (!(await store.hasConversation(rootId))) {
      return c.json({ error: "conversation not cached" } satisfies ApiError, 404);
    }
    return c.json(
      (await conversationResponse(store, rootId, null, {
        fromCache: true,
      })) satisfies ConversationResponse,
    );
  });

  app.post("/api/conversations", async (c) => {
    const parsed = await jsonBody(c.req.raw, ConversationRequest);
    if (!parsed.ok) return c.json({ error: parsed.error } satisfies ApiError, 400);
    const body = parsed.body;
    const postId = body.url ? parsePostUrl(body.url) : null;
    if (!postId) {
      return c.json(
        { error: "could not parse a post URL or ID from input" } satisfies ApiError,
        400,
      );
    }

    const meter = meterOf(c);
    // Cache first: a stored post already carries its conversation ID, so a
    // conversation we've fetched before is resolvable — and servable — for
    // free. Only a post we've never seen is worth a billable lookup.
    const requested = (await store.getPost(postId)) ?? meter.charge(await xapi.getPost(postId));
    const rootId = requested.conversationId;
    const focusId = postId === rootId ? null : postId;
    const firstFetch = !(await store.hasConversation(rootId));

    if (!firstFetch && !body.force) {
      // A paste that lands on a cached conversation is still "queue this":
      // if only the fetch path saved, removing an entry would make its
      // conversation unsaveable for as long as it stays cached.
      await saveUnlessRepresented(rootId, (await store.getPost(rootId))?.authorId ?? null);
      return c.json({
        ...(await conversationResponse(store, rootId, focusId, { fromCache: true })),
        // Served from the cache, but the lookup that found out *which*
        // conversation to serve may still have been paid for above.
        ...(meter.spent ? { cost: meter.cost() } : {}),
      } satisfies ConversationResponse);
    }

    // The row is opened as `partial` before the first page and closed by
    // whatever the run turned out to be, rather than committed once at the
    // end. So a fetch that dies halfway leaves a conversation holding the
    // pages it paid for and saying it is missing history — which the cached
    // path above serves, labeled, with resume as the way to finish it. What
    // must never exist is the third option: a cache quietly claiming to be
    // whole (2026-07-30 review, H2/H3).
    const { root } = await runConversationFetch(store, xapi, meter, rootId, {
      maxPosts,
      known: [requested],
    });

    // A conversation you just pulled up is one you're about to read; unread is
    // reserved for posts that arrive later.
    if (firstFetch) await store.markConversationRead(rootId);

    // Every explicit fetch lands in the saved queue as a manual entry —
    // pasted URLs, but since ed8ea1a also inbox card clicks and deep links.
    await saveUnlessRepresented(rootId, root.authorId);

    return c.json({
      ...(await conversationResponse(store, rootId, focusId, { fromCache: false })),
      cost: meter.cost(),
    } satisfies ConversationResponse);
  });

  /**
   * Refresh *newer*: what has been said in this conversation since we last
   * looked. Resuming the history a stopped fetch skipped is a different
   * operation, and a different route.
   */
  app.post("/api/conversations/:rootId/refresh", async (c) => {
    const rootId = c.req.param("rootId");
    const meta = await store.getConversationMeta(rootId);
    if (!meta) {
      return c.json({ error: "conversation not cached" } satisfies ApiError, 404);
    }

    const meter = meterOf(c);
    const before = await store.existingPostIds(rootId);
    // Post reads deduplicate within a UTC day, so a full re-read on the same
    // day as the last *full read* is free and refreshes metrics; otherwise
    // fetch only new posts via since_id.
    //
    // The fork reads full_read_at rather than fetched_at because they answer
    // different questions. X's dedup is keyed on the posts we actually read,
    // and a since_id refresh reads a handful of new ones — so letting it move
    // the timestamp this branch tests would make the next refresh buy a whole
    // conversation believing it was free (2026-07-30 review, H2).
    const sameUtcDay =
      meta.fullReadAt !== null &&
      meta.fullReadAt.slice(0, 10) === new Date().toISOString().slice(0, 10);
    const sinceId = sameUtcDay ? null : await store.newestPostId(rootId);

    await runConversationFetch(store, xapi, meter, rootId, {
      maxPosts,
      sinceId: sinceId ?? undefined,
    });

    const newCount = (await store.existingPostIds(rootId)).size - before.size;
    return c.json({
      ...(await conversationResponse(store, rootId, null, { fromCache: false })),
      newCount,
      cost: meter.cost(),
    } satisfies RefreshResponse);
  });

  /**
   * Resume *older*: buy the history a run stopped short of.
   *
   * The search pages newest first, so what a capped or interrupted fetch is
   * missing is everything older than the oldest reply it stored — which is the
   * boundary this reads from the data itself rather than from a cursor that
   * could drift from it. Only a partial conversation has anything to resume;
   * asking about a complete one means the caller is looking at a stale view,
   * and answering 200 would hide that behind an empty result.
   */
  app.post("/api/conversations/:rootId/resume", async (c) => {
    const rootId = c.req.param("rootId");
    const meta = await store.getConversationMeta(rootId);
    if (!meta) {
      return c.json({ error: "conversation not cached" } satisfies ApiError, 404);
    }
    if (meta.status === "complete") {
      return c.json({ error: "conversation is already complete" } satisfies ApiError, 409);
    }

    const meter = meterOf(c);
    const before = await store.existingPostIds(rootId);
    const untilId = await store.oldestReplyId(rootId);

    await runConversationFetch(store, xapi, meter, rootId, {
      maxPosts,
      untilId: untilId ?? undefined,
    });

    const newCount = (await store.existingPostIds(rootId)).size - before.size;
    return c.json({
      ...(await conversationResponse(store, rootId, null, { fromCache: false })),
      newCount,
      cost: meter.cost(),
    } satisfies RefreshResponse);
  });

  app.post("/api/conversations/:rootId/read", async (c) => {
    const rootId = c.req.param("rootId");
    if (!(await store.hasConversation(rootId))) {
      return c.json({ error: "conversation not cached" } satisfies ApiError, 404);
    }
    await store.markConversationRead(rootId);
    return c.json({ ok: true } satisfies OkResponse);
  });

  app.post("/api/read-state", async (c) => {
    const parsed = await jsonBody(c.req.raw, ReadStateRequest);
    if (!parsed.ok) return c.json({ error: parsed.error } satisfies ApiError, 400);
    await store.setReadState(parsed.body.postIds, parsed.body.read);
    return c.json({ ok: true } satisfies OkResponse);
  });

  return app;
}

import { Hono } from "hono";
import { clamp, parseIntStrict } from "../shared/num";
import { POST_READ_USD } from "../shared/pricing";
import type {
  ConversationListResponse,
  ConversationResponse,
  OwnPostsResponse,
  OwnThread,
  Post,
  RefreshResponse,
} from "../shared/types";
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  getUserAccessToken,
  newState,
  type OAuthConfig,
} from "./oauth";
import { getQuotedFor, type Storage } from "./storage";
import { parsePostUrl } from "./urls";
import { XApiError, type FetchedConversation, type XApiClient } from "./xapi";

export interface AppDeps {
  store: Storage;
  xapi: XApiClient;
  /** Safety cap on posts fetched per conversation load. */
  maxPosts: number;
  /** Null when the deployment has no OAuth user context configured. */
  oauth?: OAuthConfig | null;
}

const BOOKMARK_FOLDER_KEY = "bookmark_folder_id";
const BOOKMARK_FOLDER_NAME_KEY = "bookmark_folder_name";

/** How many of the user's threads /api/me/posts returns when it isn't told. */
const DEFAULT_THREADS = 10;
/** Every extra thread asked for is more timeline to page through, and pages bill. */
const MAX_THREADS = 50;

/** The API routes, independent of runtime (Bun server or Cloudflare Worker). */
export function buildApp({ store, xapi, maxPosts, oauth = null }: AppDeps): Hono {
  async function conversationResponse(
    rootId: string,
    focusId: string | null,
    opts: { truncated?: boolean; fromCache: boolean },
  ): Promise<ConversationResponse> {
    const posts = await store.getPosts(rootId);
    return {
      rootId,
      focusId,
      posts,
      quoted: await getQuotedFor(store, posts),
      unreadIds: await store.getUnreadIds(rootId),
      truncated: opts.truncated ?? false,
      fromCache: opts.fromCache,
    };
  }

  /** Resolve quoted posts two levels deep; anything deeper renders as a link. */
  async function resolveQuotedPosts(all: Post[], byId: Map<string, Post>): Promise<void> {
    let sources = all;
    for (let level = 0; level < 2; level++) {
      const ids = [
        ...new Set(sources.map((p) => p.quotedPostId).filter((id): id is string => id !== null)),
      ];
      const missing: string[] = [];
      for (const id of ids) {
        if (!byId.has(id) && !(await store.hasPost(id))) missing.push(id);
      }
      if (missing.length > 0) {
        const fetched = await xapi.getPostsByIds(missing);
        for (const post of fetched) byId.set(post.id, post);
        await store.upsertPosts(fetched);
      }
      const resolved: Post[] = [];
      for (const id of ids) {
        const post = byId.get(id) ?? (await store.getPost(id));
        if (post) resolved.push(post);
      }
      sources = resolved;
    }
  }

  /**
   * Upsert a fetch result (posts + referenced) and resolve its quotes.
   * Returns what it actually cost: posts we hadn't already read today, since
   * same-day re-reads don't bill.
   */
  async function ingest(
    fetched: FetchedConversation,
    extra: Post[] = [],
  ): Promise<{ posts: number; billable: number; usd: number }> {
    const byId = new Map(fetched.posts.map((p) => [p.id, p]));
    for (const post of extra) if (!byId.has(post.id)) byId.set(post.id, post);
    for (const post of fetched.referenced) if (!byId.has(post.id)) byId.set(post.id, post);
    const all = [...byId.values()];
    // Check before upserting: writing the posts overwrites fetched_at.
    const free = await store.postIdsReadToday(all.map((p) => p.id));
    await store.upsertPosts(all);
    await resolveQuotedPosts(all, byId);
    const billable = all.length - free.size;
    return { posts: all.length, billable, usd: billable * POST_READ_USD };
  }

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof XApiError) {
      console.error(`X API error (${err.status}): ${err.message}`);
      return c.json({ error: err.message }, err.status === 404 ? 404 : 502);
    }
    console.error(err);
    return c.json({ error: (err as Error).message }, 500);
  });

  /**
   * Interactive consent. Tokens minted in the developer portal lack
   * bookmark.read, so this flow is how the app gets a fully-scoped token.
   * The PKCE verifier and state ride in a short-lived httpOnly cookie
   * rather than server state.
   */
  app.get("/auth/login", async (c) => {
    if (!oauth) return c.json({ error: "OAuth is not configured" }, 400);
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
    if (!oauth) return c.json({ error: "OAuth is not configured" }, 400);
    const code = c.req.query("code");
    const state = c.req.query("state");
    const denied = c.req.query("error");
    if (denied) return c.json({ error: `authorization denied: ${denied}` }, 400);
    if (!code || !state) return c.json({ error: "missing code or state" }, 400);

    const cookie = /(?:^|;\s*)x_pkce=([^;]+)/.exec(c.req.header("Cookie") ?? "")?.[1];
    const [verifier, expectedState] = (cookie ?? "").split(".");
    if (!verifier || !expectedState || expectedState !== state) {
      return c.json({ error: "state mismatch — restart the login" }, 400);
    }

    const redirectUri = new URL("/auth/callback", c.req.url).toString();
    await exchangeCode(store, oauth, code, verifier, redirectUri);
    c.header("Set-Cookie", "x_pkce=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0");
    // Back to the app rather than a JSON dump; the inbox reflects the new state.
    return c.redirect("/");
  });

  /**
   * A user-context access token plus the signed-in user's ID. The ID is
   * resolved once via /2/users/me (a billable user read) and cached with
   * the tokens. Throws when user context isn't configured.
   */
  async function userContext(): Promise<{ token: string; userId: string }> {
    const token = oauth ? await getUserAccessToken(store, oauth) : null;
    if (!token) throw new XApiError("user context is not configured — visit /auth/login", 401);
    const stored = await store.getOAuthTokens("self");
    if (stored?.userId) return { token, userId: stored.userId };
    const me = await xapi.getMe(token);
    if (stored) await store.putOAuthTokens("self", { ...stored, userId: me.id });
    return { token, userId: me.id };
  }

  /** Bookmark folders, for choosing which one feeds the saved tab. */
  app.get("/api/bookmarks/folders", async (c) => {
    const { token, userId } = await userContext();
    return c.json({ folders: await xapi.getBookmarkFolders(token, userId) });
  });

  app.get("/api/settings", async (c) => {
    return c.json({
      bookmarkFolderId: await store.getSetting(BOOKMARK_FOLDER_KEY),
      bookmarkFolderName: await store.getSetting(BOOKMARK_FOLDER_NAME_KEY),
    });
  });

  app.patch("/api/settings", async (c) => {
    const body = await c.req.json<{ bookmarkFolderId?: string | null; bookmarkFolderName?: string }>();
    if (body.bookmarkFolderId !== undefined) {
      await store.setSetting(BOOKMARK_FOLDER_KEY, body.bookmarkFolderId ?? "");
      await store.setSetting(BOOKMARK_FOLDER_NAME_KEY, body.bookmarkFolderName ?? "");
    }
    return c.json({
      bookmarkFolderId: await store.getSetting(BOOKMARK_FOLDER_KEY),
      bookmarkFolderName: await store.getSetting(BOOKMARK_FOLDER_NAME_KEY),
    });
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
    if (!folderId) return c.json({ error: "no bookmark folder selected" }, 400);
    const { token, userId } = await userContext();
    const { posts, complete } = await xapi.getBookmarksByFolder(token, userId, folderId);
    await store.upsertPosts(posts);

    const inFolder = new Set(posts.map((p) => p.id));
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
    for (const item of gone) await store.removeSavedItem(item.postId);

    return c.json({ synced: posts.length, added: fresh.length, removed: gone.length, complete });
  });

  /** The saved queue: bookmarked and manually added posts, newest first. */
  app.get("/api/saved", async (c) => {
    const items = await store.listSavedItems();
    const posts = await store.getPostsByIds(items.map((i) => i.postId));
    const byId = new Map(posts.map((p) => [p.id, p]));
    const entries = [];
    for (const item of items) {
      const post = byId.get(item.postId);
      if (!post) continue;
      // A conversation is "loaded" when we've cached its whole tree.
      const rootId = post.conversationId;
      entries.push({
        post,
        source: item.source,
        addedAt: item.addedAt,
        rootId,
        loaded: await store.hasConversation(rootId),
      });
    }
    return c.json({ items: entries, quoted: await getQuotedFor(store, posts) });
  });

  app.delete("/api/saved/:postId", async (c) => {
    const postId = c.req.param("postId");
    const item = (await store.listSavedItems()).find((i) => i.postId === postId);
    if (item?.source === "bookmark") {
      // Removing it here would be undone by the next sync; the folder on X is
      // the source of truth for these.
      return c.json({ error: "un-bookmark it on x.com — sync will remove it here" }, 409);
    }
    await store.removeSavedItem(postId);
    return c.json({ ok: true });
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
  /**
   * How many posts the thread itself is: the root plus its chain of
   * self-replies. Counting every post the author has in the conversation
   * would fold in their replies to other people — one two-post thread that
   * sparked a long discussion measured 21 that way.
   */
  function spineLength(root: Post, ownPosts: Post[]): number {
    const byParent = new Map<string, Post>();
    for (const post of ownPosts) {
      if (post.parentId) byParent.set(post.parentId, post);
    }
    let length = 1;
    let current = root;
    for (;;) {
      const next = byParent.get(current.id);
      if (!next) return length;
      length++;
      current = next;
    }
  }

  /** Group the user's posts into threads they started, newest activity first. */
  async function groupOwnThreads(posts: Post[], userId: string): Promise<OwnThread[]> {
    const byConversation = new Map<string, Post[]>();
    for (const post of posts) {
      const group = byConversation.get(post.conversationId) ?? [];
      group.push(post);
      byConversation.set(post.conversationId, group);
    }

    // Roots older than the scan window aren't in the timeline response; pull
    // any we don't already have in one batch.
    const missing: string[] = [];
    for (const [conversationId, group] of byConversation) {
      const known =
        group.some((p) => p.id === conversationId) || (await store.hasPost(conversationId));
      if (!known) missing.push(conversationId);
    }
    if (missing.length > 0) {
      await store.upsertPosts(await xapi.getPostsByIds(missing));
    }

    const items: OwnThread[] = [];
    for (const [conversationId, group] of byConversation) {
      const root =
        group.find((p) => p.id === conversationId) ?? (await store.getPost(conversationId));
      // Conversations rooted by someone else are replies into their threads,
      // not the user's own posts.
      if (!root || root.authorId !== userId) continue;
      const latestAt = group.reduce(
        (latest, p) => (p.createdAt > latest ? p.createdAt : latest),
        group[0]!.createdAt,
      );
      items.push({
        root,
        ownPostCount: spineLength(root, group),
        latestAt,
        loaded: await store.hasConversation(conversationId),
      });
    }
    items.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
    return items;
  }

  app.get("/api/me/posts", async (c) => {
    // Parse before spending: Number("abc") is NaN, which makes both loop
    // guards below permanently false and pages the whole timeline for an
    // empty response (2026-07-30 review, C2).
    const raw = c.req.query("threads");
    const requestedThreads = raw === undefined ? DEFAULT_THREADS : parseIntStrict(raw);
    if (requestedThreads === null) {
      return c.json({ error: "threads must be an integer" }, 400);
    }
    const target = clamp(requestedThreads, 1, MAX_THREADS);

    const { token, userId } = await userContext();
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
      const page = await xapi.getOwnPosts(token, userId, { max: 50, paginationToken });
      posts.push(...page.posts);
      paginationToken = page.nextToken;
      await store.upsertPosts(page.posts);
      items = await groupOwnThreads(posts, userId);
      if (items.length >= target || !paginationToken || page.posts.length === 0) break;
      if (posts.length >= MAX_SCAN) break;
    }

    const shown = items.slice(0, target);
    const response: OwnPostsResponse = {
      items: shown,
      quoted: await getQuotedFor(
        store,
        shown.map((i) => i.root),
      ),
      // More to find if the timeline isn't exhausted, or we trimmed the list.
      hasMore: items.length > target || paginationToken !== undefined,
    };
    return c.json(response);
  });

  /**
   * Whether user-context features (own posts, bookmarks) are available.
   * `configured` means this deployment has OAuth client credentials;
   * `authorized` means someone has completed /auth/login on it.
   *
   * Answered entirely from the stored row: the inbox mounts this on every
   * visit, and the old version paid a billable /2/users/me and could burn a
   * single-use refresh token to answer it (2026-07-30 review, H1). An expired
   * token still reads as authorized — renewing it is the next real request's
   * job, and a grant that has actually gone bad is that request's error to
   * report. The `user` field is therefore absent until Stage 3's token model
   * persists the profile; the inbox already treats it as optional.
   */
  app.get("/api/auth/status", async (c) => {
    if (!oauth) return c.json({ configured: false, authorized: false });
    const stored = await store.getOAuthTokens("self");
    if (!stored) {
      return c.json({ configured: true, authorized: false, loginUrl: "/auth/login" });
    }
    return c.json({
      configured: true,
      authorized: true,
      scopes: stored.scope ? stored.scope.split(" ") : [],
      expiresAt: stored.expiresAt,
    });
  });

  // Resolve a post ID to its cached conversation, without touching the X API.
  // null means the conversation isn't cached; the client offers to fetch it.
  app.get("/api/resolve/:postId", async (c) => {
    const post = await store.getPost(c.req.param("postId"));
    const rootId =
      post && (await store.hasConversation(post.conversationId)) ? post.conversationId : null;
    // The reply count lets the client estimate a fetch before committing to
    // it; null when we've never seen the post, so no estimate is shown.
    return c.json({ rootId, replyCount: post?.metrics.replies ?? null });
  });

  app.get("/api/conversations", async (c) => {
    const roots: Post[] = [];
    const conversations = [];
    for (const row of await store.listConversations()) {
      const root = await store.getPost(row.rootId);
      if (!root) continue;
      roots.push(root);
      conversations.push({
        root,
        postCount: row.postCount,
        unreadCount: row.unreadCount,
        fetchedAt: row.fetchedAt,
      });
    }
    const response: ConversationListResponse = {
      conversations,
      quoted: await getQuotedFor(store, roots),
    };
    return c.json(response);
  });

  app.get("/api/conversations/:rootId", async (c) => {
    const rootId = c.req.param("rootId");
    if (!(await store.hasConversation(rootId))) {
      return c.json({ error: "conversation not cached" }, 404);
    }
    return c.json(await conversationResponse(rootId, null, { fromCache: true }));
  });

  app.post("/api/conversations", async (c) => {
    const body = await c.req.json<{ url?: string; force?: boolean }>();
    const postId = body.url ? parsePostUrl(body.url) : null;
    if (!postId) {
      return c.json({ error: "could not parse a post URL or ID from input" }, 400);
    }

    // Cache first: a stored post already carries its conversation ID, so a
    // conversation we've fetched before is resolvable — and servable — for
    // free. Only a post we've never seen is worth a billable lookup.
    const requested = (await store.getPost(postId)) ?? (await xapi.getPost(postId));
    const rootId = requested.conversationId;
    const focusId = postId === rootId ? null : postId;
    const firstFetch = !(await store.hasConversation(rootId));

    if (!firstFetch && !body.force) {
      return c.json(await conversationResponse(rootId, focusId, { fromCache: true }));
    }

    const fetched = await xapi.fetchConversation(rootId, maxPosts);
    const root =
      fetched.posts.find((p) => p.id === rootId) ??
      fetched.referenced.find((p) => p.id === rootId) ??
      (requested.id === rootId ? requested : await xapi.getPost(rootId));

    const cost = await ingest(fetched, [requested, root]);

    // A conversation you just pulled up is one you're about to read; unread is
    // reserved for posts that arrive later.
    if (firstFetch) await store.markConversationRead(rootId);

    // Every explicit fetch lands in the saved queue as a manual entry —
    // pasted URLs, but since ed8ea1a also inbox card clicks and deep links,
    // so your own threads and a second root-keyed entry beside a bookmark
    // both end up here. Whether that's wanted is Stage 5a's call (H5).
    await store.addSavedItems([
      { postId: rootId, source: "manual", addedAt: new Date().toISOString() },
    ]);

    // The row is the "cached" marker, so it commits last: anything that throws
    // above leaves nothing to serve rather than an empty conversation the
    // retry mistakes for a hit. Stage 5b's explicit lifecycle state replaces
    // this ordering, which incremental page persistence will conflict with.
    await store.upsertConversation({
      rootId,
      rootAuthorHandle: root.authorHandle,
      rootText: root.text,
      rootCreatedAt: root.createdAt,
      fetchedAt: new Date().toISOString(),
    });

    return c.json({
      ...(await conversationResponse(rootId, focusId, {
        truncated: fetched.truncated,
        fromCache: false,
      })),
      cost,
    });
  });

  app.post("/api/conversations/:rootId/refresh", async (c) => {
    const rootId = c.req.param("rootId");
    const meta = await store.getConversationMeta(rootId);
    if (!meta) {
      return c.json({ error: "conversation not cached" }, 404);
    }

    const before = await store.existingPostIds(rootId);
    // Post reads deduplicate within a UTC day, so a full re-read on the same
    // day as the last one is free and refreshes metrics; otherwise fetch only
    // new posts via since_id.
    const sameUtcDay = meta.fetchedAt.slice(0, 10) === new Date().toISOString().slice(0, 10);
    let truncated = false;

    let cost: { posts: number; billable: number; usd: number };
    if (sameUtcDay) {
      const fetched = await xapi.fetchConversation(rootId, maxPosts);
      cost = await ingest(fetched);
      await store.upsertConversation({ rootId, ...meta, fetchedAt: new Date().toISOString() });
      truncated = fetched.truncated;
    } else {
      const sinceId = await store.newestPostId(rootId);
      const fetched = await xapi.fetchConversation(rootId, maxPosts, sinceId ?? undefined);
      cost = await ingest(fetched);
    }

    const newCount = (await store.existingPostIds(rootId)).size - before.size;
    const response: RefreshResponse = {
      ...(await conversationResponse(rootId, null, { truncated, fromCache: false })),
      newCount,
      metricsUpdated: sameUtcDay,
      cost,
    };
    return c.json(response);
  });

  app.post("/api/conversations/:rootId/read", async (c) => {
    const rootId = c.req.param("rootId");
    if (!(await store.hasConversation(rootId))) {
      return c.json({ error: "conversation not cached" }, 404);
    }
    await store.markConversationRead(rootId);
    return c.json({ ok: true });
  });

  app.post("/api/read-state", async (c) => {
    const body = await c.req.json<{ postIds?: string[]; read?: boolean }>();
    if (!Array.isArray(body.postIds) || typeof body.read !== "boolean") {
      return c.json({ error: "expected { postIds: string[], read: boolean }" }, 400);
    }
    await store.setReadState(body.postIds, body.read);
    return c.json({ ok: true });
  });

  return app;
}

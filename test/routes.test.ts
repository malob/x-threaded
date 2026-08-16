import { describe, expect, it } from "bun:test";
import { buildApp, type ApiApp } from "../src/server/app";
import { bunDriver } from "../src/server/db/bun";
import { SqlStore } from "../src/server/db/store";
import { SELF_ID } from "../src/server/oauth";
import { XApiError, XApiShapeError } from "../src/server/xapi";
import { USER_READ_USD } from "../src/shared/pricing";
import type {
  ApiError,
  AuthRequiredError,
  AuthStatus,
  FoldersResponse,
  OwnPostsResponse,
  Post,
  SavedListResponse,
  SettingsResponse,
} from "../src/shared/types";
import { makePost } from "./fixtures";
import { FakeXApi } from "./fake-xapi";
import {
  SELF_USER_ID,
  TEST_OAUTH,
  fetchConversationRequest,
  searchPage,
  idsRequested,
  makeAuthedApp,
  makeTestApp,
  methods,
  replyTo,
  seedConversation,
} from "./harness";

describe("POST /api/conversations — cache-first resolution", () => {
  it("serves a cached conversation without any X call", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ text: "the root" });
    await seedConversation(store, root, [replyTo(root)]);

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { fromCache: boolean; posts: Post[] };
    expect(body.fromCache).toBe(true);
    expect(body.posts).toHaveLength(2);
    expect(xapi.calls).toEqual([]);
  });

  it("focuses a cached mid-thread post without any X call", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    const reply = replyTo(root);
    await seedConversation(store, root, [reply]);

    const response = await fetchConversationRequest(app, reply.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { fromCache: boolean; focusId: string | null };
    expect(body).toMatchObject({ fromCache: true, focusId: reply.id });
    expect(xapi.calls).toEqual([]);
  });

  it("fetches without a getPost when the post is stored but its conversation isn't", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    const reply = replyTo(root);
    // The reply is known (a bookmark, say); the tree around it has never been pulled.
    await store.upsertPosts([reply]);
    xapi.onSearchConversationPage = () => searchPage([root, reply]);

    const response = await fetchConversationRequest(app, reply.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { fromCache: boolean; focusId: string | null };
    expect(body).toMatchObject({ fromCache: false, focusId: reply.id });
    expect(methods(xapi)).toEqual(["searchConversationPage"]);
  });

  it("looks the post up on X only when it is entirely unknown", async () => {
    const { app, xapi } = await makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root]);

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(200);
    expect(methods(xapi)).toEqual(["getPost", "searchConversationPage"]);
  });

  it("re-fetches a cached conversation on force, still without a getPost", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    await seedConversation(store, root);
    xapi.onSearchConversationPage = () => searchPage([root]);

    const response = await fetchConversationRequest(app, root.id, { force: true });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { fromCache: boolean };
    expect(body.fromCache).toBe(false);
    expect(methods(xapi)).toEqual(["searchConversationPage"]);
  });
});

/**
 * The row no longer commits last; it is opened as `partial` before the first
 * page and closed by whatever the run turned out to be. So the question these
 * ask is no longer "is anything cached" but "does what's cached tell the
 * truth about itself" — a conversation the fetch never finished has to read as
 * incomplete, and one whose *quotes* failed is still a whole conversation.
 */
describe("POST /api/conversations — what a failed fetch leaves behind", () => {
  it("keeps a whole conversation whole when quote hydration fails", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    const quoting = replyTo(root, { quotedPostId: "1796000000000000000" });
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root, quoting]);
    // Quote hydration is a real X call, and the general shape of C1: the money
    // is already spent when the write path throws.
    xapi.onGetPostsByIds = () => {
      throw new Error("X is having a moment");
    };

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(500);
    // The search ran out of pages, so the conversation really is complete —
    // what's missing is a post from someone else's thread, which renders as a
    // link and resolves on the next refresh.
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "complete" });
    const cached = await app.request(`/api/conversations/${root.id}`);
    expect(cached.status).toBe(200);
    expect((await cached.json()) as { truncated: boolean; posts: Post[] }).toMatchObject({
      truncated: false,
    });
  });

  it("leaves a partial, resumable conversation when the fetch itself fails", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => {
      throw new Error("X is having a moment");
    };

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(500);
    // Cached, but saying so: the retry serves this and offers to resume,
    // rather than paying for the whole conversation a second time.
    expect(await store.hasConversation(root.id)).toBe(true);
    const cached = await app.request(`/api/conversations/${root.id}`);
    expect(cached.status).toBe(200);
    expect((await cached.json()) as { truncated: boolean }).toMatchObject({ truncated: true });
  });

  it("commits the row, the read marking and the saved entry on success", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    const reply = replyTo(root);
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root, reply]);

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      unreadIds: string[];
      cost: { posts: number };
    };
    expect(await store.hasConversation(root.id)).toBe(true);
    expect(body.unreadIds).toEqual([]);
    // The lookup that resolved the pasted URL counts too: three reads for two
    // posts, because X served the root twice. Under-reporting that was H1.
    expect(body.cost.posts).toBe(3);
    expect((await store.listSavedItems()).map((i) => i.postId)).toEqual([root.id]);
    expect((await app.request(`/api/conversations/${root.id}`)).status).toBe(200);
  });
});

/**
 * "Save unless already represented": a fetch is a reading intention, but a
 * second entry for a conversation the queue already holds — or for a thread
 * the *Your posts* tab lists anyway — is a chore, not a queue entry.
 */
describe("POST /api/conversations — what lands in Saved", () => {
  it("adds a conversation nothing in the queue represents", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ authorId: "999" });
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root]);

    await fetchConversationRequest(app, root.id);

    expect((await store.listSavedItems()).map((i) => [i.postId, i.source])).toEqual([
      [root.id, "manual"],
    ]);
  });

  it("adds nothing when the root is the signed-in user's own post", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const root = makePost({ authorId: SELF_USER_ID });
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root]);

    await fetchConversationRequest(app, root.id);

    expect(await store.listSavedItems()).toEqual([]);
  });

  it("still adds someone else's thread when the user is signed in", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const root = makePost({ authorId: "999" });
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root]);

    await fetchConversationRequest(app, root.id);

    expect((await store.listSavedItems()).map((i) => i.postId)).toEqual([root.id]);
  });

  it("adds nothing when a saved reply already represents the conversation", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ authorId: "999" });
    const reply = replyTo(root);
    // The bookmarked mid-thread reply is the entry; opening its conversation
    // must not leave a second, root-keyed one beside it.
    await store.upsertPosts([reply]);
    await store.addSavedItems([
      { postId: reply.id, source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    xapi.onSearchConversationPage = () => searchPage([root, reply]);

    await fetchConversationRequest(app, reply.id);

    expect((await store.listSavedItems()).map((i) => i.postId)).toEqual([reply.id]);
  });

  it("does not add a second entry when the same conversation is fetched again", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ authorId: "999" });
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root]);
    await fetchConversationRequest(app, root.id);

    await fetchConversationRequest(app, root.id, { force: true });

    expect((await store.listSavedItems()).map((i) => i.postId)).toEqual([root.id]);
  });

  it("re-adds a cached conversation whose entry was removed, for free", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ authorId: "999" });
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root]);
    await fetchConversationRequest(app, root.id);
    await store.removeSavedItem(root.id);
    const callsBefore = [...xapi.calls];

    // Cached now, so this paste never reaches the fetch path. The cached
    // path runs the same gate — otherwise removing an entry would make the
    // conversation unsaveable for as long as it stays cached.
    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(200);
    expect((await store.listSavedItems()).map((i) => i.postId)).toEqual([root.id]);
    expect(xapi.calls).toEqual(callsBefore);
  });

  it("adds nothing on the cached path when the queue already represents it", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ authorId: "999" });
    const reply = replyTo(root);
    await store.upsertPosts([reply]);
    await store.addSavedItems([
      { postId: reply.id, source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    xapi.onSearchConversationPage = () => searchPage([root, reply]);
    await fetchConversationRequest(app, reply.id);

    await fetchConversationRequest(app, reply.id);

    expect((await store.listSavedItems()).map((i) => i.postId)).toEqual([reply.id]);
  });

  it("saves your own thread when OAuth is off, whatever a leftover row says", async () => {
    // A userId left behind by a removed OAuth setup must not suppress the
    // save: with user context off, the Your posts tab doesn't exist, and
    // Saved is the only place this thread would be findable.
    const { app, store, xapi } = await makeTestApp();
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "stale",
      refreshToken: "stale",
      expiresAt: 0,
      scope: "",
      userId: "999",
    });
    const root = makePost({ authorId: "999" });
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root]);

    await fetchConversationRequest(app, root.id);

    expect((await store.listSavedItems()).map((i) => i.postId)).toEqual([root.id]);
  });
});

describe("GET /api/me/posts — threads param", () => {
  /** One page of own root posts, each its own conversation. */
  function ownPage(count: number): Post[] {
    return Array.from({ length: count }, () => makePost({ authorId: SELF_USER_ID }));
  }

  it("400s a non-integer threads without spending anything", async () => {
    const { app, xapi } = await makeAuthedApp();

    const response = await app.request("/api/me/posts?threads=abc");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "threads must be an integer" });
    expect(xapi.calls).toEqual([]);
  });

  it("400s a fractional threads", async () => {
    const { app, xapi } = await makeAuthedApp();

    const response = await app.request("/api/me/posts?threads=1.5");

    expect(response.status).toBe(400);
    expect(xapi.calls).toEqual([]);
  });

  it("honours an explicit threads", async () => {
    const { app, xapi } = await makeAuthedApp();
    xapi.onGetOwnPosts = () => ({ posts: ownPage(8) });

    const response = await app.request("/api/me/posts?threads=5");

    expect(response.status).toBe(200);
    const body = (await response.json()) as OwnPostsResponse;
    expect(body.items).toHaveLength(5);
    expect(body.hasMore).toBe(true);
    expect(xapi.count("getOwnPosts")).toBe(1);
  });

  it("defaults to 10 threads when the param is missing", async () => {
    const { app, xapi } = await makeAuthedApp();
    xapi.onGetOwnPosts = () => ({ posts: ownPage(12) });

    const response = await app.request("/api/me/posts");

    expect(response.status).toBe(200);
    const body = (await response.json()) as OwnPostsResponse;
    expect(body.items).toHaveLength(10);
    expect(body.hasMore).toBe(true);
  });

  it("clamps threads into 1..50", async () => {
    const { app, xapi } = await makeAuthedApp();
    xapi.onGetOwnPosts = () => ({ posts: ownPage(3) });

    const low = await app.request("/api/me/posts?threads=0");
    expect(low.status).toBe(200);
    expect(((await low.json()) as OwnPostsResponse).items).toHaveLength(1);

    const high = await app.request("/api/me/posts?threads=999");
    expect(high.status).toBe(200);
    expect(((await high.json()) as OwnPostsResponse).items).toHaveLength(3);
  });
});

/**
 * The `loaded` flag on both list routes used to be one store query per row,
 * inside the loop; it is now one set-returning query per page (2026-07-30
 * review, S3). These pin the answers, not the query count.
 */
describe("GET /api/saved — hydration and the loaded flag", () => {
  it("resolves each entry's root and whether that conversation is cached", async () => {
    const { app, store } = await makeTestApp();
    const cachedRoot = makePost();
    const cachedReply = replyTo(cachedRoot);
    await seedConversation(store, cachedRoot, [cachedReply]);
    // A bookmarked post whose tree has never been pulled.
    const loose = makePost();
    await store.upsertPosts([loose]);
    await store.addSavedItems([
      { postId: cachedReply.id, source: "bookmark", addedAt: "2024-01-02T00:00:00.000Z" },
      { postId: loose.id, source: "manual", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);

    const response = await app.request("/api/saved");

    expect(response.status).toBe(200);
    const body = (await response.json()) as SavedListResponse;
    // Newest first, and both entries carry their own root and loaded state.
    expect(body.items.map((i) => [i.post.id, i.rootId, i.loaded, i.source])).toEqual([
      [cachedReply.id, cachedRoot.id, true, "bookmark"],
      [loose.id, loose.id, false, "manual"],
    ]);
  });

  it("skips a saved id whose post was never stored", async () => {
    const { app, store } = await makeTestApp();
    const stored = makePost();
    await store.upsertPosts([stored]);
    await store.addSavedItems([
      { postId: stored.id, source: "manual", addedAt: "2024-01-02T00:00:00.000Z" },
      { postId: "1796000000000000000", source: "manual", addedAt: "2024-01-03T00:00:00.000Z" },
    ]);

    const body = (await (await app.request("/api/saved")).json()) as SavedListResponse;

    expect(body.items.map((i) => i.post.id)).toEqual([stored.id]);
  });
});

describe("GET /api/me/posts — grouping into threads", () => {
  const EARLIER = "2024-05-01T00:00:00.000Z";
  const LATER = "2024-06-01T00:00:00.000Z";

  it("marks a thread loaded only when its conversation is cached", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const cached = makePost({ authorId: SELF_USER_ID, createdAt: LATER });
    const uncached = makePost({ authorId: SELF_USER_ID, createdAt: EARLIER });
    await seedConversation(store, cached);
    xapi.onGetOwnPosts = () => ({ posts: [cached, uncached] });

    const body = (await (await app.request("/api/me/posts")).json()) as OwnPostsResponse;

    expect(body.items.map((i) => [i.root.id, i.loaded])).toEqual([
      [cached.id, true],
      [uncached.id, false],
    ]);
  });

  it("recovers a root the timeline page didn't return from the store, free", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const root = makePost({ authorId: SELF_USER_ID, createdAt: EARLIER });
    const continuation = replyTo(root, { authorId: SELF_USER_ID, createdAt: LATER });
    await store.upsertPosts([root]);
    xapi.onGetOwnPosts = () => ({ posts: [continuation] });

    const body = (await (await app.request("/api/me/posts")).json()) as OwnPostsResponse;

    expect(body.items.map((i) => [i.root.id, i.ownPostCount, i.latestAt])).toEqual([
      [root.id, 2, LATER],
    ]);
    // The root was already cached, so nothing was bought to recover it.
    expect(methods(xapi)).toEqual(["getOwnPosts"]);
  });

  it("buys a root neither the page nor the store has, once, in one batch", async () => {
    const { app, xapi } = await makeAuthedApp();
    const root = makePost({ authorId: SELF_USER_ID, createdAt: EARLIER });
    const continuation = replyTo(root, { authorId: SELF_USER_ID, createdAt: LATER });
    xapi.onGetOwnPosts = () => ({ posts: [continuation] });
    xapi.onGetPostsByIds = (ids) => ({
      posts: ids.includes(root.id) ? [root] : [],
      missing: [],
    });

    const body = (await (await app.request("/api/me/posts")).json()) as OwnPostsResponse;

    expect(idsRequested(xapi)).toEqual([[root.id]]);
    expect(body.items.map((i) => i.root.id)).toEqual([root.id]);
  });

  it("drops conversations someone else started", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const theirs = makePost({ authorId: "999", createdAt: EARLIER });
    const ourReply = replyTo(theirs, { authorId: SELF_USER_ID, createdAt: LATER });
    const ours = makePost({ authorId: SELF_USER_ID, createdAt: LATER });
    await store.upsertPosts([theirs]);
    xapi.onGetOwnPosts = () => ({ posts: [ourReply, ours] });

    const body = (await (await app.request("/api/me/posts")).json()) as OwnPostsResponse;

    expect(body.items.map((i) => i.root.id)).toEqual([ours.id]);
  });
});

describe("GET /api/auth/status — answered from the store", () => {
  /** The route's body, typed as what every branch of it must satisfy. */
  async function authStatus(app: ApiApp): Promise<AuthStatus> {
    const response = await app.request("/api/auth/status");
    expect(response.status).toBe(200);
    return (await response.json()) as AuthStatus;
  }

  it("reports the stored grant without a getMe", async () => {
    const { app, xapi } = await makeAuthedApp();

    const body = await authStatus(app);

    expect(body).toMatchObject({
      state: "authorized",
      scopes: ["tweet.read", "users.read", "bookmark.read"],
      // Nobody has resolved the profile yet, and this route will not pay for it.
      user: null,
    });
    expect(body.state === "authorized" && body.expiresAt).toBeNumber();
    expect(xapi.calls).toEqual([]);
  });

  it("names the user once the profile has been cached", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    await store.putUserProfile(SELF_ID, "refresh", {
      userId: SELF_USER_ID,
      username: "someone",
      displayName: "Some One",
    });

    expect(await authStatus(app)).toMatchObject({
      state: "authorized",
      user: { username: "someone", name: "Some One" },
    });
    expect(xapi.calls).toEqual([]);
  });

  it("still reports authorized when the stored token has expired", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: Date.now() - 60 * 1000,
      scope: "tweet.read",
      userId: SELF_USER_ID,
    });

    // No refresh either: the network tripwire would throw, and the status
    // route is not the place to spend a single-use refresh token.
    expect(await authStatus(app)).toMatchObject({ state: "authorized" });
    expect(xapi.calls).toEqual([]);
  });

  it("surfaces a broken grant with the way out of it", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    await store.markTokenBroken(SELF_ID, "refresh", "invalid_grant — token was invalid");

    expect(await authStatus(app)).toEqual({
      state: "broken",
      reason: "invalid_grant — token was invalid",
      loginUrl: "/auth/login",
    });
    expect(xapi.calls).toEqual([]);
  });

  it("offers the login URL when nothing is stored", async () => {
    const { app, xapi } = await makeTestApp({ oauth: TEST_OAUTH });

    expect(await authStatus(app)).toEqual({ state: "unauthorized", loginUrl: "/auth/login" });
    expect(xapi.calls).toEqual([]);
  });

  it("reports unconfigured when the deployment has no OAuth client", async () => {
    const { app, xapi } = await makeTestApp();

    expect(await authStatus(app)).toEqual({ state: "unconfigured" });
    expect(xapi.calls).toEqual([]);
  });
});

/**
 * What a failure looks like from outside. The client acts on the status —
 * offering a login, backing off, retrying — so a status that collapses into
 * "something broke upstream" costs it every one of those choices.
 */
describe("the error contract", () => {
  /** A POST /api/conversations whose getPost throws `error`. */
  async function failingFetch(error: unknown): Promise<Response> {
    const { app, xapi } = await makeTestApp();
    xapi.onGetPost = () => {
      throw error;
    };
    return await fetchConversationRequest(app, "1796000000000000000");
  }

  it("carries an X 401, 403 and 429 out as themselves", async () => {
    for (const status of [401, 403, 429]) {
      const response = await failingFetch(new XApiError("from X", status));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "from X" });
    }
  });

  it("answers a broken grant with a 401 and the way out of it", async () => {
    const { app, store } = await makeAuthedApp();
    await store.markTokenBroken(SELF_ID, "refresh", "invalid_grant");

    const response = await app.request("/api/bookmarks/folders");

    expect(response.status).toBe(401);
    const body = (await response.json()) as AuthRequiredError;
    expect(body.loginUrl).toBe("/auth/login");
    expect(body.error).toContain("reconnect");
  });

  it("reports a wire that moved as a 502 naming the endpoint", async () => {
    const response = await failingFetch(
      new XApiShapeError("/tweets/1796000000000000000", "data: expected Array, got object"),
    );

    expect(response.status).toBe(502);
    expect(((await response.json()) as ApiError).error).toContain("/tweets/1796000000000000000");
  });

  it("says nothing but 'internal error' when the fault is ours", async () => {
    const response = await failingFetch(new Error("SQLITE_BUSY at /var/data/x.db"));

    expect(response.status).toBe(500);
    // Not the message: whatever threw, its text is an internal detail, and
    // internal details have a way of being paths, queries and credentials.
    expect(await response.json()).toEqual({ error: "internal error" });
  });
});

/**
 * Every JSON body is a stranger's. A mangled or wrong-shaped one is the
 * client's mistake on all three routes that read one, and has to come back
 * as a 400 — never as a 500 with a parser's complaint inside it.
 */
describe("request bodies", () => {
  const JSON_HEADERS = { "Content-Type": "application/json" };

  /** POST/PATCH `body` as-is, without JSON.stringify getting in the way. */
  async function send(app: ApiApp, path: string, method: string, body: string): Promise<Response> {
    return await app.request(path, { method, headers: JSON_HEADERS, body });
  }

  it("400s a malformed body on every route that reads one", async () => {
    const { app, xapi } = await makeTestApp();

    for (const [path, method] of [
      ["/api/conversations", "POST"],
      ["/api/settings", "PATCH"],
      ["/api/read-state", "POST"],
    ] as const) {
      const response = await send(app, path, method, "{not json");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid JSON body" });
    }
    expect(xapi.calls).toEqual([]);
  });

  it("400s a body of the wrong shape, naming the field", async () => {
    const { app, store } = await makeTestApp();
    const post = makePost();
    await store.upsertPosts([post]);

    const response = await send(app, "/api/read-state", "POST", '{"postIds":"x","read":true}');

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toContain("postIds");
    // A rejected body writes nothing: the post is exactly as unread as it was.
    expect(await store.getUnreadIds(post.conversationId)).toEqual([post.id]);
  });

  it("400s read state whose ids are not strings", async () => {
    const { app } = await makeTestApp();

    const response = await send(app, "/api/read-state", "POST", '{"postIds":[7],"read":true}');

    expect(response.status).toBe(400);
  });

  it("400s a folder id that isn't a string or null", async () => {
    const { app } = await makeTestApp();

    const response = await send(app, "/api/settings", "PATCH", '{"bookmarkFolderId":42}');

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toContain("bookmarkFolderId");
  });

  it("still accepts the bodies the client actually sends", async () => {
    const { app, store } = await makeTestApp();
    const post = makePost();
    await store.upsertPosts([post]);

    const settings = await send(
      app,
      "/api/settings",
      "PATCH",
      JSON.stringify({ bookmarkFolderId: "folder1", bookmarkFolderName: "Reading" }),
    );
    expect(settings.status).toBe(200);
    expect(await settings.json()).toEqual({
      bookmarkFolderId: "folder1",
      bookmarkFolderName: "Reading",
    } satisfies SettingsResponse);

    // Clearing the folder sends an explicit null, not an absent field: the
    // route tells the two apart, so the schema has to accept both.
    const cleared = await send(app, "/api/settings", "PATCH", '{"bookmarkFolderId":null}');
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      bookmarkFolderId: "",
      bookmarkFolderName: "",
    } satisfies SettingsResponse);

    const readState = await send(
      app,
      "/api/read-state",
      "POST",
      JSON.stringify({ postIds: [post.id], read: true }),
    );
    expect(readState.status).toBe(200);
    expect(await store.getUnreadIds(post.conversationId)).toEqual([]);
  });
});

describe("userContext token writes", () => {
  it("single-flights the first profile read across concurrent requests", async () => {
    const driver = await bunDriver(":memory:");
    const storeA = new SqlStore(driver);
    const storeB = new SqlStore(driver);
    const xapi = new FakeXApi();
    const appA = buildApp({ store: storeA, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    const appB = buildApp({ store: storeB, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    await storeA.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: null,
    });

    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let finishFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    xapi.onGetMe = async (token) => {
      expect(token).toBe("access");
      if (xapi.count("getMe") === 1) {
        firstStarted();
        await held;
      }
      return { id: "42", username: "someone", name: "Some One" };
    };
    xapi.onGetBookmarkFolders = (token, userId) => {
      expect([token, userId]).toEqual(["access", "42"]);
      return [];
    };
    let secondClaimed!: () => void;
    const secondReachedLease = new Promise<void>((resolve) => {
      secondClaimed = resolve;
    });
    const claimFromB = storeB.claimUserProfileLease.bind(storeB);
    storeB.claimUserProfileLease = async (...args) => {
      const claimed = await claimFromB(...args);
      secondClaimed();
      return claimed;
    };

    const first = appA.request("/api/bookmarks/folders");
    await started;
    const second = appB.request("/api/bookmarks/folders");
    // Prove the second isolate lost the durable claim while the first was
    // still paying, rather than merely starting after the profile was cached.
    await secondReachedLease;
    expect(xapi.count("getMe")).toBe(1);
    finishFirst();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as FoldersResponse[];
    expect(xapi.count("getMe")).toBe(1);
    expect(xapi.count("getBookmarkFolders")).toBe(2);
    expect(bodies.filter((body) => body.cost !== undefined)).toHaveLength(1);
    expect(bodies.find((body) => body.cost)?.cost).toEqual({
      posts: 1,
      billable: 1,
      usd: USER_READ_USD,
    });
    expect(await storeB.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      userId: "42",
      username: "someone",
      displayName: "Some One",
    });
  });

  it("re-resolves account B instead of continuing with A after a fresh login", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read",
      userId: null,
    });

    // OAuth observes A, then a fresh login installs B before that already-read
    // row reaches userContext. The old token-only handoff followed this with a
    // second row read; returning the observed A row recreates that gap while a
    // coherent snapshot keeps A's refresh-token ownership attached.
    const readTokens = store.getOAuthTokens.bind(store);
    let replaced = false;
    store.getOAuthTokens = async (id) => {
      const observed = await readTokens(id);
      if (!replaced) {
        replaced = true;
        await store.putOAuthTokens(SELF_ID, {
          accessToken: "access-b",
          refreshToken: "refresh-b",
          expiresAt: Date.now() + 60 * 60 * 1000,
          scope: "tweet.read",
          userId: null,
        });
      }
      return observed;
    };
    xapi.onGetMe = async (token) => {
      if (token === "access-a") {
        return { id: "user-a", username: "account-a", name: "Account A" };
      }
      expect(token).toBe("access-b");
      return { id: "user-b", username: "account-b", name: "Account B" };
    };
    xapi.onGetBookmarkFolders = (token, userId) => {
      expect([token, userId]).toEqual(["access-b", "user-b"]);
      return [];
    };

    const response = await app.request("/api/bookmarks/folders");
    expect(response.status).toBe(200);
    expect((await response.json()) as FoldersResponse).toMatchObject({
      cost: { posts: 1, billable: 1, usd: USER_READ_USD },
    });
    // B replaced A before the durable profile claim, so A is fenced before
    // even paying for its identity rather than merely losing the later CAS.
    expect(xapi.count("getMe")).toBe(1);
    expect(xapi.count("getBookmarkFolders")).toBe(1);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access-b",
      refreshToken: "refresh-b",
      userId: "user-b",
      username: "account-b",
      displayName: "Account B",
    });
  });

  it("returns a metered retryable 409 when the grant changes on both profile attempts", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read",
      userId: null,
    });

    let account = 0;
    xapi.onGetMe = async (token) => {
      const current = String.fromCharCode("a".charCodeAt(0) + account);
      expect(token).toBe(`access-${current}`);
      account += 1;
      const next = String.fromCharCode("a".charCodeAt(0) + account);
      await store.putOAuthTokens(SELF_ID, {
        accessToken: `access-${next}`,
        refreshToken: `refresh-${next}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: "tweet.read",
        userId: null,
      });
      return { id: `user-${current}`, username: `account-${current}`, name: `Account ${current}` };
    };

    const response = await app.request("/api/bookmarks/folders");

    expect(response.status).toBe(409);
    expect((await response.json()) as ApiError).toMatchObject({
      error: expect.stringMatching(/account changed|retry/i),
      cost: { posts: 2, billable: 2, usd: 2 * USER_READ_USD },
    });
    expect(xapi.count("getMe")).toBe(2);
    expect(xapi.count("getBookmarkFolders")).toBe(0);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access-c",
      refreshToken: "refresh-c",
      userId: null,
    });
  });

  it("does not revive a pre-rotation token when a refresh lands during getMe", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    // Valid tokens with no cached user ID, so userContext must call getMe.
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read",
      userId: null,
    });
    let rotated = false;
    xapi.onGetMe = async (token) => {
      if (!rotated) {
        expect(token).toBe("access");
        rotated = true;
        // A rotation lands while getMe is in flight; writing the earlier
        // snapshot back would revive the dead refresh token.
        await store.putOAuthTokens(SELF_ID, {
          accessToken: "access-rotated",
          refreshToken: "refresh-rotated",
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          scope: "tweet.read",
          userId: null,
        });
      } else {
        expect(token).toBe("access-rotated");
      }
      return { id: "42", username: "m", name: "M" };
    };
    xapi.onGetBookmarkFolders = (token, userId) => {
      expect([token, userId]).toEqual(["access-rotated", "42"]);
      return [];
    };

    const response = await app.request("/api/bookmarks/folders");
    expect(response.status).toBe(200);

    const stored = await store.getOAuthTokens(SELF_ID);
    expect(stored?.refreshToken).toBe("refresh-rotated");
    expect(stored?.userId).toBe("42");
    expect(xapi.count("getMe")).toBe(2);
  });

  it("caches the whole profile, so the status route can name the account", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read",
      userId: null,
    });
    xapi.onGetMe = async () => ({ id: "42", username: "someone", name: "Some One" });
    xapi.onGetBookmarkFolders = () => [];

    expect((await app.request("/api/bookmarks/folders")).status).toBe(200);

    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      userId: "42",
      username: "someone",
      displayName: "Some One",
    });
    // Resolved once and kept: the second call must not pay for another one.
    expect((await app.request("/api/bookmarks/folders")).status).toBe(200);
    expect(methods(xapi).filter((m) => m === "getMe")).toEqual(["getMe"]);
  });
});

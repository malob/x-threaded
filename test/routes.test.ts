import { describe, expect, it } from "bun:test";
import { SELF_ID } from "../src/server/oauth";
import type { OwnPostsResponse, Post } from "../src/shared/types";
import { makePost } from "./fixtures";
import {
  SELF_USER_ID,
  TEST_OAUTH,
  fetchConversationRequest,
  makeAuthedApp,
  makeTestApp,
  methods,
  replyTo,
  seedConversation,
} from "./harness";

describe("POST /api/conversations — cache-first resolution", () => {
  it("serves a cached conversation without any X call", async () => {
    const { app, store, xapi } = makeTestApp();
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
    const { app, store, xapi } = makeTestApp();
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
    const { app, store, xapi } = makeTestApp();
    const root = makePost();
    const reply = replyTo(root);
    // The reply is known (a bookmark, say); the tree around it has never been pulled.
    await store.upsertPosts([reply]);
    xapi.onFetchConversation = () => ({ posts: [root, reply], referenced: [], truncated: false });

    const response = await fetchConversationRequest(app, reply.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { fromCache: boolean; focusId: string | null };
    expect(body).toMatchObject({ fromCache: false, focusId: reply.id });
    expect(methods(xapi)).toEqual(["fetchConversation"]);
  });

  it("looks the post up on X only when it is entirely unknown", async () => {
    const { app, xapi } = makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    xapi.onFetchConversation = () => ({ posts: [root], referenced: [], truncated: false });

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(200);
    expect(methods(xapi)).toEqual(["getPost", "fetchConversation"]);
  });

  it("re-fetches a cached conversation on force, still without a getPost", async () => {
    const { app, store, xapi } = makeTestApp();
    const root = makePost();
    await seedConversation(store, root);
    xapi.onFetchConversation = () => ({ posts: [root], referenced: [], truncated: false });

    const response = await fetchConversationRequest(app, root.id, { force: true });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { fromCache: boolean };
    expect(body.fromCache).toBe(false);
    expect(methods(xapi)).toEqual(["fetchConversation"]);
  });
});

describe("POST /api/conversations — the conversation row commits last", () => {
  it("leaves nothing cached when quote hydration fails mid-ingest", async () => {
    const { app, store, xapi } = makeTestApp();
    const root = makePost();
    const quoting = replyTo(root, { quotedPostId: "1796000000000000000" });
    xapi.onGetPost = () => root;
    xapi.onFetchConversation = () => ({
      posts: [root, quoting],
      referenced: [],
      truncated: false,
    });
    // Quote hydration is a real X call inside ingest, and the general shape of
    // C1: the money is already spent when the write path throws.
    xapi.onGetPostsByIds = () => {
      throw new Error("X is having a moment");
    };

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(500);
    // Nothing may read as cached, or the retry serves an empty conversation.
    expect(await store.hasConversation(root.id)).toBe(false);
    expect((await app.request(`/api/conversations/${root.id}`)).status).toBe(404);
  });

  it("leaves nothing cached when the conversation fetch itself fails", async () => {
    const { app, store, xapi } = makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    xapi.onFetchConversation = () => {
      throw new Error("X is having a moment");
    };

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(500);
    expect(await store.hasConversation(root.id)).toBe(false);
    expect((await app.request(`/api/conversations/${root.id}`)).status).toBe(404);
  });

  it("commits the row, the read marking and the saved entry on success", async () => {
    const { app, store, xapi } = makeTestApp();
    const root = makePost();
    const reply = replyTo(root);
    xapi.onGetPost = () => root;
    xapi.onFetchConversation = () => ({ posts: [root, reply], referenced: [], truncated: false });

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      unreadIds: string[];
      cost: { posts: number };
    };
    expect(await store.hasConversation(root.id)).toBe(true);
    expect(body.unreadIds).toEqual([]);
    expect(body.cost.posts).toBe(2);
    expect((await store.listSavedItems()).map((i) => i.postId)).toEqual([root.id]);
    expect((await app.request(`/api/conversations/${root.id}`)).status).toBe(200);
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

describe("GET /api/auth/status — answered from the store", () => {
  it("reports the stored grant without a getMe", async () => {
    const { app, xapi } = await makeAuthedApp();

    const response = await app.request("/api/auth/status");

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      configured: true,
      authorized: true,
      scopes: ["tweet.read", "users.read", "bookmark.read"],
    });
    expect(body.expiresAt).toBeNumber();
    // Deferred to Stage 3's token model; the inbox already guards it.
    expect(body).not.toContainKey("user");
    expect(xapi.calls).toEqual([]);
  });

  it("still reports authorized when the stored token has expired", async () => {
    const { app, store, xapi } = makeTestApp({ oauth: TEST_OAUTH });
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: Date.now() - 60 * 1000,
      scope: "tweet.read",
      userId: SELF_USER_ID,
    });

    // No refresh either: the network tripwire would throw, and the status
    // route is not the place to spend a single-use refresh token.
    const response = await app.request("/api/auth/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: true, authorized: true });
    expect(xapi.calls).toEqual([]);
  });

  it("offers the login URL when nothing is stored", async () => {
    const { app, xapi } = makeTestApp({ oauth: TEST_OAUTH });

    const response = await app.request("/api/auth/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      authorized: false,
      loginUrl: "/auth/login",
    });
    expect(xapi.calls).toEqual([]);
  });

  it("reports unconfigured when the deployment has no OAuth client", async () => {
    const { app, xapi } = makeTestApp();

    const response = await app.request("/api/auth/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, authorized: false });
    expect(xapi.calls).toEqual([]);
  });
});

describe("userContext token writes", () => {
  it("does not revive a pre-rotation token when a refresh lands during getMe", async () => {
    const { app, store, xapi } = makeTestApp({ oauth: TEST_OAUTH });
    // Valid tokens with no cached user ID, so userContext must call getMe.
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read",
      userId: null,
    });
    xapi.onGetMe = async () => {
      // A rotation lands while getMe is in flight; writing the earlier
      // snapshot back would revive the dead refresh token.
      await store.putOAuthTokens(SELF_ID, {
        accessToken: "access-rotated",
        refreshToken: "refresh-rotated",
        expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        scope: "tweet.read",
        userId: null,
      });
      return { id: "42", username: "m", name: "M" };
    };
    xapi.onGetBookmarkFolders = () => [];

    const response = await app.request("/api/bookmarks/folders");
    expect(response.status).toBe(200);

    const stored = await store.getOAuthTokens(SELF_ID);
    expect(stored?.refreshToken).toBe("refresh-rotated");
    expect(stored?.userId).toBe("42");
  });
});

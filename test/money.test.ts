/**
 * The money suite: every behavior where a mistake spends real dollars.
 *
 * X bills $0.005 per post read, deduplicated within a UTC day, so the
 * assertions that matter here are X API *call counts* and the `billable`
 * figure ingest reports. A cache guard that silently inverts, or a billing
 * check that moves one line, costs money and shows nothing — these tests are
 * the only thing standing between that and production.
 *
 * Route-shape cases that aren't about spend live in routes.test.ts; the
 * bookmark scan's completeness rules live in xapi.test.ts. This file extends
 * both rather than repeating them.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { ingest } from "../src/server/conversations";
import type { Storage } from "../src/server/storage";
import { XApiError } from "../src/server/xapi";
import { POST_READ_USD } from "../src/shared/pricing";
import type { OwnPostsResponse, Post, RefreshResponse } from "../src/shared/types";
import { makePost } from "./fixtures";
import {
  SELF_USER_ID,
  fetchConversationRequest,
  fetchResult,
  idsRequested,
  makeAuthedApp,
  makeBookmarkApp,
  makeTestApp,
  methods,
  replyTo,
  seedConversation,
} from "./harness";

/** A post already in the store, last read on `day` (an ISO date). */
async function seedPostReadOn(store: Storage, day: string, post = makePost()): Promise<Post> {
  const stale = { ...post, fetchedAt: `${day}T09:00:00.000Z` };
  await store.upsertPosts([stale]);
  return stale;
}

const YESTERDAY = "2024-05-31";

describe("ingest — what actually bills", () => {
  it("bills every post of a first read", async () => {
    const { store, xapi } = await makeTestApp();
    const root = makePost();
    const posts = [root, replyTo(root), replyTo(root)];

    const cost = await ingest(store, xapi, fetchResult(posts));

    expect(cost).toEqual({ posts: 3, billable: 3, usd: 3 * POST_READ_USD });
    expect(xapi.calls).toEqual([]);
  });

  it("bills nothing for a second ingest the same day", async () => {
    const { store, xapi } = await makeTestApp();
    const root = makePost();
    const posts = [root, replyTo(root)];
    await ingest(store, xapi, fetchResult(posts));

    const again = await ingest(store, xapi, fetchResult(posts));

    expect(again).toEqual({ posts: 2, billable: 0, usd: 0 });
  });

  it("bills again for a post last read on an earlier day", async () => {
    const { store, xapi } = await makeTestApp();
    const stale = await seedPostReadOn(store, YESTERDAY);

    // The same post comes back from X today, carrying today's fetchedAt.
    const cost = await ingest(store, xapi, fetchResult([makePost({ id: stale.id })]));

    expect(cost.billable).toBe(1);
  });

  /**
   * The check-before-upsert ordering pin (2026-07-30 review, test-strategy P1).
   *
   * `postIdsReadToday` must run *before* `upsertPosts`, because the upsert
   * overwrites `fetched_at` with today. Move that read below the write and
   * every fetch reports "free — already read today" while X bills in full.
   * A mixed fetch makes the failure unambiguous: swapped, billable drops to 0.
   */
  it("counts only the stale post of a mixed fetch — the ordering pin", async () => {
    const { store, xapi } = await makeTestApp();
    const stale = await seedPostReadOn(store, YESTERDAY);
    const readToday = makePost();
    await ingest(store, xapi, fetchResult([readToday]));

    const cost = await ingest(
      store,
      xapi,
      fetchResult([makePost({ id: stale.id }), readToday]),
    );

    expect(cost).toEqual({ posts: 2, billable: 1, usd: POST_READ_USD });
  });

  it("counts a post once when it arrives in both posts and referenced", async () => {
    const { store, xapi } = await makeTestApp();
    const root = makePost();
    const reply = replyTo(root);

    const cost = await ingest(store, xapi, fetchResult([root, reply], { referenced: [root] }));

    expect(cost).toEqual({ posts: 2, billable: 2, usd: 2 * POST_READ_USD });
  });

  it("counts an extra once when the fetch already returned it", async () => {
    const { store, xapi } = await makeTestApp();
    const root = makePost();

    const cost = await ingest(store, xapi, fetchResult([root]), [root, root]);

    expect(cost.posts).toBe(1);
    expect(cost.billable).toBe(1);
  });

  it("counts an extra the fetch missed", async () => {
    const { store, xapi } = await makeTestApp();
    const root = makePost();
    const orphan = replyTo(root);

    const cost = await ingest(store, xapi, fetchResult([root]), [orphan]);

    expect(cost.posts).toBe(2);
    expect((await store.getPosts(root.id)).map((p) => p.id).sort()).toEqual(
      [root.id, orphan.id].sort(),
    );
  });
});

describe("ingest — quoted-post resolution", () => {
  it("makes no X call when the quoted post is already stored", async () => {
    const { store, xapi } = await makeTestApp();
    const quoted = makePost();
    await store.upsertPosts([quoted]);
    const root = makePost({ quotedPostId: quoted.id });

    await ingest(store, xapi, fetchResult([root]));

    expect(xapi.count("getPostsByIds")).toBe(0);
  });

  it("makes no X call when the quoted post came in the same fetch", async () => {
    const { store, xapi } = await makeTestApp();
    const quoted = makePost();
    const root = makePost({ quotedPostId: quoted.id });

    await ingest(store, xapi, fetchResult([root], { referenced: [quoted] }));

    expect(xapi.count("getPostsByIds")).toBe(0);
  });

  it("fetches a missing quote exactly once, batching the whole level", async () => {
    const { store, xapi } = await makeTestApp();
    const q1 = makePost();
    const q2 = makePost();
    const root = makePost({ quotedPostId: q1.id });
    const reply = replyTo(root, { quotedPostId: q2.id });
    xapi.onGetPostsByIds = (ids) => [q1, q2].filter((p) => ids.includes(p.id));

    await ingest(store, xapi, fetchResult([root, reply]));

    expect(xapi.count("getPostsByIds")).toBe(1);
    expect(idsRequested(xapi)[0]?.sort()).toEqual([q1.id, q2.id].sort());
  });

  /**
   * Two levels are hydrated so a quote-of-a-quote renders nested; the third
   * renders as a bare x.com link instead. That boundary is a spending
   * decision — each extra level is another $0.005 per distinct quote.
   */
  it("follows a quote of a quote but never asks for the third level", async () => {
    const { store, xapi } = await makeTestApp();
    const level3 = makePost();
    const level2 = makePost({ quotedPostId: level3.id });
    const level1 = makePost({ quotedPostId: level2.id });
    const root = makePost({ quotedPostId: level1.id });
    const byId = new Map([level1, level2, level3].map((p) => [p.id, p]));
    xapi.onGetPostsByIds = (ids) => ids.map((id) => byId.get(id)!).filter(Boolean);

    await ingest(store, xapi, fetchResult([root]));

    expect(idsRequested(xapi)).toEqual([[level1.id], [level2.id]]);
    expect(await store.hasPost(level2.id)).toBe(true);
    expect(await store.hasPost(level3.id)).toBe(false);
  });
});

describe("POST /api/conversations — force semantics", () => {
  /**
   * `firstFetch` guards the read-marking, and only that. A forced refetch of a
   * conversation you've already been reading must not silently mark the whole
   * thread read — that destroys unread state the user can't get back.
   */
  it("does not re-mark a forced refetch read", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    const reply = replyTo(root);
    await seedConversation(store, root, [reply]);
    xapi.onFetchConversation = () => fetchResult([root, reply]);

    const response = await fetchConversationRequest(app, root.id, { force: true });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { unreadIds: string[] };
    expect(body.unreadIds.sort()).toEqual([root.id, reply.id].sort());
    expect(xapi.count("fetchConversation")).toBe(1);
  });

  it("keeps a forced refetch free when the posts were already read today", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    await seedConversation(store, root);
    xapi.onFetchConversation = () => fetchResult([root]);

    const response = await fetchConversationRequest(app, root.id, { force: true });

    const body = (await response.json()) as { cost: { billable: number; usd: number } };
    expect(body.cost).toMatchObject({ billable: 0, usd: 0 });
  });
});

describe("POST /api/conversations — parsing and error mapping", () => {
  it("400s input with no post ID in it, before any X call", async () => {
    const { app, xapi } = await makeTestApp();

    const response = await fetchConversationRequest(app, "https://example.com/not-a-post");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "could not parse a post URL or ID from input",
    });
    expect(xapi.calls).toEqual([]);
  });

  it("400s a bare number too short to be a post ID", async () => {
    const { app, xapi } = await makeTestApp();

    const response = await fetchConversationRequest(app, "1234");

    expect(response.status).toBe(400);
    expect(xapi.calls).toEqual([]);
  });

  /**
   * A body the client mangled is the client's fault: it must read as a 400,
   * not as a server fault with a parser's message attached to it.
   */
  it("400s a malformed JSON body", async () => {
    const { app, xapi } = await makeTestApp();

    const response = await app.request("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON body" });
    expect(xapi.calls).toEqual([]);
  });

  it("passes a 404 from X through as a 404", async () => {
    const { app, xapi } = await makeTestApp();
    xapi.onGetPost = () => {
      throw new XApiError("no such post", 404);
    };

    const response = await fetchConversationRequest(app, "1796000000000000000");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no such post" });
  });

  it("maps any other X failure to a 502", async () => {
    const { app, xapi } = await makeTestApp();
    xapi.onGetPost = () => {
      throw new XApiError("upstream is down", 500);
    };

    const response = await fetchConversationRequest(app, "1796000000000000000");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream is down" });
  });
});

describe("POST /api/conversations/:rootId/refresh — the UTC-day fork", () => {
  const SAME_DAY = "2024-06-01T12:00:00.000Z";

  afterEach(() => {
    setSystemTime();
  });

  /** A cached conversation whose row was written at `at`. */
  async function seedAt(
    at: string,
  ): Promise<Awaited<ReturnType<typeof makeTestApp>> & { root: Post }> {
    setSystemTime(new Date(at));
    const harness = await makeTestApp();
    const root = makePost({ createdAt: at });
    await seedConversation(harness.store, root);
    return { ...harness, root };
  }

  /** The sinceId argument of the nth fetchConversation call. */
  function sinceIdOf(xapi: { calls: { method: string; args: unknown[] }[] }): unknown {
    return xapi.calls.find((c) => c.method === "fetchConversation")?.args[2];
  }

  it("404s a root that was never cached", async () => {
    const { app, xapi } = await makeTestApp();

    const response = await app.request("/api/conversations/1796000000000000000/refresh", {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(xapi.calls).toEqual([]);
  });

  it("re-reads the whole conversation with no since_id on the same UTC day", async () => {
    const { app, store, xapi, root } = await seedAt(SAME_DAY);
    setSystemTime(new Date("2024-06-01T23:00:00.000Z"));
    xapi.onFetchConversation = () => fetchResult([root]);

    const response = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(xapi.count("fetchConversation")).toBe(1);
    expect(sinceIdOf(xapi)).toBeUndefined();
    // A same-day re-read is free, which is the whole reason this branch exists.
    expect(((await response.json()) as RefreshResponse).cost).toMatchObject({ billable: 0 });
    // The row's timestamp advances, so the branch stays reachable today.
    expect((await store.getConversationMeta(root.id))?.fetchedAt).toBe(
      "2024-06-01T23:00:00.000Z",
    );
  });

  it("asks only for posts newer than the newest cached one on a later day", async () => {
    const { app, store, xapi, root } = await seedAt(SAME_DAY);
    const reply = replyTo(root, { createdAt: "2024-06-01T13:00:00.000Z" });
    await store.upsertPosts([reply]);
    setSystemTime(new Date("2024-06-02T09:00:00.000Z"));
    xapi.onFetchConversation = () => fetchResult([]);

    const response = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(sinceIdOf(xapi)).toBe(await store.newestPostId(root.id));
    expect(sinceIdOf(xapi)).toBe(reply.id);
  });

  /**
   * Characterization, not endorsement (2026-07-30 review, H2): the cross-day
   * branch never writes a new `fetchedAt`, so once a conversation is a day
   * old the free same-day branch is unreachable for it forever. Cost-safe by
   * accident, but metrics stop updating. Stage 5b decides what replaces it.
   */
  it("leaves fetchedAt untouched on the cross-day branch", async () => {
    const { app, store, xapi, root } = await seedAt(SAME_DAY);
    setSystemTime(new Date("2024-06-03T09:00:00.000Z"));
    xapi.onFetchConversation = () => fetchResult([]);

    await app.request(`/api/conversations/${root.id}/refresh`, { method: "POST" });

    expect((await store.getConversationMeta(root.id))?.fetchedAt).toBe(SAME_DAY);
  });

  it("treats 23:59:59Z and 00:00:01Z as different UTC days", async () => {
    const before = await seedAt("2024-06-01T23:59:59.000Z");
    before.xapi.onFetchConversation = () => fetchResult([before.root]);
    await before.app.request(`/api/conversations/${before.root.id}/refresh`, { method: "POST" });
    expect(sinceIdOf(before.xapi)).toBeUndefined();

    const after = await seedAt("2024-06-01T23:59:59.000Z");
    await after.store.upsertPosts([after.root]);
    setSystemTime(new Date("2024-06-02T00:00:01.000Z"));
    after.xapi.onFetchConversation = () => fetchResult([]);
    await after.app.request(`/api/conversations/${after.root.id}/refresh`, { method: "POST" });
    expect(sinceIdOf(after.xapi)).toBe(after.root.id);
  });

  it("reports newCount as the id-set delta, not the posts returned", async () => {
    const { app, xapi, root } = await seedAt(SAME_DAY);
    const known = replyTo(root, { createdAt: "2024-06-01T12:30:00.000Z" });
    const fresh = replyTo(root, { createdAt: "2024-06-01T12:40:00.000Z" });
    // The first refresh establishes `known`; the second returns it again
    // alongside one genuinely new post.
    xapi.onFetchConversation = () => fetchResult([root, known]);
    await app.request(`/api/conversations/${root.id}/refresh`, { method: "POST" });

    xapi.onFetchConversation = () => fetchResult([root, known, fresh]);
    const response = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });

    const body = (await response.json()) as RefreshResponse;
    expect(body.cost?.posts).toBe(3);
    expect(body.newCount).toBe(1);
  });
});

describe("GET /api/me/posts — how far the scan pages", () => {
  /** One page of own root posts, each its own conversation. */
  function ownPage(count: number): Post[] {
    return Array.from({ length: count }, () => makePost({ authorId: SELF_USER_ID }));
  }

  it("stops paging the moment it has enough threads", async () => {
    const { app, xapi } = await makeAuthedApp();
    // Every page would offer another, but three threads is the whole ask.
    xapi.onGetOwnPosts = () => ({ posts: ownPage(3), nextToken: "more" });

    const response = await app.request("/api/me/posts?threads=3");

    expect(response.status).toBe(200);
    expect(xapi.count("getOwnPosts")).toBe(1);
    expect(((await response.json()) as OwnPostsResponse).items).toHaveLength(3);
  });

  it("keeps paging while pages are short of the target", async () => {
    const { app, xapi } = await makeAuthedApp();
    const pages = [
      { posts: ownPage(2), nextToken: "p2" },
      { posts: ownPage(2), nextToken: "p3" },
      { posts: ownPage(2) },
    ];
    let served = 0;
    xapi.onGetOwnPosts = () => pages[served++] ?? { posts: [] };

    const response = await app.request("/api/me/posts?threads=6");

    expect(xapi.count("getOwnPosts")).toBe(3);
    expect(((await response.json()) as OwnPostsResponse).items).toHaveLength(6);
  });

  it("stops when the timeline runs out, short of the target", async () => {
    const { app, xapi } = await makeAuthedApp();
    xapi.onGetOwnPosts = () => ({ posts: ownPage(2) });

    const response = await app.request("/api/me/posts?threads=20");

    expect(xapi.count("getOwnPosts")).toBe(1);
    const body = (await response.json()) as OwnPostsResponse;
    expect(body.items).toHaveLength(2);
    // Nothing trimmed and no next page: there is genuinely no more to find.
    expect(body.hasMore).toBe(false);
  });

  it("stops on an empty page even when X still offers a next token", async () => {
    const { app, xapi } = await makeAuthedApp();
    xapi.onGetOwnPosts = () => ({ posts: [], nextToken: "endless" });

    const response = await app.request("/api/me/posts?threads=5");

    expect(response.status).toBe(200);
    expect(xapi.count("getOwnPosts")).toBe(1);
  });

  /**
   * Two assertions, both load-bearing: nothing is spent, and the answer says
   * "sign in" rather than "the upstream is broken". `userContext` raises
   * `XApiError(..., 401)` precisely so the client can offer the login link,
   * and the error contract carries that status out intact.
   */
  it("spends nothing when user context isn't configured, and 401s", async () => {
    const { app, xapi } = await makeTestApp();

    const response = await app.request("/api/me/posts");

    expect(xapi.calls).toEqual([]);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "user context is not configured — visit /auth/login",
    });
  });
});

describe("bookmark sync — what it must never destroy", () => {
  /** A saved entry seeded directly, as an earlier sync or manual add would leave it. */
  async function seedSaved(
    store: Storage,
    post: Post,
    source: string,
    addedAt: string,
  ): Promise<void> {
    await store.upsertPosts([post]);
    await store.addSavedItems([{ postId: post.id, source, addedAt }]);
  }

  it("preserves the original addedAt when a bookmark is seen again", async () => {
    const inFolder = makePost();
    const { app, store } = await makeBookmarkApp([inFolder], true);
    const firstSeen = "2024-01-01T00:00:00.000Z";
    await seedSaved(store, inFolder, "bookmark", firstSeen);

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ added: 0, removed: 0 });
    const item = (await store.listSavedItems()).find((i) => i.postId === inFolder.id);
    expect(item?.addedAt).toBe(firstSeen);
  });

  it("never removes a manually added item, even on a complete scan", async () => {
    const inFolder = makePost();
    const { app, store } = await makeBookmarkApp([inFolder], true);
    const manual = makePost();
    await seedSaved(store, manual, "manual", "2024-01-01T00:00:00.000Z");

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });

    expect(await response.json()).toMatchObject({ complete: true, removed: 0 });
    expect((await store.listSavedItems()).map((i) => i.postId)).toContain(manual.id);
  });

  it("does not re-source a manual item that later shows up in the folder", async () => {
    const shared = makePost();
    const { app, store } = await makeBookmarkApp([shared], true);
    await seedSaved(store, shared, "manual", "2024-01-01T00:00:00.000Z");

    await app.request("/api/bookmarks/sync", { method: "POST" });

    const item = (await store.listSavedItems()).find((i) => i.postId === shared.id);
    expect(item?.source).toBe("manual");
  });

  it("409s a DELETE of a bookmark-sourced entry and keeps it", async () => {
    const { app, store } = await makeTestApp();
    const post = makePost();
    await seedSaved(store, post, "bookmark", new Date().toISOString());

    const response = await app.request(`/api/saved/${post.id}`, { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "un-bookmark it on x.com — sync will remove it here",
    });
    expect((await store.listSavedItems()).map((i) => i.postId)).toContain(post.id);
  });

  it("deletes a manually added entry", async () => {
    const { app, store } = await makeTestApp();
    const post = makePost();
    await seedSaved(store, post, "manual", new Date().toISOString());

    const response = await app.request(`/api/saved/${post.id}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await store.listSavedItems()).toEqual([]);
  });

  it("hydrates the saved list without any X call", async () => {
    const { app, store, xapi } = await makeTestApp();
    const post = makePost();
    await seedSaved(store, post, "bookmark", new Date().toISOString());

    const response = await app.request("/api/saved");

    expect(response.status).toBe(200);
    expect(xapi.calls).toEqual([]);
    expect(methods(xapi)).toEqual([]);
  });
});

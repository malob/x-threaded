import { describe, expect, it, setSystemTime } from "bun:test";
import { buildApp } from "../src/server/app";
import { d1Driver } from "../src/server/db/d1";
import type { SqlDriver } from "../src/server/db/driver";
import { SqlStore } from "../src/server/db/store";
import { resolveQuotedPosts } from "../src/server/conversations";
import { runConversationFetch } from "../src/server/conversation-fetch";
import { SpendMeter } from "../src/server/meter";
import { SELF_ID } from "../src/server/oauth";
import { XApi } from "../src/server/xapi";
import { snowflakeMs } from "../src/shared/snowflake";
import { FakeD1Database, D1_MAX_BOUND_PARAMS } from "./fake-d1";
import { FakeXApi } from "./fake-xapi";
import { makePost, snowflakeId } from "./fixtures";
import { makeD1TestStore, makeTestApp, searchPage, TEST_OAUTH } from "./harness";
import { withMockFetch } from "./setup";

describe("network tripwire", () => {
  it("rejects any fetch", async () => {
    await expect(fetch("https://api.x.com/2/anything")).rejects.toThrow(
      "network tripwire: unexpected fetch to https://api.x.com/2/anything",
    );
  });

  it("withMockFetch serves responses, then restores the tripwire", async () => {
    const restore = withMockFetch((url) => new Response(`mocked ${url}`));
    try {
      const response = await fetch("https://api.x.com/2/tweets/1");
      expect(await response.text()).toBe("mocked https://api.x.com/2/tweets/1");
    } finally {
      restore();
    }
    await expect(fetch("https://api.x.com/2/tweets/1")).rejects.toThrow("network tripwire");
  });

  it("stops the real XApi client", async () => {
    await expect(new XApi("bearer").getPost("12345")).rejects.toThrow("network tripwire");
  });
});

describe("FakeXApi", () => {
  it("throws on an uncanned method, naming it", async () => {
    const xapi = new FakeXApi();
    await expect(xapi.getPost("12345")).rejects.toThrow(
      "unexpected X API call: getPost(12345)",
    );
  });

  it("returns canned values with the receipt the endpoint bills", async () => {
    const xapi = new FakeXApi();
    const post = makePost();
    xapi.onGetPost = () => post;
    expect(await xapi.getPost(post.id)).toEqual({
      value: post,
      receipt: { reads: 1, ownedReads: 0, userReads: 0 },
    });
  });

  /** The two rates, and the nesting: folder stubs are Owned Reads, hydration isn't. */
  it("prices a bookmark folder scan in both units", async () => {
    const xapi = new FakeXApi();
    const hydrated = makePost();
    xapi.onGetBookmarksByFolder = () => ({
      posts: [hydrated],
      ids: [hydrated.id, "1796000000000000000"],
      missing: [{ id: "1796000000000000000" }],
      complete: true,
    });

    const { receipt } = await xapi.getBookmarksByFolder("token", "u1", "folder1");

    expect(receipt).toEqual({ reads: 1, ownedReads: 2, userReads: 0 });
  });

  it("records and counts every call, canned or not", async () => {
    const xapi = new FakeXApi();
    xapi.onGetPostsByIds = () => ({ posts: [], missing: [] });
    await xapi.getPostsByIds(["1", "2"]);
    await xapi.getPostsByIds(["3"]);
    await expect(xapi.getPost("4")).rejects.toThrow();

    expect(xapi.count("getPostsByIds")).toBe(2);
    expect(xapi.count("getPost")).toBe(1);
    expect(xapi.count("searchConversationPage")).toBe(0);
    expect(xapi.calls).toEqual([
      { method: "getPostsByIds", args: [["1", "2"]] },
      { method: "getPostsByIds", args: [["3"]] },
      { method: "getPost", args: ["4"] },
    ]);
  });
});

describe("fixtures", () => {
  it("snowflakeId round-trips through snowflakeMs", () => {
    for (const when of [
      "2010-11-04T01:42:54.657Z", // the epoch itself
      "2024-06-01T12:00:00.000Z",
      "2026-07-30T23:59:59.999Z",
    ]) {
      expect(snowflakeMs(snowflakeId(when))).toBe(Date.parse(when));
    }
  });

  it("keeps id and createdAt consistent in both directions", () => {
    const fromTime = makePost({ createdAt: "2025-03-04T05:06:07.000Z" });
    expect(snowflakeMs(fromTime.id)).toBe(Date.parse(fromTime.createdAt));

    const fromId = makePost({ id: snowflakeId("2025-03-04T05:06:07.000Z") });
    expect(fromId.createdAt).toBe("2025-03-04T05:06:07.000Z");

    const auto = makePost();
    expect(snowflakeMs(auto.id)).toBe(Date.parse(auto.createdAt));
  });

  it("defaults to a root post with distinct, increasing auto ids", () => {
    const first = makePost();
    const second = makePost();
    expect(first.parentId).toBeNull();
    expect(first.conversationId).toBe(first.id);
    expect(BigInt(second.id) > BigInt(first.id)).toBe(true);
  });
});

describe("FakeD1Database", () => {
  it("allows 100 bound parameters and rejects 101", async () => {
    const db = await FakeD1Database.create();
    const ids = Array.from({ length: D1_MAX_BOUND_PARAMS + 1 }, (_, i) => String(i));

    const atLimit = ids.slice(0, D1_MAX_BOUND_PARAMS);
    const query = (n: number) =>
      `SELECT id FROM posts WHERE id IN (${Array(n).fill("?").join(",")})`;
    const { results } = await db.prepare(query(atLimit.length)).bind(...atLimit).all();
    expect(results).toEqual([]);

    expect(() => db.prepare(query(ids.length)).bind(...ids)).toThrow(
      "D1_ERROR: too many SQL variables",
    );
  });

  it("rolls a failed batch back", async () => {
    const db = await FakeD1Database.create();
    const insert = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`);
    await expect(
      db.batch([insert.bind("k", "first", "t"), insert.bind("k", "duplicate", "t")]),
    ).rejects.toThrow();
    const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind("k").first();
    expect(row).toBeNull();
  });
});

async function countedD1Store(): Promise<{
  store: SqlStore;
  queryCount: () => number;
  resetQueryCount: () => void;
}> {
  const base = d1Driver(await FakeD1Database.create());
  let queries = 0;
  const counted: SqlDriver = {
    async first<T>(sql: string, params: unknown[] = []) {
      queries += 1;
      return await base.first<T>(sql, params);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      queries += 1;
      return await base.all<T>(sql, params);
    },
    async run(sql: string, params: unknown[] = []) {
      queries += 1;
      return await base.run(sql, params);
    },
    async batch(statements) {
      queries += statements.length;
      return await base.batch(statements);
    },
  };
  return {
    store: new SqlStore(counted),
    queryCount: () => queries,
    resetQueryCount: () => {
      queries = 0;
    },
  };
}

describe("SqlStore over the D1 fake", () => {
  it("reads conversation response metadata and posts in one D1 query", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const root = makePost();
    const reply = makePost({ conversationId: root.id, parentId: root.id });
    await store.upsertConversation({
      rootId: root.id,
      rootAuthorHandle: root.authorHandle,
      rootText: root.text,
      rootCreatedAt: root.createdAt,
      fetchedAt: root.fetchedAt,
      status: "complete",
      fullReadAt: root.fetchedAt,
    });
    await store.upsertPosts([reply, root]);
    resetQueryCount();

    expect(await store.getConversationResponseSnapshot(root.id)).toEqual({
      status: "complete",
      posts: [root, reply],
    });
    expect(queryCount()).toBe(1);
  });

  it("claims a conversation in two D1 queries and rejects an overlap in one", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();

    expect(
      await store.claimConversationRun("conversation", "run-a", "2024-01-01", 5000, 1000, false),
    ).toEqual({ prior: null });
    expect(queryCount()).toBe(2);

    resetQueryCount();
    expect(
      await store.claimConversationRun("conversation", "run-b", "2024-01-01", 6000, 2000, false),
    ).toBeNull();
    expect(queryCount()).toBe(1);
  });

  it("claims and finishes the first profile in three D1 statements", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    await store.putOAuthTokens("self", {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "users.read",
    });
    resetQueryCount();

    expect(
      await store.claimUserProfileLease("self", "refresh", "profile-lease", 5000, 1000),
    ).toBe(true);
    expect(queryCount()).toBe(1);
    expect(
      await store.finishUserProfileLease("self", "refresh", "profile-lease", {
        userId: "42",
        username: "someone",
        displayName: "Some One",
      }),
    ).toBe(true);
    expect(queryCount()).toBe(3);
  });

  it("bounds an active profile-lease wait to fifteen D1 queries and no X spend", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const now = Date.now();
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: now + 60 * 60 * 1000,
      scope: "users.read bookmark.read",
    });
    expect(
      await store.claimUserProfileLease(
        SELF_ID,
        "refresh",
        "crashed-holder",
        now + 2 * 60_000,
        now,
      ),
    ).toBe(true);
    resetQueryCount();
    const xapi = new FakeXApi();
    const app = buildApp({ store, xapi, maxPosts: 500, oauth: TEST_OAUTH });

    const response = await app.request("/api/bookmarks/folders");

    expect(response.status).toBe(409);
    expect(xapi.count("getMe")).toBe(0);
    expect(xapi.count("getBookmarkFolders")).toBe(0);
    expect(queryCount()).toBe(15);
  });

  it("recovers an already-expired profile lease and completes the route in four D1 statements", async () => {
    const started = new Date("2024-06-01T12:00:00.000Z");
    setSystemTime(started);
    try {
      const { store, queryCount, resetQueryCount } = await countedD1Store();
      await store.putOAuthTokens(SELF_ID, {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: started.getTime() + 60 * 60 * 1000,
        scope: "users.read bookmark.read",
      });
      expect(
        await store.claimUserProfileLease(
          SELF_ID,
          "refresh",
          "crashed-holder",
          started.getTime() + 2 * 60_000,
          started.getTime(),
        ),
      ).toBe(true);
      setSystemTime(new Date(started.getTime() + 3 * 60_000));
      resetQueryCount();
      const xapi = new FakeXApi();
      xapi.onGetMe = () => ({ id: "42", username: "someone", name: "Some One" });
      xapi.onGetBookmarkFolders = () => [];
      const app = buildApp({ store, xapi, maxPosts: 500, oauth: TEST_OAUTH });

      const response = await app.request("/api/bookmarks/folders");

      expect(response.status).toBe(200);
      expect(xapi.count("getMe")).toBe(1);
      expect(xapi.count("getBookmarkFolders")).toBe(1);
      expect(queryCount()).toBe(4);
    } finally {
      setSystemTime();
    }
  });

  it("persists an ordinary 100-post API page with one D1 query", async () => {
    const { store, queryCount } = await countedD1Store();
    const posts = Array.from({ length: 100 }, (_, i) => makePost({ text: `post ${i}` }));

    await store.upsertPosts(posts);

    expect(queryCount()).toBe(1);
    expect(await store.getPostsByIds(posts.map((post) => post.id))).toHaveLength(posts.length);
  });

  it("round-trips posts", async () => {
    const store = await makeD1TestStore();
    const root = makePost({ text: "the root" });
    const reply = makePost({ conversationId: root.id, parentId: root.id, text: "a reply" });
    await store.upsertPosts([root, reply]);

    expect(await store.getPost(root.id)).toEqual(root);
    expect(await store.getPost(reply.id)).toEqual(reply);
    expect(await store.getPost("404")).toBeNull();
    expect(await store.getPosts(root.id)).toEqual([root, reply]);
  });

  it("resolves a page of cached quotes with one D1 read", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const quotes = Array.from({ length: 50 }, (_, i) => makePost({ text: `quote ${i}` }));
    const sources = quotes.map((quote, i) =>
      makePost({ text: `source ${i}`, quotedPostId: quote.id }),
    );
    await store.upsertPosts(quotes);
    resetQueryCount();

    const byId = new Map(sources.map((post) => [post.id, post]));
    const xapi = new FakeXApi();
    await resolveQuotedPosts(store, xapi, new SpendMeter(), sources, byId);

    expect(queryCount()).toBe(1);
    expect(quotes.every((quote) => byId.has(quote.id))).toBe(true);
    expect(xapi.calls).toEqual([]);
  });

  it("marks an ordinary 100-post page read with one D1 query", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const root = makePost();
    const posts = [
      root,
      ...Array.from({ length: 99 }, (_, i) =>
        makePost({ conversationId: root.id, parentId: root.id, text: `reply ${i}` }),
      ),
    ];
    await store.upsertPosts(posts);
    resetQueryCount();

    await store.setReadState(
      posts.map((post) => post.id),
      true,
    );

    expect(queryCount()).toBe(1);
    expect(await store.getUnreadIds(root.id)).toEqual([]);
  });

  it("checks a 100-post page's same-day credit with one D1 query", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const posts = Array.from({ length: 100 }, (_, i) => makePost({ text: `post ${i}` }));
    await store.upsertPosts(posts);
    resetQueryCount();

    const found = await store.postIdsReadToday(posts.map((post) => post.id));

    expect(queryCount()).toBe(1);
    expect(found).toEqual(new Set(posts.map((post) => post.id)));
  });

  it("adds a 100-post bookmark page with one D1 query", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const posts = Array.from({ length: 100 }, (_, i) => makePost({ text: `post ${i}` }));
    await store.upsertPosts(posts);
    resetQueryCount();

    await store.addSavedItems(
      posts.map((post, i) => ({
        postId: post.id,
        source: "bookmark",
        addedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
      })),
    );

    expect(queryCount()).toBe(1);
    expect(await store.listSavedItems()).toHaveLength(posts.length);
  });

  it("commits a maximal bookmark scan in four D1 statements", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const posts = Array.from({ length: 1_000 }, (_, index) =>
      makePost({ text: `bookmark ${index}` }),
    );
    await store.setBookmarkFolder("folder1", "Reading");
    await store.beginBookmarkSync("folder1", "run-max", 5000, 1000);
    resetQueryCount();

    expect(
      await store.finishBookmarkSync(
        "folder1",
        "run-max",
        posts,
        posts.map((post) => post.id),
        true,
        "2024-01-01T00:00:00.000Z",
      ),
    ).toEqual({ applied: true, added: 1_000, removed: 0 });
    expect(queryCount()).toBe(4);
    expect(queryCount()).toBeLessThanOrEqual(50);
  });

  it("keeps a maximal bookmark route inside D1 Free's query budget", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const posts = Array.from({ length: 1_000 }, (_, index) =>
      makePost({ text: `bookmark route ${index}` }),
    );
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account",
    });
    await store.setBookmarkFolder("folder1", "Reading");
    const xapi = new FakeXApi();
    xapi.onGetBookmarksByFolder = async (_token, _userId, _folderId, opts) => {
      // FakeXApi supplies page one and all ten hydration boundaries. These
      // calls model the other nine folder pages in the real client.
      for (let page = 1; page < 10; page++) await opts?.beforeRequest?.();
      return {
        posts,
        ids: posts.map((post) => post.id),
        missing: [],
        complete: true,
      };
    };
    const app = buildApp({ store, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    resetQueryCount();

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });

    expect(response.status).toBe(200);
    expect(xapi.count("getBookmarksByFolder")).toBe(1);
    expect(queryCount()).toBe(28);
    expect(queryCount()).toBeLessThanOrEqual(50);
  });

  it("keeps first-profile resolution plus a maximal bookmark route under 50 queries", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const posts = Array.from({ length: 1_000 }, (_, index) =>
      makePost({ text: `first profile bookmark ${index}` }),
    );
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
    });
    await store.setBookmarkFolder("folder1", "Reading");
    const xapi = new FakeXApi();
    xapi.onGetMe = () => ({ id: "account", username: "reader", name: "Reader" });
    xapi.onGetBookmarksByFolder = async (_token, _userId, _folderId, opts) => {
      for (let page = 1; page < 10; page++) await opts?.beforeRequest?.();
      return {
        posts,
        ids: posts.map((post) => post.id),
        missing: [],
        complete: true,
      };
    };
    const app = buildApp({ store, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    resetQueryCount();

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });

    expect(response.status).toBe(200);
    expect(xapi.count("getMe")).toBe(1);
    expect(queryCount()).toBe(31);
    expect(queryCount()).toBeLessThanOrEqual(50);
  });

  it("refuses a twelfth finish statement after worst-case profile polling and outbound checks", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const now = Date.now();
    const crashedUntil = now + 60_000;
    const posts = Array.from({ length: 1_000 }, (_, index) =>
      makePost({ text: `${index}:${"x".repeat(12_000)}` }),
    );
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: now + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
    });
    await store.setBookmarkFolder("folder1", "Reading");
    expect(
      await store.claimUserProfileLease(
        SELF_ID,
        "refresh",
        "crashed-holder",
        crashedUntil,
        now,
      ),
    ).toBe(true);

    // Six ordinary passes observe the crashed holder. The seventh is made at
    // exact expiry so it exercises the resolver's maximum seven snapshot / seven
    // claim reads, followed by the winning two-statement profile finish.
    const claimProfile = store.claimUserProfileLease.bind(store);
    let profilePasses = 0;
    store.claimUserProfileLease = async (
      id,
      observedRefreshToken,
      leaseId,
      leaseUntil,
      claimNow,
    ) => {
      profilePasses += 1;
      return await claimProfile(
        id,
        observedRefreshToken,
        leaseId,
        profilePasses === 7 ? crashedUntil + 2 * 60_000 : leaseUntil,
        profilePasses === 7 ? crashedUntil : claimNow,
      );
    };

    const xapi = new FakeXApi();
    xapi.onGetMe = () => ({ id: "account", username: "reader", name: "Reader" });
    xapi.onGetBookmarksByFolder = async (_token, _userId, _folderId, opts) => {
      // FakeXApi supplies the first folder boundary and ten hydration batches;
      // these are the remaining nine folder pages, for the route maximum of 20.
      for (let page = 1; page < 10; page++) await opts?.beforeRequest?.();
      return {
        posts,
        ids: posts.map((post) => post.id),
        missing: [],
        complete: true,
      };
    };
    const app = buildApp({ store, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    resetQueryCount();

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });

    expect(profilePasses).toBe(7);
    expect(xapi.count("getMe")).toBe(1);
    expect(xapi.count("getBookmarksByFolder")).toBe(1);
    // 2 folder/claim + 16 profile + 20 ownership + 1 credit = 39. Refusing
    // the twelve-statement finish performs no batch, then owner-bound abort is 40.
    expect(queryCount()).toBe(40);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "bookmark sync exceeded its safe database budget; retry a smaller scan",
    });
    expect(await store.listSavedItems()).toEqual([]);
  });

  it("refuses an oversized bookmark finish before exceeding its D1 reserve", async () => {
    const { store, queryCount, resetQueryCount } = await countedD1Store();
    const posts = Array.from({ length: 1_000 }, (_, index) =>
      makePost({ text: `${index}:${"x".repeat(20_000)}` }),
    );
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account",
    });
    await store.setBookmarkFolder("folder1", "Reading");
    const xapi = new FakeXApi();
    xapi.onGetBookmarksByFolder = async (_token, _userId, _folderId, opts) => {
      for (let page = 1; page < 10; page++) await opts?.beforeRequest?.();
      return {
        posts,
        ids: posts.map((post) => post.id),
        missing: [],
        complete: true,
      };
    };
    const app = buildApp({ store, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    resetQueryCount();

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "bookmark sync exceeded its safe database budget; retry a smaller scan",
    });
    expect(queryCount()).toBe(25);
    expect(queryCount()).toBeLessThanOrEqual(50);
    expect(await store.listSavedItems()).toEqual([]);
  });

  it("keeps the five-page default fixture with no ancillary work inside D1 Free's budget", async () => {
    const { store, queryCount } = await countedD1Store();
    const root = makePost();
    const posts = [
      root,
      ...Array.from({ length: 499 }, (_, i) =>
        makePost({ conversationId: root.id, parentId: root.id, text: `reply ${i}` }),
      ),
    ];
    const pages = Array.from({ length: 5 }, (_, page) =>
      searchPage(posts.slice(page * 100, (page + 1) * 100), {
        nextToken: page < 4 ? `page-${page + 2}` : undefined,
      }),
    );
    const xapi = new FakeXApi();
    let served = 0;
    xapi.onSearchConversationPage = () => pages[served++]!;

    await runConversationFetch(store, xapi, new SpendMeter(), root.id, { maxPosts: 500 });

    expect(served).toBe(5);
    expect(queryCount()).toBe(14);
    expect(queryCount()).toBeLessThanOrEqual(50);
  });
});

describe("makeTestApp", () => {
  it("404s an uncached conversation without touching the X API", async () => {
    const { app, xapi } = await makeTestApp();
    const response = await app.request("/api/conversations/12345");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "conversation not cached" });
    expect(xapi.calls).toEqual([]);
  });

  it("writes read state through the real store", async () => {
    const { app, store } = await makeTestApp();
    const post = makePost();
    await store.upsertPosts([post]);
    expect(await store.getUnreadIds(post.conversationId)).toEqual([post.id]);

    const response = await app.request("/api/read-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postIds: [post.id], read: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await store.getUnreadIds(post.conversationId)).toEqual([]);
  });
});

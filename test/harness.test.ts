import { describe, expect, it } from "bun:test";
import { XApi } from "../src/server/xapi";
import { snowflakeMs } from "../src/shared/snowflake";
import { FakeD1Database, D1_MAX_BOUND_PARAMS } from "./fake-d1";
import { FakeXApi } from "./fake-xapi";
import { makePost, snowflakeId } from "./fixtures";
import { makeD1TestStore, makeTestApp } from "./harness";
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
      receipt: { reads: 1, ownedReads: 0 },
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

    expect(receipt).toEqual({ reads: 1, ownedReads: 2 });
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

describe("SqlStore over the D1 fake", () => {
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

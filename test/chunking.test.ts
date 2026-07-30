import { describe, expect, it } from "bun:test";
import type { Post } from "../src/shared/types";
import { MAX_SQL_PARAMS, chunked } from "../src/server/chunk";
import type { Storage } from "../src/server/storage";
import { SqliteStore } from "../src/server/store-sqlite";
import { D1_MAX_BOUND_PARAMS } from "./fake-d1";
import { makePost } from "./fixtures";
import { makeD1TestStore } from "./harness";

describe("chunked", () => {
  it("splits into runs of at most size, in order", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(chunked([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
    expect(chunked([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it("gives an empty list no chunks, so callers can loop unguarded", () => {
    expect(chunked([], 100)).toEqual([]);
  });

  it("rejects a size that couldn't make progress", () => {
    expect(() => chunked([1], 0)).toThrow("positive integer");
    expect(() => chunked([1], -1)).toThrow("positive integer");
    expect(() => chunked([1], 1.5)).toThrow("positive integer");
  });

  it("matches the ceiling the D1 fake enforces", () => {
    expect(MAX_SQL_PARAMS).toBe(D1_MAX_BOUND_PARAMS);
  });
});

/** `count` posts in one conversation, so getUnreadIds can see them all. */
function makeThread(count: number): Post[] {
  const root = makePost({ text: "root" });
  const replies = Array.from({ length: count - 1 }, (_, i) =>
    makePost({ conversationId: root.id, parentId: root.id, text: `reply ${i}` }),
  );
  return [root, ...replies];
}

/**
 * Both stores, same expectations. D1 is the one that enforces the
 * 100-bound-parameter ceiling (through FakeD1Database); the bun:sqlite leg
 * pins that chunking didn't change the answers.
 */
const stores: [string, () => Storage][] = [
  ["D1Store", makeD1TestStore],
  ["SqliteStore", () => new SqliteStore(":memory:")],
];

describe.each(stores)("%s id-list queries past D1's parameter ceiling", (_name, makeStore) => {
  it("getPostsByIds returns every post for 250 ids", async () => {
    const store = makeStore();
    const posts = makeThread(250);
    await store.upsertPosts(posts);

    const found = await store.getPostsByIds(posts.map((p) => p.id));
    expect(found.length).toBe(250);
    expect(new Set(found.map((p) => p.id))).toEqual(new Set(posts.map((p) => p.id)));
  });

  // Exactly 100 ids is already over the line: the date rides along as a 101st
  // bound parameter.
  it("postIdsReadToday returns all 100 ids fetched today", async () => {
    const store = makeStore();
    const posts = makeThread(100);
    await store.upsertPosts(posts);

    const ids = posts.map((p) => p.id);
    expect(await store.postIdsReadToday(ids)).toEqual(new Set(ids));
  });

  it("postIdsReadToday excludes posts fetched on an earlier day", async () => {
    const store = makeStore();
    const posts = makeThread(100);
    const stale = posts.slice(0, 40).map((p) => ({ ...p, fetchedAt: "2024-01-02T03:04:05.000Z" }));
    await store.upsertPosts([...stale, ...posts.slice(40)]);

    const ids = posts.map((p) => p.id);
    expect(await store.postIdsReadToday(ids)).toEqual(new Set(ids.slice(40)));
  });

  it("setReadState marks 150 posts read, then unread again", async () => {
    const store = makeStore();
    const posts = makeThread(150);
    await store.upsertPosts(posts);
    const ids = posts.map((p) => p.id);
    const conversationId = posts[0]!.conversationId;

    expect((await store.getUnreadIds(conversationId)).length).toBe(150);
    await store.setReadState(ids, true);
    expect(await store.getUnreadIds(conversationId)).toEqual([]);
    await store.setReadState(ids, false);
    expect(new Set(await store.getUnreadIds(conversationId))).toEqual(new Set(ids));
  });

  it("leaves ids it wasn't given alone", async () => {
    const store = makeStore();
    const posts = makeThread(150);
    await store.upsertPosts(posts);
    const ids = posts.map((p) => p.id);
    const conversationId = posts[0]!.conversationId;

    await store.setReadState(ids, true);
    await store.setReadState(ids.slice(0, 120), false);
    expect(new Set(await store.getUnreadIds(conversationId))).toEqual(new Set(ids.slice(0, 120)));
  });

  it("handles empty and single-id lists", async () => {
    const store = makeStore();
    const posts = makeThread(2);
    await store.upsertPosts(posts);
    const only = posts[0]!.id;

    expect(await store.getPostsByIds([])).toEqual([]);
    expect(await store.postIdsReadToday([])).toEqual(new Set());
    await store.setReadState([], false);

    expect((await store.getPostsByIds([only])).map((p) => p.id)).toEqual([only]);
    expect(await store.postIdsReadToday([only])).toEqual(new Set([only]));
  });
});

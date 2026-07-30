/**
 * The Storage contract, as executable specification.
 *
 * One `SqlStore` now serves both runtimes, so the thing worth testing is no
 * longer "do the two stores agree" but "does the one store still behave the
 * same on every driver under it". Run this against each driver; a divergence
 * in SQL dialect, parameter handling, or batch semantics shows up here rather
 * than in production (2026-07-30 review, S1).
 *
 * Every case builds its own fixtures, so `makeStore` may hand back a shared
 * database as long as it arrives empty.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { SavedItem, Storage } from "../src/server/storage";
import type { Post } from "../src/shared/types";
import { makePost } from "./fixtures";

export type MakeStore = () => Storage | Promise<Storage>;

/** Batch sizes that straddle the 100-bound-parameter ceiling. */
const BATCH_SIZES = [0, 1, 99, 100, 101, 250];

/** `count` posts in one conversation: a root and its direct replies. */
function makeThread(count: number): Post[] {
  const root = makePost({ text: "root" });
  const replies = Array.from({ length: Math.max(count - 1, 0) }, (_, i) =>
    makePost({ conversationId: root.id, parentId: root.id, text: `reply ${i}` }),
  );
  return count === 0 ? [] : [root, ...replies];
}

function savedItem(postId: string, overrides: Partial<SavedItem> = {}): SavedItem {
  return { postId, source: "manual", addedAt: "2024-01-01T00:00:00.000Z", ...overrides };
}

export function describeStorageContract(name: string, makeStore: MakeStore): void {
  describe(`Storage contract (${name})`, () => {
    afterEach(() => {
      setSystemTime();
    });

    describe("conversations", () => {
      const meta = {
        rootId: "1796000000000000001",
        rootAuthorHandle: "someone",
        rootText: "the root text",
        rootCreatedAt: "2024-05-01T00:00:00.000Z",
        fetchedAt: "2024-06-01T00:00:00.000Z",
      };

      it("round-trips a conversation row", async () => {
        const store = await makeStore();
        await store.upsertConversation(meta);

        expect(await store.getConversationMeta(meta.rootId)).toEqual({
          rootAuthorHandle: meta.rootAuthorHandle,
          rootText: meta.rootText,
          rootCreatedAt: meta.rootCreatedAt,
          fetchedAt: meta.fetchedAt,
        });
        expect(await store.hasConversation(meta.rootId)).toBe(true);
      });

      it("answers null and false for a conversation it has never seen", async () => {
        const store = await makeStore();
        expect(await store.getConversationMeta(meta.rootId)).toBeNull();
        expect(await store.hasConversation(meta.rootId)).toBe(false);
      });

      /**
       * The upsert is a touch, not a rewrite: re-fetching must not overwrite
       * the root's text or author with whatever the caller happened to pass.
       */
      it("updates only fetched_at on conflict", async () => {
        const store = await makeStore();
        await store.upsertConversation(meta);

        await store.upsertConversation({
          ...meta,
          rootAuthorHandle: "impostor",
          rootText: "clobbered",
          rootCreatedAt: "1999-01-01T00:00:00.000Z",
          fetchedAt: "2024-06-02T00:00:00.000Z",
        });

        expect(await store.getConversationMeta(meta.rootId)).toEqual({
          rootAuthorHandle: meta.rootAuthorHandle,
          rootText: meta.rootText,
          rootCreatedAt: meta.rootCreatedAt,
          fetchedAt: "2024-06-02T00:00:00.000Z",
        });
      });

      it("hasConversations answers for a page at once, ignoring unknown ids", async () => {
        const store = await makeStore();
        const cached = ["10", "20"];
        for (const rootId of cached) await store.upsertConversation({ ...meta, rootId });

        expect(await store.hasConversations([...cached, "30"])).toEqual(new Set(cached));
      });

      it.each([0, 1, 101])("hasConversations handles %i ids", async (count) => {
        const store = await makeStore();
        const ids = Array.from({ length: count }, (_, i) => `conv-${i}`);
        for (const rootId of ids) await store.upsertConversation({ ...meta, rootId });

        expect(await store.hasConversations(ids)).toEqual(new Set(ids));
        // Unknown ids past the ceiling stay unknown.
        expect(await store.hasConversations([...ids, "absent"])).toEqual(new Set(ids));
      });
    });

    describe("posts", () => {
      it("round-trips every field, including the JSON columns", async () => {
        const store = await makeStore();
        const post = makePost({
          text: "quoting someone",
          authorAvatarUrl: "https://pbs.example/avatar.jpg",
          metrics: { likes: 1, replies: 2, reposts: 3, quotes: 4, bookmarks: 5, impressions: 6 },
          entities: {
            urls: [
              { url: "https://t.co/x", expanded_url: "https://example.com", display_url: "ex" },
            ],
          },
          quotedPostId: "1796000000000000009",
          media: [
            {
              mediaKey: "3_1",
              type: "photo",
              url: "https://pbs.example/1.jpg",
              previewImageUrl: null,
              width: 100,
              height: 50,
            },
          ],
        });
        await store.upsertPosts([post]);

        expect(await store.getPost(post.id)).toEqual(post);
        expect(await store.hasPost(post.id)).toBe(true);
      });

      it("answers null and false for a post it has never seen", async () => {
        const store = await makeStore();
        expect(await store.getPost("1796000000000000000")).toBeNull();
        expect(await store.hasPost("1796000000000000000")).toBe(false);
      });

      it("replaces a post that comes back with new metrics", async () => {
        const store = await makeStore();
        const post = makePost();
        await store.upsertPosts([post]);
        const updated = { ...post, metrics: { ...post.metrics, likes: 42 } };

        await store.upsertPosts([updated]);

        expect(await store.getPost(post.id)).toEqual(updated);
        expect(await store.getPosts(post.conversationId)).toEqual([updated]);
      });

      it("upserting nothing is a no-op", async () => {
        const store = await makeStore();
        await store.upsertPosts([]);
        expect(await store.getPostsByIds([])).toEqual([]);
      });

      it("getPosts returns one conversation in createdAt order", async () => {
        const store = await makeStore();
        const root = makePost({ createdAt: "2024-06-01T10:00:00.000Z" });
        const late = makePost({
          conversationId: root.id,
          parentId: root.id,
          createdAt: "2024-06-01T12:00:00.000Z",
        });
        const early = makePost({
          conversationId: root.id,
          parentId: root.id,
          createdAt: "2024-06-01T11:00:00.000Z",
        });
        const elsewhere = makePost({ createdAt: "2024-06-01T13:00:00.000Z" });
        await store.upsertPosts([late, elsewhere, root, early]);

        expect((await store.getPosts(root.id)).map((p) => p.id)).toEqual([
          root.id,
          early.id,
          late.id,
        ]);
        expect(await store.existingPostIds(root.id)).toEqual(
          new Set([root.id, early.id, late.id]),
        );
      });

      it("existingPostIds is empty for an unknown conversation", async () => {
        const store = await makeStore();
        expect(await store.existingPostIds("1796000000000000000")).toEqual(new Set());
      });

      /**
       * since_id is derived from this, and X IDs are numbers in a string: plain
       * lexical ordering would call "99" newer than "100" and re-fetch posts
       * that were already paid for. Length first, then lexically.
       */
      it("newestPostId orders by length, then lexically", async () => {
        const store = await makeStore();
        const conversationId = "1796000000000000000";
        const at = "2024-06-01T00:00:00.000Z";
        for (const id of ["99", "100", "12"]) {
          await store.upsertPosts([makePost({ id, createdAt: at, conversationId })]);
        }

        expect(await store.newestPostId(conversationId)).toBe("100");
      });

      it("newestPostId is null for an unknown conversation", async () => {
        const store = await makeStore();
        expect(await store.newestPostId("1796000000000000000")).toBeNull();
      });

      it("getPostsByIds skips ids it doesn't have", async () => {
        const store = await makeStore();
        const post = makePost();
        await store.upsertPosts([post]);

        const found = await store.getPostsByIds([post.id, "1796000000000000000"]);

        expect(found.map((p) => p.id)).toEqual([post.id]);
      });

      it.each(BATCH_SIZES)("getPostsByIds returns all %i posts", async (count) => {
        const store = await makeStore();
        const posts = makeThread(count);
        await store.upsertPosts(posts);

        const found = await store.getPostsByIds(posts.map((p) => p.id));

        expect(found.length).toBe(count);
        expect(new Set(found.map((p) => p.id))).toEqual(new Set(posts.map((p) => p.id)));
      });
    });

    describe("postIdsReadToday", () => {
      it("splits today's reads from an earlier day's", async () => {
        const store = await makeStore();
        setSystemTime(new Date("2024-06-01T12:00:00.000Z"));
        const fresh = makePost({ fetchedAt: "2024-06-01T00:00:01.000Z" });
        const alsoFresh = makePost({ fetchedAt: "2024-06-01T23:59:59.000Z" });
        const stale = makePost({ fetchedAt: "2024-05-31T23:59:59.000Z" });
        await store.upsertPosts([fresh, alsoFresh, stale]);

        const ids = [fresh.id, alsoFresh.id, stale.id, "1796000000000000000"];

        expect(await store.postIdsReadToday(ids)).toEqual(new Set([fresh.id, alsoFresh.id]));
      });

      // 100 ids is already over the line: the date rides along as a 101st
      // bound parameter, which is why the store chunks these one short.
      it.each(BATCH_SIZES)("returns all %i ids read today", async (count) => {
        const store = await makeStore();
        setSystemTime(new Date("2024-06-01T12:00:00.000Z"));
        const posts = makeThread(count).map((p) => ({
          ...p,
          fetchedAt: "2024-06-01T09:00:00.000Z",
        }));
        await store.upsertPosts(posts);

        const ids = posts.map((p) => p.id);

        expect(await store.postIdsReadToday(ids)).toEqual(new Set(ids));
      });

      it("excludes the stale half of a list that spans several chunks", async () => {
        const store = await makeStore();
        setSystemTime(new Date("2024-06-01T12:00:00.000Z"));
        const posts = makeThread(250);
        const stale = posts.slice(0, 120).map((p) => ({ ...p, fetchedAt: "2024-05-31T09:00:00.000Z" }));
        const fresh = posts.slice(120).map((p) => ({ ...p, fetchedAt: "2024-06-01T09:00:00.000Z" }));
        await store.upsertPosts([...stale, ...fresh]);

        expect(await store.postIdsReadToday(posts.map((p) => p.id))).toEqual(
          new Set(fresh.map((p) => p.id)),
        );
      });
    });

    describe("read state", () => {
      it("starts everything unread, then marks and unmarks", async () => {
        const store = await makeStore();
        const [root, reply] = makeThread(2) as [Post, Post];
        await store.upsertPosts([root, reply]);

        expect(new Set(await store.getUnreadIds(root.id))).toEqual(new Set([root.id, reply.id]));
        await store.setReadState([root.id], true);
        expect(await store.getUnreadIds(root.id)).toEqual([reply.id]);
        await store.setReadState([root.id], false);
        expect(new Set(await store.getUnreadIds(root.id))).toEqual(new Set([root.id, reply.id]));
      });

      it("is idempotent in both directions", async () => {
        const store = await makeStore();
        const [root] = makeThread(1) as [Post];
        await store.upsertPosts([root]);

        await store.setReadState([root.id], true);
        await store.setReadState([root.id], true);
        expect(await store.getUnreadIds(root.id)).toEqual([]);

        await store.setReadState([root.id], false);
        await store.setReadState([root.id], false);
        expect(await store.getUnreadIds(root.id)).toEqual([root.id]);
      });

      it("leaves ids it wasn't given alone", async () => {
        const store = await makeStore();
        const posts = makeThread(150);
        await store.upsertPosts(posts);
        const ids = posts.map((p) => p.id);

        await store.setReadState(ids, true);
        await store.setReadState(ids.slice(0, 120), false);

        expect(new Set(await store.getUnreadIds(posts[0]!.id))).toEqual(new Set(ids.slice(0, 120)));
      });

      it("marking an empty list changes nothing", async () => {
        const store = await makeStore();
        const [root] = makeThread(1) as [Post];
        await store.upsertPosts([root]);

        await store.setReadState([], true);
        await store.setReadState([], false);

        expect(await store.getUnreadIds(root.id)).toEqual([root.id]);
      });

      it.each(BATCH_SIZES)("marks %i posts read, then unread again", async (count) => {
        const store = await makeStore();
        const posts = makeThread(count);
        await store.upsertPosts(posts);
        const ids = posts.map((p) => p.id);
        const conversationId = posts[0]?.id ?? "1796000000000000000";

        expect((await store.getUnreadIds(conversationId)).length).toBe(count);
        await store.setReadState(ids, true);
        expect(await store.getUnreadIds(conversationId)).toEqual([]);
        await store.setReadState(ids, false);
        expect(new Set(await store.getUnreadIds(conversationId))).toEqual(new Set(ids));
      });

      it("marks a whole conversation read, and unread returns for later posts", async () => {
        const store = await makeStore();
        const [root, reply] = makeThread(2) as [Post, Post];
        await store.upsertPosts([root, reply]);

        await store.markConversationRead(root.id);
        expect(await store.getUnreadIds(root.id)).toEqual([]);

        // A reply that arrives after the read-marking is what "unread" is for.
        const arrival = makePost({ conversationId: root.id, parentId: root.id });
        await store.upsertPosts([arrival]);
        expect(await store.getUnreadIds(root.id)).toEqual([arrival.id]);
      });

      it("marking an uncached conversation read is a no-op", async () => {
        const store = await makeStore();
        await store.markConversationRead("1796000000000000000");
        expect(await store.getUnreadIds("1796000000000000000")).toEqual([]);
      });
    });

    describe("oauth tokens", () => {
      const tokens = {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 1_760_000_000_000,
        scope: "tweet.read users.read",
      };

      it("round-trips a token row with a cached user ID", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", { ...tokens, userId: "42" });

        expect(await store.getOAuthTokens("self")).toEqual({ ...tokens, userId: "42" });
      });

      it("round-trips a token row with no user ID yet", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", { ...tokens, userId: null });

        expect(await store.getOAuthTokens("self")).toEqual({ ...tokens, userId: null });
      });

      it("stores an absent userId as null", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", tokens);

        expect(await store.getOAuthTokens("self")).toEqual({ ...tokens, userId: null });
      });

      it("replaces the row on rotation, and keys by id", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", { ...tokens, userId: "42" });
        await store.putOAuthTokens("self", {
          accessToken: "access-2",
          refreshToken: "refresh-2",
          expiresAt: 1_770_000_000_000,
          scope: "tweet.read",
          userId: "42",
        });

        expect(await store.getOAuthTokens("self")).toMatchObject({
          accessToken: "access-2",
          refreshToken: "refresh-2",
        });
        expect(await store.getOAuthTokens("someone-else")).toBeNull();
      });
    });

    describe("settings", () => {
      it("round-trips and overwrites a key", async () => {
        const store = await makeStore();
        expect(await store.getSetting("bookmark_folder_id")).toBeNull();

        await store.setSetting("bookmark_folder_id", "folder1");
        expect(await store.getSetting("bookmark_folder_id")).toBe("folder1");

        await store.setSetting("bookmark_folder_id", "folder2");
        expect(await store.getSetting("bookmark_folder_id")).toBe("folder2");
        // Empty string is how "no folder selected" is written; not null.
        await store.setSetting("bookmark_folder_id", "");
        expect(await store.getSetting("bookmark_folder_id")).toBe("");
      });
    });

    describe("saved items", () => {
      it("lists newest first", async () => {
        const store = await makeStore();
        await store.addSavedItems([
          savedItem("1", { addedAt: "2024-01-01T00:00:00.000Z" }),
          savedItem("3", { addedAt: "2024-03-01T00:00:00.000Z", source: "bookmark" }),
          savedItem("2", { addedAt: "2024-02-01T00:00:00.000Z" }),
        ]);

        expect((await store.listSavedItems()).map((i) => i.postId)).toEqual(["3", "2", "1"]);
      });

      /** Re-syncing a folder must not reset a row's place in the queue. */
      it("ignores a re-add, keeping the original addedAt and source", async () => {
        const store = await makeStore();
        await store.addSavedItems([
          savedItem("1", { source: "manual", addedAt: "2024-01-01T00:00:00.000Z" }),
        ]);

        await store.addSavedItems([
          savedItem("1", { source: "bookmark", addedAt: "2024-09-09T00:00:00.000Z" }),
        ]);

        expect(await store.listSavedItems()).toEqual([
          { postId: "1", source: "manual", addedAt: "2024-01-01T00:00:00.000Z" },
        ]);
      });

      it("adding nothing is a no-op", async () => {
        const store = await makeStore();
        await store.addSavedItems([]);
        expect(await store.listSavedItems()).toEqual([]);
      });

      it("getSavedItem finds one entry, or null", async () => {
        const store = await makeStore();
        await store.addSavedItems([savedItem("1", { source: "bookmark" })]);

        expect(await store.getSavedItem("1")).toEqual({
          postId: "1",
          source: "bookmark",
          addedAt: "2024-01-01T00:00:00.000Z",
        });
        expect(await store.getSavedItem("2")).toBeNull();
      });

      it("removes one entry, leaving the rest", async () => {
        const store = await makeStore();
        await store.addSavedItems([savedItem("1"), savedItem("2")]);

        await store.removeSavedItem("1");
        await store.removeSavedItem("absent");

        expect((await store.listSavedItems()).map((i) => i.postId)).toEqual(["2"]);
      });

      it.each([0, 1, 101])("removes %i entries at once", async (count) => {
        const store = await makeStore();
        const ids = Array.from({ length: count }, (_, i) => `saved-${i}`);
        await store.addSavedItems([...ids, "keep"].map((id) => savedItem(id)));

        await store.removeSavedItems(ids);

        expect((await store.listSavedItems()).map((i) => i.postId)).toEqual(["keep"]);
      });
    });
  });
}

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
import type {
  ConversationMeta,
  SavedItem,
  Storage,
  StoredTokens,
} from "../src/server/storage";
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
      const meta: ConversationMeta = {
        rootId: "1796000000000000001",
        rootAuthorHandle: "someone",
        rootText: "the root text",
        rootCreatedAt: "2024-05-01T00:00:00.000Z",
        fetchedAt: "2024-06-01T00:00:00.000Z",
        status: "complete",
        fullReadAt: "2024-06-01T00:00:00.000Z",
      };

      /** The row `meta` describes, as getConversationMeta hands it back. */
      function stored(overrides: Partial<ConversationMeta> = {}): Omit<ConversationMeta, "rootId"> {
        // Destructuring is how the key gets dropped; the binding is the cost.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { rootId: _rootId, ...rest } = { ...meta, ...overrides };
        return rest;
      }

      it("round-trips a conversation row", async () => {
        const store = await makeStore();
        await store.upsertConversation(meta);

        expect(await store.getConversationMeta(meta.rootId)).toEqual(stored());
        expect(await store.hasConversation(meta.rootId)).toBe(true);
      });

      it("answers null and false for a conversation it has never seen", async () => {
        const store = await makeStore();
        expect(await store.getConversationMeta(meta.rootId)).toBeNull();
        expect(await store.getConversationResponseSnapshot(meta.rootId)).toBeNull();
        expect(await store.hasConversation(meta.rootId)).toBe(false);
      });

      it("reads response status and ordered posts from one storage snapshot", async () => {
        const store = await makeStore();
        const root = makePost({ id: meta.rootId });
        const reply = makePost({
          conversationId: root.id,
          parentId: root.id,
          createdAt: new Date(Date.parse(root.createdAt) + 60_000).toISOString(),
        });
        await store.upsertConversation(meta);
        await store.upsertPosts([reply, root]);

        expect(await store.getConversationResponseSnapshot(meta.rootId)).toEqual({
          status: "complete",
          posts: [root, reply],
        });

        expect(
          await store.claimConversationRun(
            meta.rootId,
            "snapshot-run",
            "2024-06-02T00:00:00.000Z",
            5000,
            1000,
            false,
          ),
        ).not.toBeNull();
        expect(await store.getConversationResponseSnapshot(meta.rootId)).toEqual({
          status: "partial",
          posts: [root, reply],
        });
      });

      it("returns an empty post snapshot for a lifecycle row with no posts", async () => {
        const store = await makeStore();
        await store.upsertConversation(meta);

        expect(await store.getConversationResponseSnapshot(meta.rootId)).toEqual({
          status: "complete",
          posts: [],
        });
      });

      /**
       * The lifecycle fields are what a later run rewrites; the root's
       * identity is not. Re-fetching must not overwrite the root's text or
       * author with whatever the caller happened to pass.
       */
      it("updates the lifecycle fields on conflict, never the root", async () => {
        const store = await makeStore();
        await store.upsertConversation(meta);

        await store.upsertConversation({
          ...meta,
          rootAuthorHandle: "impostor",
          rootText: "clobbered",
          rootCreatedAt: "1999-01-01T00:00:00.000Z",
          fetchedAt: "2024-06-02T00:00:00.000Z",
          status: "partial",
          fullReadAt: "2024-06-02T00:00:00.000Z",
        });

        expect(await store.getConversationMeta(meta.rootId)).toEqual(
          stored({
            fetchedAt: "2024-06-02T00:00:00.000Z",
            status: "partial",
            fullReadAt: "2024-06-02T00:00:00.000Z",
          }),
        );
      });

      /**
       * A run that isn't a full read says so by writing null, and that must
       * not erase when the last full read was — the refresh fork spends money
       * on that answer.
       */
      it("a null fullReadAt leaves the recorded full read standing", async () => {
        const store = await makeStore();
        await store.upsertConversation(meta);

        await store.upsertConversation({
          ...meta,
          fetchedAt: "2024-06-05T00:00:00.000Z",
          fullReadAt: null,
        });

        expect(await store.getConversationMeta(meta.rootId)).toEqual(
          stored({ fetchedAt: "2024-06-05T00:00:00.000Z" }),
        );
      });

      describe("conversation run lease", () => {
        it("claims a new row as partial and rejects a second active owner", async () => {
          const store = await makeStore();

          expect(
            await store.claimConversationRun(
              meta.rootId,
              "run-a",
              "2024-06-01T00:00:00.000Z",
              5000,
              1000,
              false,
            ),
          ).toEqual({ prior: null });

          expect(await store.getConversationMeta(meta.rootId)).toEqual({
            rootAuthorHandle: "",
            rootText: "",
            rootCreatedAt: "",
            fetchedAt: "2024-06-01T00:00:00.000Z",
            status: "partial",
            fullReadAt: null,
          });
          expect(await store.hasConversation(meta.rootId)).toBe(true);
          expect(
            await store.claimConversationRun(
              meta.rootId,
              "run-b",
              "2024-06-01T00:00:01.000Z",
              6000,
              2000,
              false,
            ),
          ).toBeNull();
        });

        it("returns the coherent prior row and lets only its owner finish", async () => {
          const store = await makeStore();
          await store.upsertConversation(meta);
          expect(
            await store.claimConversationRun(
              meta.rootId,
              "run-a",
              "2024-06-02T00:00:00.000Z",
              5000,
              1000,
              false,
            ),
          ).toEqual({ prior: stored() });

          expect(await store.finishConversationRun("run-b", meta)).toBe(false);
          expect(
            await store.finishConversationRun("run-a", {
              ...meta,
              fetchedAt: "2024-06-02T00:00:00.000Z",
              status: "partial",
              fullReadAt: null,
            }),
          ).toBe(true);

          expect(await store.getConversationMeta(meta.rootId)).toEqual(
            stored({ fetchedAt: "2024-06-02T00:00:00.000Z", status: "partial" }),
          );
        });

        it("renews a live owner so the original expiry cannot be recovered", async () => {
          const store = await makeStore();
          await store.upsertConversation(meta);
          await store.claimConversationRun(
            meta.rootId,
            "run-a",
            "2024-06-02T00:00:00.000Z",
            5000,
            1000,
            false,
          );

          expect(await store.renewConversationRun(meta.rootId, "run-a", 15_000, false)).toBe(true);
          expect(
            await store.claimConversationRun(
              meta.rootId,
              "run-b",
              "2024-06-02T00:00:10.000Z",
              20_000,
              10_000,
              false,
            ),
          ).toBeNull();
          expect(
            await store.claimConversationRun(
              meta.rootId,
              "run-b",
              "2024-06-02T00:00:16.000Z",
              30_000,
              15_001,
              false,
            ),
          ).not.toBeNull();
        });

        it("preserves the original snapshot across recovery of a write-less owner", async () => {
          const store = await makeStore();
          await store.upsertConversation(meta);
          await store.claimConversationRun(
            meta.rootId,
            "run-a",
            "2024-06-02T00:00:00.000Z",
            5000,
            1000,
            false,
          );

          expect(
            await store.claimConversationRun(
              meta.rootId,
              "run-b",
              "2024-06-02T00:00:06.000Z",
              20_000,
              5001,
              false,
            ),
          ).toEqual({ prior: stored() });
          expect(await store.abortConversationRun(meta.rootId, "run-b")).toBe(true);
          expect(await store.abortConversationRun(meta.rootId, "run-a")).toBe(false);
          expect(await store.getConversationMeta(meta.rootId)).toEqual(stored());
        });

        it("keeps recovery partial once the expired owner may have written posts", async () => {
          const store = await makeStore();
          await store.upsertConversation(meta);
          await store.claimConversationRun(
            meta.rootId,
            "run-a",
            "2024-06-02T00:00:00.000Z",
            5000,
            1000,
            false,
          );
          expect(await store.renewConversationRun(meta.rootId, "run-a", 6000, true)).toBe(true);

          expect(
            await store.claimConversationRun(
              meta.rootId,
              "run-b",
              "2024-06-02T00:00:07.000Z",
              20_000,
              6001,
              false,
            ),
          ).toEqual({ prior: stored({ status: "partial" }) });
          expect(await store.abortConversationRun(meta.rootId, "run-b")).toBe(true);
          expect(await store.getConversationMeta(meta.rootId)).toEqual(stored({ status: "partial" }));
        });

        it("keeps an active run safe from an unleased administrative write", async () => {
          const store = await makeStore();
          await store.upsertConversation(meta);
          await store.claimConversationRun(
            meta.rootId,
            "run-a",
            "2024-06-02T00:00:00.000Z",
            5000,
            1000,
            false,
          );

          await store.upsertConversation({
            ...meta,
            fetchedAt: "2030-01-01T00:00:00.000Z",
            status: "complete",
          });

          expect(await store.getConversationMeta(meta.rootId)).toEqual(
            stored({ status: "partial" }),
          );
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

      /**
       * The resume boundary, and the same numeric-order problem in the other
       * direction: "12" is older than "99", which is older than "100".
       */
      it("oldestReplyId orders by length, then lexically", async () => {
        const store = await makeStore();
        const conversationId = "1796000000000000000";
        const at = "2024-06-01T00:00:00.000Z";
        for (const id of ["99", "100", "12"]) {
          await store.upsertPosts([makePost({ id, createdAt: at, conversationId })]);
        }

        expect(await store.oldestReplyId(conversationId)).toBe("12");
      });

      /**
       * The root is the oldest post in any conversation, so it can never be
       * the boundary: an `until_id` search bounded there returns nothing, and
       * a run would read that as having reached the end of the history.
       */
      it("oldestReplyId skips the root, and is null when only the root is held", async () => {
        const store = await makeStore();
        const root = makePost({ createdAt: "2024-06-01T00:00:00.000Z" });
        await store.upsertPosts([root]);

        expect(await store.oldestReplyId(root.id)).toBeNull();

        const reply = makePost({
          conversationId: root.id,
          parentId: root.id,
          createdAt: "2024-06-01T00:01:00.000Z",
        });
        await store.upsertPosts([reply]);

        expect(await store.oldestReplyId(root.id)).toBe(reply.id);
      });

      it("oldestReplyId is null for an unknown conversation", async () => {
        const store = await makeStore();
        expect(await store.oldestReplyId("1796000000000000000")).toBeNull();
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

      /** What a freshly written grant reads back as: ready, unleased, whole. */
      function readyRow(overrides: Partial<StoredTokens> = {}): StoredTokens {
        return {
          ...tokens,
          userId: null,
          username: null,
          displayName: null,
          state: "ready",
          leaseId: null,
          leaseUntil: null,
          recoveryUsed: false,
          brokenReason: null,
          ...overrides,
        };
      }

      it("round-trips a token row with a cached user ID", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", { ...tokens, userId: "42" });

        expect(await store.getOAuthTokens("self")).toEqual(readyRow({ userId: "42" }));
      });

      it("round-trips a token row with no user ID yet", async () => {
        const store = await makeStore();
        expect(await store.claimFreshOAuthInstall("self", "callback-a", 5000, 1000)).toBe(true);
        expect(await store.claimFreshOAuthInstall("self", "callback-b", 5000, 1000)).toBe(false);
        expect(
          await store.finishFreshOAuthInstall("self", "callback-a", { ...tokens, userId: null }),
        ).toBe(true);

        expect(await store.getOAuthTokens("self")).toEqual(readyRow());
      });

      it("stores an absent userId as null", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", tokens);

        expect(await store.getOAuthTokens("self")).toEqual(readyRow());
      });

      it("lazily creates one durable account generation and rotates it on a fresh grant", async () => {
        const store = await makeStore();
        const initial = await store.getOrCreateAccountGeneration("self", "generation-initial");
        expect(initial).toBe("generation-initial");
        expect(await store.getOrCreateAccountGeneration("self", "generation-loser")).toBe(initial);

        await store.putOAuthTokens("self", tokens);
        const connected = await store.getOrCreateAccountGeneration("self", "generation-unused");
        expect(connected).toBeString();
        expect(connected).not.toBe(initial);
      });

      it("reads the account generation and OAuth row from one storage snapshot", async () => {
        const store = await makeStore();
        expect(await store.getOAuthStatusSnapshot("self", "generation-empty")).toEqual({
          accountGeneration: "generation-empty",
          tokens: null,
        });

        await store.putOAuthTokens("self", { ...tokens, userId: "42" });
        const connected = await store.getOAuthStatusSnapshot("self", "generation-loser");
        expect(connected.accountGeneration).not.toBe("generation-empty");
        expect(connected.tokens).toEqual(readyRow({ userId: "42" }));
      });

      it("rejects stale account generations in every account-bound storage guard", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", tokens);
        const currentGeneration = await store.getOrCreateAccountGeneration(
          "self",
          "generation-unused",
        );
        const staleGeneration = "generation-stale";
        expect(currentGeneration).not.toBe(staleGeneration);
        const saved = makePost({
          id: "saved-current-account",
          createdAt: "2024-01-01T00:00:00.000Z",
        });
        const stalePost = makePost({
          id: "must-not-land",
          createdAt: "2024-01-02T00:00:00.000Z",
        });
        await store.upsertPosts([saved]);
        await store.addSavedItems([savedItem(saved.id, { source: "bookmark" })]);
        await store.setBookmarkFolder("folder-current", "Current");

        expect(await store.getOAuthStatusForGeneration("self", staleGeneration)).toBeNull();
        expect(await store.getBookmarkFolderForGeneration(staleGeneration)).toBeNull();
        expect(await store.clearBookmarkFolder("remove", staleGeneration)).toBe(false);
        expect(
          await store.beginBookmarkSync(
            "folder-current",
            "stale-sync",
            5000,
            1000,
            staleGeneration,
          ),
        ).toBe(false);
        expect(
          await store.beginBookmarkFolderSwitch(
            "folder-current",
            "folder-next",
            "Next",
            "stale-switch",
            5000,
            1000,
            staleGeneration,
          ),
        ).toBe(false);
        expect(
          await store.claimUserProfileLease(
            "self",
            tokens.refreshToken,
            "stale-profile",
            5000,
            1000,
            staleGeneration,
          ),
        ).toBe(false);
        expect(
          await store.upsertPostsIfOAuthGrantCurrent(
            "self",
            tokens.refreshToken,
            [stalePost],
            1,
            staleGeneration,
          ),
        ).toBe(false);
        expect(
          await store.claimOAuthDisconnect(
            "self",
            tokens.refreshToken,
            "stale-disconnect",
            5000,
            1000,
            staleGeneration,
          ),
        ).toBe(false);

        expect(await store.getOAuthTokens("self")).toEqual(readyRow());
        expect(await store.getBookmarkFolder()).toEqual({
          id: "folder-current",
          name: "Current",
        });
        expect(await store.listSavedItems()).toEqual([
          savedItem(saved.id, { source: "bookmark" }),
        ]);
        expect(await store.getPost(stalePost.id)).toBeNull();

        const noGrant = await makeStore();
        const noGrantGeneration = await noGrant.getOrCreateAccountGeneration(
          "self",
          "generation-current",
        );
        expect(
          await noGrant.claimFreshOAuthInstall(
            "self",
            "stale-callback",
            5000,
            1000,
            staleGeneration,
          ),
        ).toBe(false);
        expect(await noGrant.finishOAuthDisconnectWithoutGrant("remove", staleGeneration)).toBeNull();
        expect(await noGrant.getOrCreateAccountGeneration("self", "generation-loser")).toBe(
          noGrantGeneration,
        );

        const reauthorization = await makeStore();
        await reauthorization.putOAuthTokens("self", { ...tokens, userId: "account" });
        expect(
          await reauthorization.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "stale-callback",
            5000,
            1000,
            staleGeneration,
          ),
        ).toBe(false);
        expect(await reauthorization.getOAuthTokens("self")).toMatchObject({
          refreshToken: tokens.refreshToken,
          state: "ready",
        });
      });

      it("round-trips the cached profile", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", {
          ...tokens,
          userId: "42",
          username: "someone",
          displayName: "Some One",
        });

        expect(await store.getOAuthTokens("self")).toEqual(
          readyRow({ userId: "42", username: "someone", displayName: "Some One" }),
        );
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

      it("does not attach orphaned account bookmarks to a fresh grant", async () => {
        const store = await makeStore();
        await store.setBookmarkFolder("orphan-folder", "Old account");
        await store.addSavedItems([
          savedItem("orphan", { source: "bookmark" }),
          savedItem("manual", { source: "manual" }),
        ]);

        await store.putOAuthTokens("self", { ...tokens, userId: null });

        expect(await store.getBookmarkFolder()).toEqual({ id: null, name: null });
        expect(
          (await store.listSavedItems())
            .map(({ postId, source }) => ({ postId, source }))
            .sort((a, b) => a.postId.localeCompare(b.postId)),
        ).toEqual([
          { postId: "manual", source: "manual" },
          { postId: "orphan", source: "manual" },
        ]);
        expect(
          await store.finishFreshOAuthInstall("self", "callback-b", {
            ...tokens,
            accessToken: "racing-access",
            refreshToken: "racing-refresh",
          }),
        ).toBe(false);
        expect((await store.getOAuthTokens("self"))?.refreshToken).toBe(tokens.refreshToken);
      });

      it("recovers an expired first-callback lease and fences its stale holder", async () => {
        const store = await makeStore();
        expect(await store.claimFreshOAuthInstall("self", "callback-old", 2000, 1000)).toBe(true);
        expect(await store.claimFreshOAuthInstall("self", "callback-new", 5000, 2000)).toBe(true);
        expect(
          await store.finishFreshOAuthInstall("self", "callback-old", {
            ...tokens,
            refreshToken: "stale",
          }),
        ).toBe(false);
        expect(
          await store.finishFreshOAuthInstall("self", "callback-new", {
            ...tokens,
            refreshToken: "current",
          }),
        ).toBe(true);
        expect((await store.getOAuthTokens("self"))?.refreshToken).toBe("current");
      });

      it("installs a same-account reauthorization only against the observed grant", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", {
          ...tokens,
          userId: "42",
          username: "someone",
          displayName: "Some One",
        });
        await store.setBookmarkFolder("folder1", "Reading");
        await store.addSavedItems([savedItem("bookmark", { source: "bookmark" })]);
        const accountGeneration = await store.getOrCreateAccountGeneration(
          "self",
          "generation-unused",
        );

        expect(
          await store.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback",
            5000,
            1000,
          ),
        ).toBe(true);
        expect(await store.getOAuthTokens("self")).toMatchObject({
          state: "reauthorizing",
          leaseId: "callback",
        });
        expect(
          await store.probeOAuthReauthorizationPromotion(
            "self",
            tokens.refreshToken,
            "refresh-new",
            "callback",
          ),
        ).toBe("owned-pending");
        expect(await store.isOAuthGrantCurrent("self", tokens.refreshToken)).toBe(false);

        expect(
          await store.replaceOAuthTokensIfCurrent(
            "self",
            tokens.refreshToken,
            {
              accessToken: "access-new",
              refreshToken: "refresh-new",
              expiresAt: 1_770_000_000_000,
              scope: tokens.scope,
              userId: "42",
              username: "someone-new",
              displayName: "Some One",
            },
            "callback",
          ),
        ).toBe(true);
        expect(await store.getOAuthTokens("self")).toMatchObject({
          accessToken: "access-new",
          refreshToken: "refresh-new",
          userId: "42",
          username: "someone-new",
        });
        expect(
          await store.probeOAuthReauthorizationPromotion(
            "self",
            tokens.refreshToken,
            "refresh-new",
            "callback",
          ),
        ).toBe("promoted");
        expect(
          await store.probeOAuthReauthorizationPromotion(
            "self",
            tokens.refreshToken,
            "unrelated",
            "callback",
          ),
        ).toBe("superseded");
        expect(await store.getBookmarkFolder()).toEqual({ id: "folder1", name: "Reading" });
        expect((await store.listSavedItems()).map((item) => item.postId)).toEqual(["bookmark"]);
        expect(await store.getOrCreateAccountGeneration("self", "generation-loser")).toBe(
          accountGeneration,
        );

        expect(
          await store.replaceOAuthTokensIfCurrent("self", tokens.refreshToken, {
            accessToken: "stale",
            refreshToken: "stale",
            expiresAt: 1_780_000_000_000,
            scope: tokens.scope,
            userId: "42",
          }),
        ).toBe(false);
        expect((await store.getOAuthTokens("self"))?.refreshToken).toBe("refresh-new");
      });

      it("single-flights reauthorization exchange and binds install to its callback owner", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", { ...tokens, userId: "42" });
        expect(
          await store.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback-a",
            5000,
            1000,
          ),
        ).toBe(true);
        expect(await store.getOAuthTokens("self")).toMatchObject({
          state: "reauthorizing",
          leaseId: "callback-a",
        });
        expect(await store.isOAuthGrantCurrent("self", tokens.refreshToken)).toBe(false);
        expect(
          await store.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback-b",
            5000,
            1000,
          ),
        ).toBe(false);
        const replacement = {
          ...tokens,
          accessToken: "access-new",
          refreshToken: "refresh-new",
          userId: "42",
        };
        expect(
          await store.replaceOAuthTokensIfCurrent(
            "self",
            tokens.refreshToken,
            replacement,
            "callback-b",
          ),
        ).toBe(false);
        expect(
          await store.replaceOAuthTokensIfCurrent(
            "self",
            tokens.refreshToken,
            replacement,
            "callback-a",
          ),
        ).toBe(true);
        expect((await store.getOAuthTokens("self"))?.refreshToken).toBe("refresh-new");
      });

      it("serializes reauthorization callbacks with token refresh ownership", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", { ...tokens, userId: "42" });

        expect(
          await store.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback-a",
            5000,
            1000,
          ),
        ).toBe(true);
        expect(
          await store.claimTokenLease("self", tokens.refreshToken, "refresh-a", 5000, 1000),
        ).toBe(false);
        expect(
          await store.restoreOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback-a",
          ),
        ).toBe(true);
        expect(
          await store.claimTokenLease("self", tokens.refreshToken, "refresh-a", 5000, 1000),
        ).toBe(true);

        await store.releaseTokenLease("self", "refresh-a", tokens.refreshToken);
        expect(
          await store.claimTokenLease("self", tokens.refreshToken, "refresh-b", 5000),
        ).toBe(true);
        expect(
          await store.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback-b",
            5000,
            1000,
          ),
        ).toBe(false);

        await store.releaseTokenLease("self", "refresh-b", tokens.refreshToken);
        expect(
          await store.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "expired-callback-a",
            2000,
            1000,
          ),
        ).toBe(true);
        expect(
          await store.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "expired-callback-b",
            5000,
            2000,
          ),
        ).toBe(true);
        expect(
          await store.replaceOAuthTokensIfCurrent(
            "self",
            tokens.refreshToken,
            {
              ...tokens,
              accessToken: "stale-callback",
              refreshToken: "stale-callback",
              userId: "42",
            },
            "expired-callback-a",
          ),
        ).toBe(false);
        expect(
          await store.replaceOAuthTokensIfCurrent(
            "self",
            tokens.refreshToken,
            {
              ...tokens,
              accessToken: "recovered-callback",
              refreshToken: "recovered-callback",
              userId: "42",
            },
            "expired-callback-b",
          ),
        ).toBe(true);
        expect((await store.getOAuthTokens("self"))?.refreshToken).toBe("recovered-callback");
      });

      it("settles an ambiguous callback as pending and only restores pending on refusal", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", { ...tokens, userId: "42" });

        expect(
          await store.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback-a",
            5000,
            1000,
          ),
        ).toBe(true);
        expect(
          await store.settleOAuthReauthorizationPending(
            "self",
            tokens.refreshToken,
            "callback-a",
            "replacement outcome unknown",
          ),
        ).toBe(true);
        expect(await store.getOAuthTokens("self")).toMatchObject({
          state: "reauthorizing",
          leaseId: null,
          leaseUntil: null,
          brokenReason: "replacement outcome unknown",
        });
        expect(await store.isOAuthGrantCurrent("self", tokens.refreshToken)).toBe(false);
        expect(
          await store.claimTokenLease("self", tokens.refreshToken, "refresh", 9000, 8000),
        ).toBe(false);

        expect(
          await store.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback-b",
            9000,
            8000,
          ),
        ).toBe(true);
        expect(
          await store.restoreOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback-b",
          ),
        ).toBe(true);
        expect(await store.getOAuthTokens("self")).toMatchObject({
          state: "reauthorizing",
          leaseId: null,
          brokenReason: "replacement outcome unknown",
        });
        expect(
          await store.claimOAuthDisconnect(
            "self",
            tokens.refreshToken,
            "disconnect",
            11_000,
            10_000,
          ),
        ).toBe(true);
        expect(
          await store.releaseOAuthDisconnect("self", tokens.refreshToken, "disconnect"),
        ).toBe(true);
        expect(await store.getOAuthTokens("self")).toMatchObject({
          state: "broken",
          brokenReason: "replacement outcome unknown",
        });
      });

      it("leases terminal disconnect and keeps imported bookmarks as manual saves", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", { ...tokens, userId: "42" });
        await store.setBookmarkFolder("folder1", "Reading");
        await store.addSavedItems([
          savedItem("bookmark", { source: "bookmark" }),
          savedItem("manual", { source: "manual" }),
        ]);
        const connectedGeneration = await store.getOrCreateAccountGeneration(
          "self",
          "generation-unused",
        );

        expect(
          await store.claimOAuthDisconnect("self", tokens.refreshToken, "disconnect-a", 5000, 1000),
        ).toBe(true);
        expect(
          await store.claimOAuthDisconnect("self", tokens.refreshToken, "disconnect-b", 6000, 2000),
        ).toBe(false);
        expect(
          await store.finishOAuthDisconnect("self", tokens.refreshToken, "wrong", "keep"),
        ).toBeNull();
        const accountGeneration = await store.finishOAuthDisconnect(
          "self",
          tokens.refreshToken,
          "disconnect-a",
          "keep",
        );
        expect(accountGeneration).toBeString();
        expect(accountGeneration).not.toBe(connectedGeneration);
        expect(await store.getOrCreateAccountGeneration("self", "generation-loser")).toBe(
          accountGeneration!,
        );

        expect(await store.getOAuthTokens("self")).toBeNull();
        expect(await store.getBookmarkFolder()).toEqual({ id: null, name: null });
        expect(
          (await store.listSavedItems()).map(({ postId, source }) => ({ postId, source })),
        ).toEqual([
          { postId: "bookmark", source: "manual" },
          { postId: "manual", source: "manual" },
        ]);
      });

      it("rotates generation while terminally cleaning orphan account rows", async () => {
        const store = await makeStore();
        const before = await store.getOrCreateAccountGeneration("self", "generation-before");
        await store.setBookmarkFolder("orphan", "Old account");
        await store.addSavedItems([savedItem("bookmark", { source: "bookmark" })]);

        const after = await store.finishOAuthDisconnectWithoutGrant("keep");

        expect(after).toBeString();
        expect(after).not.toBe(before);
        expect(await store.getOrCreateAccountGeneration("self", "generation-loser")).toBe(after!);
        expect(await store.getBookmarkFolder()).toEqual({ id: null, name: null });
        expect(await store.listSavedItems()).toEqual([
          savedItem("bookmark", { source: "manual" }),
        ]);
      });

      it("releases a failed disconnect, recovers expiry, and fences the stale owner", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", { ...tokens, userId: "42" });

        expect(
          await store.claimOAuthDisconnect("self", tokens.refreshToken, "disconnect-a", 2000, 1000),
        ).toBe(true);
        expect(
          await store.releaseOAuthDisconnect("self", tokens.refreshToken, "disconnect-a"),
        ).toBe(true);
        expect((await store.getOAuthTokens("self"))?.state).toBe("ready");

        expect(
          await store.claimOAuthDisconnect("self", tokens.refreshToken, "disconnect-old", 3000, 2000),
        ).toBe(true);
        expect(
          await store.claimOAuthDisconnect("self", tokens.refreshToken, "disconnect-new", 5000, 3000),
        ).toBe(true);
        expect(
          await store.finishOAuthDisconnect(
            "self",
            tokens.refreshToken,
            "disconnect-old",
            "remove",
          ),
        ).toBeNull();
        expect(
          await store.finishOAuthDisconnect(
            "self",
            tokens.refreshToken,
            "disconnect-new",
            "remove",
          ),
        ).toBeString();
      });

      it("does not let a disconnecting grant start a late profile resolution", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", tokens);

        expect(
          await store.claimOAuthDisconnect("self", tokens.refreshToken, "disconnect", 5000, 1000),
        ).toBe(true);
        expect(
          await store.claimUserProfileLease(
            "self",
            tokens.refreshToken,
            "late-profile",
            5000,
            1000,
          ),
        ).toBe(false);
        expect(
          await store.putUserProfile("self", tokens.refreshToken, {
            userId: "42",
            username: "someone",
            displayName: "Some One",
          }),
        ).toBe(false);
      });

      it("does not let a folder clear override an owned disconnect disposition", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", tokens);
        await store.setBookmarkFolder("folder-a", "Reading");
        await store.addSavedItems([savedItem("bookmark", { source: "bookmark" })]);

        expect(
          await store.claimOAuthDisconnect("self", tokens.refreshToken, "disconnect", 5000, 1000),
        ).toBe(true);
        expect(await store.clearBookmarkFolder("keep")).toBe(false);
        expect(await store.getBookmarkFolder()).toEqual({ id: "folder-a", name: "Reading" });
        expect(await store.listSavedItems()).toEqual([
          savedItem("bookmark", { source: "bookmark" }),
        ]);

        expect(
          await store.finishOAuthDisconnect(
            "self",
            tokens.refreshToken,
            "disconnect",
            "remove",
          ),
        ).toBeString();
        expect(await store.listSavedItems()).toEqual([]);
      });

      it("does not let disconnect or folder clear steal an active OAuth callback", async () => {
        const now = Date.now();
        const freshStore = await makeStore();
        expect(
          await freshStore.claimFreshOAuthInstall("self", "fresh", now + 5000, now),
        ).toBe(true);
        expect(await freshStore.clearBookmarkFolder("remove")).toBe(false);

        const reconnectStore = await makeStore();
        await reconnectStore.putOAuthTokens("self", { ...tokens, userId: "42" });
        expect(
          await reconnectStore.claimOAuthReauthorization(
            "self",
            tokens.refreshToken,
            "callback",
            now + 5000,
            now,
          ),
        ).toBe(true);
        expect(
          await reconnectStore.claimOAuthDisconnect(
            "self",
            tokens.refreshToken,
            "disconnect",
            now + 6000,
            now + 1000,
          ),
        ).toBe(false);
        expect(
          await reconnectStore.settleOAuthReauthorizationPending(
            "self",
            tokens.refreshToken,
            "callback",
            "provider outcome unknown",
          ),
        ).toBe(true);
        expect(
          await reconnectStore.claimOAuthDisconnect(
            "self",
            tokens.refreshToken,
            "disconnect",
            now + 6000,
            now + 1000,
          ),
        ).toBe(true);
      });

      it("invalidates an expired first callback before clear or Disconnect succeeds", async () => {
        const now = Date.now();
        const disconnectStore = await makeStore();
        expect(
          await disconnectStore.claimFreshOAuthInstall("self", "stale-disconnect", now, now - 1),
        ).toBe(true);
        expect(await disconnectStore.finishOAuthDisconnectWithoutGrant("keep")).toBeString();
        expect(
          await disconnectStore.finishFreshOAuthInstall("self", "stale-disconnect", {
            ...tokens,
            refreshToken: "must-not-return",
          }),
        ).toBe(false);
        expect(await disconnectStore.getOAuthTokens("self")).toBeNull();

        const clearStore = await makeStore();
        expect(
          await clearStore.claimFreshOAuthInstall("self", "stale-clear", now, now - 1),
        ).toBe(true);
        expect(await clearStore.clearBookmarkFolder("remove")).toBe(true);
        expect(
          await clearStore.finishFreshOAuthInstall("self", "stale-clear", {
            ...tokens,
            refreshToken: "must-not-return",
          }),
        ).toBe(false);
        expect(await clearStore.getOAuthTokens("self")).toBeNull();
      });

      it("writes the profile without touching the token pair or the lease", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", tokens);
        await store.claimTokenLease("self", tokens.refreshToken, "lease-a", 5000);

        expect(
          await store.putUserProfile("self", tokens.refreshToken, {
            userId: "42",
            username: "someone",
            displayName: "Some One",
          }),
        ).toBe(true);

        expect(await store.getOAuthTokens("self")).toEqual(
          readyRow({
            userId: "42",
            username: "someone",
            displayName: "Some One",
            state: "refreshing",
            leaseId: "lease-a",
            leaseUntil: 5000,
          }),
        );
      });

      it("refuses to write a profile after a fresh grant replaced the observed one", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", tokens);
        await store.putOAuthTokens("self", {
          ...tokens,
          accessToken: "access-b",
          refreshToken: "refresh-b",
        });

        expect(
          await store.putUserProfile("self", tokens.refreshToken, {
            userId: "user-a",
            username: "account-a",
            displayName: "Account A",
          }),
        ).toBe(false);
        expect(await store.getOAuthTokens("self")).toEqual(
          readyRow({ accessToken: "access-b", refreshToken: "refresh-b" }),
        );
      });

      describe("first-profile lease", () => {
        const profile = {
          userId: "42",
          username: "someone",
          displayName: "Some One",
        };

        it("elects one owner and lets only that owner atomically cache the profile", async () => {
          const store = await makeStore();
          await store.putOAuthTokens("self", tokens);

          const claims = await Promise.all([
            store.claimUserProfileLease("self", tokens.refreshToken, "lease-a", 5000, 1000),
            store.claimUserProfileLease("self", tokens.refreshToken, "lease-b", 5000, 1000),
          ]);
          expect([...claims].sort()).toEqual([false, true]);
          const winner = claims[0] ? "lease-a" : "lease-b";
          const loser = claims[0] ? "lease-b" : "lease-a";

          expect(
            await store.finishUserProfileLease("self", tokens.refreshToken, loser, {
              userId: "wrong",
              username: "wrong",
              displayName: "Wrong",
            }),
          ).toBe(false);
          expect(await store.finishUserProfileLease("self", tokens.refreshToken, winner, profile)).toBe(
            true,
          );
          expect(await store.getOAuthTokens("self")).toEqual(readyRow(profile));
          expect(
            await store.claimUserProfileLease("self", tokens.refreshToken, "lease-c", 6000, 2000),
          ).toBe(false);
        });

        it("releases a failed owner's lease without touching its grant", async () => {
          const store = await makeStore();
          await store.putOAuthTokens("self", tokens);
          expect(
            await store.claimUserProfileLease("self", tokens.refreshToken, "lease-a", 5000, 1000),
          ).toBe(true);

          expect(
            await store.releaseUserProfileLease("self", tokens.refreshToken, "lease-wrong"),
          ).toBe(false);
          expect(
            await store.claimUserProfileLease("self", tokens.refreshToken, "lease-b", 6000, 2000),
          ).toBe(false);
          expect(
            await store.releaseUserProfileLease("self", tokens.refreshToken, "lease-a"),
          ).toBe(true);
          expect(await store.getOAuthTokens("self")).toEqual(readyRow());
          expect(
            await store.claimUserProfileLease("self", tokens.refreshToken, "lease-b", 6000, 2000),
          ).toBe(true);
        });

        it("recovers an expired holder and fences that holder's late result", async () => {
          const store = await makeStore();
          await store.putOAuthTokens("self", tokens);
          expect(
            await store.claimUserProfileLease("self", tokens.refreshToken, "lease-old", 5000, 1000),
          ).toBe(true);
          expect(
            await store.claimUserProfileLease("self", tokens.refreshToken, "lease-new", 9000, 4999),
          ).toBe(false);
          expect(
            await store.claimUserProfileLease("self", tokens.refreshToken, "lease-new", 9000, 5000),
          ).toBe(true);

          expect(
            await store.finishUserProfileLease("self", tokens.refreshToken, "lease-old", {
              userId: "stale",
              username: "stale",
              displayName: "Stale",
            }),
          ).toBe(false);
          expect(
            await store.releaseUserProfileLease("self", tokens.refreshToken, "lease-old"),
          ).toBe(false);
          expect(
            await store.finishUserProfileLease(
              "self",
              tokens.refreshToken,
              "lease-new",
              profile,
            ),
          ).toBe(true);
          expect(await store.getOAuthTokens("self")).toEqual(readyRow(profile));
        });

        it("invalidates a stale holder when a fresh login replaces the grant", async () => {
          const store = await makeStore();
          await store.putOAuthTokens("self", tokens);
          expect(
            await store.claimUserProfileLease("self", tokens.refreshToken, "lease-a", 5000, 1000),
          ).toBe(true);

          const replacement = {
            ...tokens,
            accessToken: "access-b",
            refreshToken: "refresh-b",
          };
          await store.putOAuthTokens("self", replacement);
          expect(
            await store.finishUserProfileLease("self", tokens.refreshToken, "lease-a", {
              userId: "account-a",
              username: "account-a",
              displayName: "Account A",
            }),
          ).toBe(false);
          expect(
            await store.claimUserProfileLease(
              "self",
              replacement.refreshToken,
              "lease-b",
              6000,
              2000,
            ),
          ).toBe(true);
          expect(
            await store.finishUserProfileLease(
              "self",
              replacement.refreshToken,
              "lease-b",
              profile,
            ),
          ).toBe(true);
          expect(await store.getOAuthTokens("self")).toEqual(
            readyRow({ ...replacement, ...profile }),
          );
        });

        it("lets a rotated grant replace the old grant's active profile lease", async () => {
          const store = await makeStore();
          await store.putOAuthTokens("self", tokens);
          expect(
            await store.claimUserProfileLease("self", tokens.refreshToken, "profile-old", 5000, 1000),
          ).toBe(true);
          expect(await store.claimTokenLease("self", tokens.refreshToken, "token-lease", 5000)).toBe(
            true,
          );
          const rotated = {
            ...tokens,
            accessToken: "access-rotated",
            refreshToken: "refresh-rotated",
          };
          expect(
            await store.finalizeTokenLease("self", "token-lease", tokens.refreshToken, rotated),
          ).toBe(true);

          expect(
            await store.claimUserProfileLease(
              "self",
              rotated.refreshToken,
              "profile-new",
              6000,
              2000,
            ),
          ).toBe(true);
          expect(
            await store.finishUserProfileLease(
              "self",
              tokens.refreshToken,
              "profile-old",
              {
                userId: "stale",
                username: "stale",
                displayName: "Stale",
              },
            ),
          ).toBe(false);
          expect(
            await store.finishUserProfileLease(
              "self",
              rotated.refreshToken,
              "profile-new",
              profile,
            ),
          ).toBe(true);
          expect(await store.getOAuthTokens("self")).toEqual(
            readyRow({ ...rotated, ...profile }),
          );
        });

        it("does not let refresh finalization erase a profile that landed after its snapshot", async () => {
          const store = await makeStore();
          await store.putOAuthTokens("self", tokens);
          // The refresher observed the null profile before either lease began.
          const refreshSnapshot = { ...tokens };
          expect(await store.claimTokenLease("self", tokens.refreshToken, "token-lease", 5000)).toBe(
            true,
          );
          expect(
            await store.claimUserProfileLease(
              "self",
              tokens.refreshToken,
              "profile-lease",
              5000,
              1000,
            ),
          ).toBe(true);
          expect(
            await store.finishUserProfileLease(
              "self",
              tokens.refreshToken,
              "profile-lease",
              profile,
            ),
          ).toBe(true);

          const rotated = {
            ...refreshSnapshot,
            accessToken: "access-rotated",
            refreshToken: "refresh-rotated",
          };
          expect(
            await store.finalizeTokenLease("self", "token-lease", tokens.refreshToken, rotated),
          ).toBe(true);
          expect(await store.getOAuthTokens("self")).toEqual(
            readyRow({ ...rotated, ...profile }),
          );
        });
      });
    });

    /**
     * The lease protocol's conditional writes. Each one is a single UPDATE
     * whose WHERE clause is the whole coordination mechanism, so what matters
     * here is exactly which rows it refuses to touch (2026-07-30 review, C4).
     */
    describe("oauth token lease", () => {
      const tokens = {
        accessToken: "access-0",
        refreshToken: "refresh-0",
        expiresAt: 1_760_000_000_000,
        scope: "tweet.read users.read",
        userId: "42",
        username: "someone",
        displayName: "Some One",
      };

      const rotated = {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 1_770_000_000_000,
        scope: "tweet.read users.read",
        userId: "42",
        username: "someone",
        displayName: "Some One",
      };

      async function seeded(): Promise<Storage> {
        const store = await makeStore();
        await store.putOAuthTokens("self", tokens);
        return store;
      }

      it("claims a ready row that still holds the observed token", async () => {
        const store = await seeded();

        expect(await store.claimTokenLease("self", "refresh-0", "lease-a", 5000)).toBe(true);

        expect(await store.getOAuthTokens("self")).toMatchObject({
          state: "refreshing",
          leaseId: "lease-a",
          leaseUntil: 5000,
          refreshToken: "refresh-0",
          recoveryUsed: false,
        });
      });

      it("refuses a claim once the observed token has rotated under it", async () => {
        const store = await seeded();

        expect(await store.claimTokenLease("self", "refresh-stale", "lease-a", 5000)).toBe(false);

        expect(await store.getOAuthTokens("self")).toMatchObject({ state: "ready", leaseId: null });
      });

      it("lets exactly one of two claims win", async () => {
        const store = await seeded();

        expect(await store.claimTokenLease("self", "refresh-0", "lease-a", 5000)).toBe(true);
        expect(await store.claimTokenLease("self", "refresh-0", "lease-b", 5000)).toBe(false);

        expect(await store.getOAuthTokens("self")).toMatchObject({ leaseId: "lease-a" });
      });

      it("finalizes with the held lease, clearing it and resetting recovery", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);

        expect(await store.finalizeTokenLease("self", "lease-a", "refresh-0", rotated)).toBe(true);

        expect(await store.getOAuthTokens("self")).toEqual({
          ...rotated,
          state: "ready",
          leaseId: null,
          leaseUntil: null,
          recoveryUsed: false,
          brokenReason: null,
        });
      });

      it("writes nothing when the lease was stolen", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);
        await store.claimRecoveryLease("self", "refresh-0", "lease-b", 20_000, 9000);

        expect(await store.finalizeTokenLease("self", "lease-a", "refresh-0", rotated)).toBe(false);

        expect(await store.getOAuthTokens("self")).toMatchObject({
          accessToken: "access-0",
          refreshToken: "refresh-0",
          state: "refreshing",
          leaseId: "lease-b",
        });
      });

      it("writes nothing when the observed token changed under the lease", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);
        await store.putOAuthTokens("self", { ...tokens, refreshToken: "refresh-elsewhere" });

        expect(await store.finalizeTokenLease("self", "lease-a", "refresh-0", rotated)).toBe(false);

        expect(await store.getOAuthTokens("self")).toMatchObject({
          refreshToken: "refresh-elsewhere",
          state: "ready",
        });
      });

      it("releases a lease it holds, leaving the token pair alone", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);

        expect(await store.releaseTokenLease("self", "lease-a", "refresh-0")).toBe(true);

        expect(await store.getOAuthTokens("self")).toEqual({
          ...tokens,
          state: "ready",
          leaseId: null,
          leaseUntil: null,
          recoveryUsed: false,
          brokenReason: null,
        });
      });

      it("refuses to release a lease it does not hold", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);

        expect(await store.releaseTokenLease("self", "lease-b", "refresh-0")).toBe(false);

        expect(await store.getOAuthTokens("self")).toMatchObject({ leaseId: "lease-a" });
      });

      it("recovers only an expired lease, and only once", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);

        // Still inside the lease: the holder may yet finalize.
        expect(await store.claimRecoveryLease("self", "refresh-0", "lease-b", 20_000, 4999)).toBe(
          false,
        );
        expect(await store.claimRecoveryLease("self", "refresh-0", "lease-b", 20_000, 9000)).toBe(
          true,
        );
        expect(await store.getOAuthTokens("self")).toMatchObject({
          state: "refreshing",
          leaseId: "lease-b",
          leaseUntil: 20_000,
          recoveryUsed: true,
        });

        // A second crash gets no second recovery.
        expect(await store.claimRecoveryLease("self", "refresh-0", "lease-c", 40_000, 30_000)).toBe(
          false,
        );
        expect(await store.getOAuthTokens("self")).toMatchObject({ leaseId: "lease-b" });
      });

      it("refuses recovery when the observed token moved on", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);

        expect(
          await store.claimRecoveryLease("self", "refresh-stale", "lease-b", 20_000, 9000),
        ).toBe(false);
      });

      it("finalizing after a recovery clears the recovery flag", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);
        await store.claimRecoveryLease("self", "refresh-0", "lease-b", 20_000, 9000);

        expect(await store.finalizeTokenLease("self", "lease-b", "refresh-0", rotated)).toBe(true);

        expect(await store.getOAuthTokens("self")).toMatchObject({
          state: "ready",
          recoveryUsed: false,
          refreshToken: "refresh-1",
        });
      });

      it("marks the grant broken, bound to the observed token", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);

        expect(await store.markTokenBroken("self", "refresh-0", "invalid_grant")).toBe(true);

        expect(await store.getOAuthTokens("self")).toMatchObject({
          state: "broken",
          brokenReason: "invalid_grant",
          leaseId: null,
          leaseUntil: null,
        });
      });

      it("does not break a grant that has already moved on", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);
        await store.finalizeTokenLease("self", "lease-a", "refresh-0", rotated);

        expect(await store.markTokenBroken("self", "refresh-0", "invalid_grant")).toBe(false);

        expect(await store.getOAuthTokens("self")).toMatchObject({ state: "ready" });
      });

      it("a fresh grant clears broken and the recovery flag", async () => {
        const store = await seeded();
        await store.claimTokenLease("self", "refresh-0", "lease-a", 5000);
        await store.claimRecoveryLease("self", "refresh-0", "lease-b", 20_000, 9000);
        await store.markTokenBroken("self", "refresh-0", "invalid_grant");

        await store.putOAuthTokens("self", rotated);

        expect(await store.getOAuthTokens("self")).toEqual({
          ...rotated,
          state: "ready",
          leaseId: null,
          leaseUntil: null,
          recoveryUsed: false,
          brokenReason: null,
        });
      });

      it("leaves an unknown row alone rather than creating one", async () => {
        const store = await makeStore();

        expect(await store.claimTokenLease("self", "refresh-0", "lease-a", 5000)).toBe(false);
        expect(await store.markTokenBroken("self", "refresh-0", "invalid_grant")).toBe(false);
        expect(await store.getOAuthTokens("self")).toBeNull();
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

      it("stores the folder pair together and supersedes an older scan", async () => {
        const store = await makeStore();
        await store.setBookmarkFolder("folder1", "Reading");
        expect(await store.getBookmarkFolder()).toEqual({ id: "folder1", name: "Reading" });
        expect(await store.getSetting("bookmark_folder_id")).toBe("folder1");
        expect(await store.getSetting("bookmark_folder_name")).toBe("Reading");
        expect(await store.beginBookmarkSync("wrong-folder", "run-wrong", 5000, 1000)).toBe(false);
        expect(await store.beginBookmarkSync("folder1", "run-old", 5000, 1000)).toBe(true);

        await store.setBookmarkFolder("folder2", "Later");
        expect(
          await store.finishBookmarkSync(
            "folder1",
            "run-old",
            [makePost({ id: "old", createdAt: "2024-01-01T00:00:00.000Z" })],
            ["old"],
            true,
            "2024-01-01T00:00:00.000Z",
          ),
        ).toEqual({ applied: false, added: 0, removed: 0 });
        expect(await store.listSavedItems()).toEqual([]);
        expect(await store.getPost("old")).toBeNull();
        expect(await store.getSetting("bookmark_folder_id")).toBe("folder2");
        expect(await store.getSetting("bookmark_folder_name")).toBe("Later");
      });

      it("clears a selected folder without leaving bookmark-source orphans", async () => {
        const keepStore = await makeStore();
        await keepStore.setBookmarkFolder("folder1", "Reading");
        await keepStore.addSavedItems([
          savedItem("bookmark", { source: "bookmark" }),
          savedItem("manual", { source: "manual" }),
        ]);
        await keepStore.clearBookmarkFolder("keep");
        expect(await keepStore.getBookmarkFolder()).toEqual({ id: null, name: null });
        expect(
          (await keepStore.listSavedItems())
            .map(({ postId, source }) => ({ postId, source }))
            .sort((a, b) => a.postId.localeCompare(b.postId)),
        ).toEqual([
          { postId: "bookmark", source: "manual" },
          { postId: "manual", source: "manual" },
        ]);

        const removeStore = await makeStore();
        await removeStore.setBookmarkFolder("folder1", "Reading");
        await removeStore.addSavedItems([
          savedItem("bookmark", { source: "bookmark" }),
          savedItem("manual", { source: "manual" }),
        ]);
        await removeStore.clearBookmarkFolder("remove");
        expect(await removeStore.getBookmarkFolder()).toEqual({ id: null, name: null });
        expect(await removeStore.listSavedItems()).toEqual([savedItem("manual", { source: "manual" })]);
      });

      it("stages a replacement folder and atomically activates only its complete scan", async () => {
        const store = await makeStore();
        const old = makePost({ id: "old", createdAt: "2024-01-01T00:00:00.000Z" });
        const next = makePost({ id: "next", createdAt: "2024-01-02T00:00:00.000Z" });
        await store.upsertPosts([old]);
        await store.addSavedItems([savedItem(old.id, { source: "bookmark" })]);
        await store.setBookmarkFolder("folder-a", "A");

        expect(
          await store.beginBookmarkFolderSwitch(
            "folder-a",
            "folder-b",
            "B",
            "switch-run",
            5000,
            1000,
          ),
        ).toBe(true);
        expect(await store.getBookmarkFolder()).toEqual({ id: "folder-a", name: "A" });
        expect(
          await store.finishBookmarkFolderSwitch(
            "folder-a",
            "folder-b",
            "B",
            "switch-run",
            [next],
            [next.id],
            "2024-01-02T00:00:00.000Z",
          ),
        ).toEqual({ applied: true, added: 1, removed: 1 });
        expect(await store.getBookmarkFolder()).toEqual({ id: "folder-b", name: "B" });
        expect((await store.listSavedItems()).map((item) => item.postId)).toEqual([next.id]);
      });

      it("fences a staged switch when the selected folder changes before commit", async () => {
        const store = await makeStore();
        const next = makePost({ id: "next", createdAt: "2024-01-02T00:00:00.000Z" });
        await store.setBookmarkFolder("folder-a", "A");
        expect(
          await store.beginBookmarkFolderSwitch(
            "folder-a",
            "folder-b",
            "B",
            "switch-run",
            5000,
            1000,
          ),
        ).toBe(true);
        await store.clearBookmarkFolder("remove");

        expect(
          await store.finishBookmarkFolderSwitch(
            "folder-a",
            "folder-b",
            "B",
            "switch-run",
            [next],
            [next.id],
            "2024-01-02T00:00:00.000Z",
          ),
        ).toEqual({ applied: false, added: 0, removed: 0 });
        expect(await store.getPost(next.id)).toBeNull();
        expect(await store.getBookmarkFolder()).toEqual({ id: null, name: null });
      });

      it("single-flights a live scan and fences it after exact-expiry recovery", async () => {
        const store = await makeStore();
        const stalePost = makePost({ text: "stale owner" });
        const currentPost = makePost({ text: "recovered owner" });
        await store.setBookmarkFolder("folder1", "Reading");

        expect(await store.beginBookmarkSync("folder1", "run-old", 2000, 1000)).toBe(true);
        expect(await store.beginBookmarkSync("folder1", "run-new", 4000, 1999)).toBe(false);
        // At equality the crash lease is recoverable.
        expect(await store.beginBookmarkSync("folder1", "run-new", 4000, 2000)).toBe(true);

        expect(await store.renewBookmarkSync("folder1", "run-old", 5000)).toBe(false);
        expect(await store.abortBookmarkSync("folder1", "run-old")).toBe(false);
        expect(
          await store.finishBookmarkSync(
            "folder1",
            "run-old",
            [stalePost],
            [stalePost.id],
            true,
            "2024-01-01T00:00:00.000Z",
          ),
        ).toEqual({ applied: false, added: 0, removed: 0 });
        expect(await store.getPost(stalePost.id)).toBeNull();

        expect(await store.renewBookmarkSync("folder1", "run-new", 6000)).toBe(true);
        expect(
          await store.finishBookmarkSync(
            "folder1",
            "run-new",
            [currentPost],
            [currentPost.id],
            true,
            "2024-01-01T00:00:01.000Z",
          ),
        ).toEqual({ applied: true, added: 1, removed: 0 });
        expect((await store.listSavedItems()).map((item) => item.postId)).toEqual([
          currentPost.id,
        ]);
      });

      it("lets an unreplaced owner renew after expiry and releases handled failures", async () => {
        const store = await makeStore();
        await store.setBookmarkFolder("folder1", "Reading");
        expect(await store.beginBookmarkSync("folder1", "run-old", 2000, 1000)).toBe(true);

        // Expiry opens the recovery race; it does not itself change owner.
        expect(await store.renewBookmarkSync("folder1", "run-old", 5000)).toBe(true);
        expect(await store.beginBookmarkSync("folder1", "run-new", 6000, 3000)).toBe(false);
        expect(await store.abortBookmarkSync("folder1", "run-wrong")).toBe(false);
        expect(await store.abortBookmarkSync("folder1", "run-old")).toBe(true);
        expect(await store.beginBookmarkSync("folder1", "run-new", 6000, 3000)).toBe(true);
      });

      it("recovers a legacy or malformed bookmark-run setting", async () => {
        const store = await makeStore();
        await store.setBookmarkFolder("folder1", "Reading");
        await store.setSetting("bookmark_sync_run", "legacy-run-id");
        expect(await store.beginBookmarkSync("folder1", "run-json", 5000, 1000)).toBe(true);
        expect(await store.abortBookmarkSync("folder1", "run-json")).toBe(true);

        await store.setSetting("bookmark_sync_run", "{");
        expect(await store.beginBookmarkSync("folder1", "run-json-2", 5000, 1000)).toBe(true);
      });

      it("invalidates a scan when a fresh OAuth grant lands", async () => {
        const store = await makeStore();
        const post = makePost();
        await store.setBookmarkFolder("folder1", "Reading");
        expect(await store.beginBookmarkSync("folder1", "run-old-account", 5000, 1000)).toBe(true);

        await store.putOAuthTokens("self", {
          accessToken: "access-b",
          refreshToken: "refresh-b",
          expiresAt: 1_770_000_000_000,
          scope: "tweet.read users.read bookmark.read",
          userId: "account-b",
        });

        expect(
          await store.finishBookmarkSync(
            "folder1",
            "run-old-account",
            [post],
            [post.id],
            true,
            "2024-01-01T00:00:00.000Z",
          ),
        ).toEqual({ applied: false, added: 0, removed: 0 });
        expect(await store.getPost(post.id)).toBeNull();
        expect(await store.listSavedItems()).toEqual([]);
      });

      it("reconciles the newest complete scan atomically without touching manual rows", async () => {
        const store = await makeStore();
        await store.addSavedItems([
          savedItem("manual"),
          savedItem("gone", { source: "bookmark" }),
        ]);
        await store.setBookmarkFolder("folder1", "Reading");
        expect(await store.beginBookmarkSync("folder1", "run-current", 5000, 1000)).toBe(true);

        expect(
          await store.finishBookmarkSync(
            "folder1",
            "run-current",
            [
              makePost({ id: "manual", createdAt: "2024-01-01T00:00:00.000Z" }),
              makePost({ id: "new", createdAt: "2024-01-01T00:00:01.000Z" }),
            ],
            ["manual", "new"],
            true,
            "2024-01-01T00:00:00.000Z",
          ),
        ).toEqual({ applied: true, added: 1, removed: 1 });
        expect((await store.listSavedItems()).map(({ postId, source }) => ({ postId, source }))).toEqual([
          { postId: "manual", source: "manual" },
          { postId: "new", source: "bookmark" },
        ]);
      });

      it("commits a maximal 1,000-post folder scan as one owned transaction", async () => {
        const store = await makeStore();
        const posts = Array.from({ length: 1_000 }, (_, index) =>
          makePost({ text: `bookmark ${index}` }),
        );
        await store.setBookmarkFolder("folder1", "Reading");
        expect(await store.beginBookmarkSync("folder1", "run-max", 5000, 1000)).toBe(true);

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
        expect(await store.listSavedItems()).toHaveLength(1_000);
        expect(await store.getPostsByIds(posts.map((post) => post.id))).toHaveLength(1_000);
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

      /**
       * The join that decides whether a fetch adds a queue entry: an entry on
       * any post in the thread already represents it, and the post row is the
       * only thing that knows which thread a saved id belongs to.
       */
      describe("hasSavedConversation", () => {
        it("finds a conversation saved by a reply inside it", async () => {
          const store = await makeStore();
          const [root, reply] = makeThread(2) as [Post, Post];
          await store.upsertPosts([root, reply]);
          await store.addSavedItems([savedItem(reply.id, { source: "bookmark" })]);

          expect(await store.hasSavedConversation(root.id)).toBe(true);
        });

        it("finds a conversation saved by its own root", async () => {
          const store = await makeStore();
          const root = makePost();
          await store.upsertPosts([root]);
          await store.addSavedItems([savedItem(root.id)]);

          expect(await store.hasSavedConversation(root.id)).toBe(true);
        });

        it("is false for a conversation nothing saved represents", async () => {
          const store = await makeStore();
          const [root, reply] = makeThread(2) as [Post, Post];
          const elsewhere = makePost();
          await store.upsertPosts([root, reply, elsewhere]);
          await store.addSavedItems([savedItem(elsewhere.id)]);

          expect(await store.hasSavedConversation(root.id)).toBe(false);
        });

        it("is false for a saved id whose post was never stored", async () => {
          const store = await makeStore();
          await store.addSavedItems([savedItem("1796000000000000000")]);

          expect(await store.hasSavedConversation("1796000000000000000")).toBe(false);
        });

        it("is false for an unknown conversation", async () => {
          const store = await makeStore();

          expect(await store.hasSavedConversation("1796000000000000000")).toBe(false);
        });
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

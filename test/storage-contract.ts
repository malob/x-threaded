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
        expect(await store.hasConversation(meta.rootId)).toBe(false);
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

      describe("openConversation", () => {
        it("creates a partial row with no full read and a blank root", async () => {
          const store = await makeStore();

          await store.openConversation(meta.rootId, "2024-06-01T00:00:00.000Z");

          expect(await store.getConversationMeta(meta.rootId)).toEqual({
            rootAuthorHandle: "",
            rootText: "",
            rootCreatedAt: "",
            fetchedAt: "2024-06-01T00:00:00.000Z",
            status: "partial",
            fullReadAt: null,
          });
          expect(await store.hasConversation(meta.rootId)).toBe(true);
        });

        /** The blanks are a placeholder, not an answer: the run fills them. */
        it("lets the finishing write fill in the root it left blank", async () => {
          const store = await makeStore();
          await store.openConversation(meta.rootId, "2024-05-30T00:00:00.000Z");

          await store.upsertConversation(meta);

          expect(await store.getConversationMeta(meta.rootId)).toEqual(stored());
        });

        it("marks an existing conversation partial, keeping everything else", async () => {
          const store = await makeStore();
          await store.upsertConversation(meta);

          await store.openConversation(meta.rootId, "2024-07-01T00:00:00.000Z");

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
        await store.putOAuthTokens("self", { ...tokens, userId: null });

        expect(await store.getOAuthTokens("self")).toEqual(readyRow());
      });

      it("stores an absent userId as null", async () => {
        const store = await makeStore();
        await store.putOAuthTokens("self", tokens);

        expect(await store.getOAuthTokens("self")).toEqual(readyRow());
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

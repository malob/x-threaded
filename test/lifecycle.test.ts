/**
 * The conversation lifecycle: what a fetch leaves behind when it doesn't
 * finish, and how the app gets the rest of it later.
 *
 * Two failures this file exists to prevent, both of which cost money and show
 * nothing (2026-07-30 review, H2 and H3). One: a fetch the budget capped is
 * served ever after as a whole conversation, so the missing history can never
 * be asked for. Two: a fetch that died mid-pagination throws away the pages it
 * had already paid for. Everything here is asserted through the routes, since
 * the invariant is what a *later* request sees.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type {
  ApiError,
  ConversationResponse,
  Post,
  RefreshResponse,
} from "../src/shared/types";
import { POST_READ_USD } from "../src/shared/pricing";
import { XApiError } from "../src/server/xapi";
import { makePost } from "./fixtures";
import {
  fetchConversationRequest,
  makeTestApp,
  methods,
  replyTo,
  searchPage,
  seedConversation,
  servePages,
  type TestApp,
} from "./harness";

/** The conversation as a later reader sees it: cached, and labeled or not. */
async function cachedConversation(
  { app }: TestApp,
  rootId: string,
): Promise<ConversationResponse> {
  const response = await app.request(`/api/conversations/${rootId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ConversationResponse;
}

async function resume(app: TestApp["app"], rootId: string): Promise<Response> {
  return await app.request(`/api/conversations/${rootId}/resume`, { method: "POST" });
}

/** `count` replies to `root`, oldest first, one minute apart. */
function replies(root: Post, count: number, fromMinute = 1): Post[] {
  const base = Date.parse(root.createdAt);
  return Array.from({ length: count }, (_, i) =>
    replyTo(root, { createdAt: new Date(base + (fromMinute + i) * 60_000).toISOString() }),
  );
}

/** The options each searchConversationPage call was made with, in order. */
function pageOptions(xapi: TestApp["xapi"]): Record<string, unknown>[] {
  return xapi.calls
    .filter((call) => call.method === "searchConversationPage")
    .map((call) => call.args[1] as Record<string, unknown>);
}

describe("a fetch that dies mid-pagination", () => {
  it("keeps the pages it paid for, and says the conversation is partial", async () => {
    const harness = await makeTestApp();
    const { app, store, xapi } = harness;
    const root = makePost();
    const landed = replies(root, 3);
    xapi.onGetPost = () => root;
    let served = 0;
    xapi.onSearchConversationPage = () => {
      if (served++ === 0) return searchPage([root, ...landed], { nextToken: "page2" });
      throw new Error("X died on page 2");
    };

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(500);
    // The reads the dead run had already made are still disclosed: the lookup
    // that resolved the URL, plus the four posts page one returned — the root
    // among them credited, since the lookup had just stored it today.
    const body = (await response.json()) as ApiError;
    expect(body.cost).toEqual({ posts: 5, billable: 4, usd: 4 * POST_READ_USD });

    // What page one bought is in the store rather than lost with the throw.
    expect((await store.existingPostIds(root.id)).size).toBe(4);
    expect((await store.getConversationMeta(root.id))?.status).toBe("partial");

    const cached = await cachedConversation(harness, root.id);
    expect(cached.posts).toHaveLength(4);
    expect(cached.truncated).toBe(true);
  });

  /**
   * The retry semantics that replace the old poisoned-cache re-fetch: a row
   * exists, so pasting the URL again serves what was paid for and offers to
   * resume, instead of billing a second full read of the same conversation.
   */
  it("leaves a resumable row when the very first page dies", async () => {
    const harness = await makeTestApp();
    const { app, store, xapi } = harness;
    const root = makePost();
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => {
      throw new Error("X died on page 1");
    };

    expect((await fetchConversationRequest(app, root.id)).status).toBe(500);
    expect(await store.hasConversation(root.id)).toBe(true);

    const retry = await fetchConversationRequest(app, root.id);

    expect(retry.status).toBe(200);
    const body = (await retry.json()) as ConversationResponse;
    expect(body.fromCache).toBe(true);
    expect(body.truncated).toBe(true);
    // The retry resolves the pasted URL from the store: the dead run kept
    // the post its lookup bought, so nothing is re-bought — not the lookup,
    // and not the conversation.
    expect(methods(xapi)).toEqual(["getPost", "searchConversationPage"]);
  });

  it("resumes a conversation nothing landed for with an unbounded read", async () => {
    const harness = await makeTestApp();
    const { app, store, xapi } = harness;
    const root = makePost();
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => {
      throw new Error("X died on page 1");
    };
    await fetchConversationRequest(app, root.id);

    const reply = replies(root, 1)[0]!;
    xapi.onSearchConversationPage = () => searchPage([root, reply]);
    const response = await resume(app, root.id);

    expect(response.status).toBe(200);
    // Nothing is cached to bound the read, so it reads the conversation whole.
    expect(pageOptions(xapi).at(-1)).toMatchObject({ untilId: undefined });
    expect((await store.getConversationMeta(root.id))?.status).toBe("complete");
    expect(((await response.json()) as RefreshResponse).truncated).toBe(false);
  });
});

/**
 * The H2 pin. `truncated` used to live only on the response of the fetch that
 * hit the cap; every later read of the same conversation called it complete,
 * and Thread.tsx then annotated the missing replies as deleted.
 */
describe("a budget-capped fetch", () => {
  /**
   * A first fetch of `root` capped at `maxPosts`, against a conversation with
   * always more to give. `pageSize` posts come back per page, so a budget that
   * isn't a multiple of it exercises the remainder.
   */
  async function cappedFetch(maxPosts: number, pageSize = 10): Promise<TestApp & { root: Post }> {
    const harness = await makeTestApp({ maxPosts });
    const root = makePost();
    let served = 0;
    harness.xapi.onGetPost = () => root;
    harness.xapi.onSearchConversationPage = (_id, opts) =>
      searchPage(replies(root, Math.min(opts.maxResults, pageSize), served++ * pageSize + 1), {
        nextToken: "more",
      });
    const response = await fetchConversationRequest(harness.app, root.id);
    expect(response.status).toBe(200);
    return { ...harness, root };
  }

  it("is reported as partial by the fetch and by every read after it", async () => {
    const harness = await cappedFetch(10);

    expect((await harness.store.getConversationMeta(harness.root.id))?.status).toBe("partial");
    expect((await cachedConversation(harness, harness.root.id)).truncated).toBe(true);
  });

  it("never asks for a page the budget can't pay for", async () => {
    const harness = await cappedFetch(25);

    // Ask for what's left, never more; and stop under budget rather than ask
    // for the 5-post page the API's 10-result floor would reject.
    expect(pageOptions(harness.xapi).map((opts) => opts.maxResults)).toEqual([25, 15]);
  });

  it("marks a conversation complete when the search runs out of pages", async () => {
    const harness = await makeTestApp();
    const { app, xapi } = harness;
    const root = makePost();
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root, ...replies(root, 2)]);

    const response = await fetchConversationRequest(app, root.id);

    expect(((await response.json()) as ConversationResponse).truncated).toBe(false);
    expect((await cachedConversation(harness, root.id)).truncated).toBe(false);
  });
});

describe("conversation response consistency", () => {
  it("never labels a pre-finish post snapshot complete", async () => {
    const { app, store } = await makeTestApp();
    const root = makePost();
    const lateReply = replyTo(root);
    const startedAt = new Date().toISOString();
    const runId = "finishing-run";
    const now = Date.now();
    await store.upsertPosts([root]);
    await store.upsertConversation({
      rootId: root.id,
      rootAuthorHandle: root.authorHandle,
      rootText: root.text,
      rootCreatedAt: root.createdAt,
      fetchedAt: startedAt,
      status: "partial",
      fullReadAt: null,
    });
    expect(
      await store.claimConversationRun(
        root.id,
        runId,
        startedAt,
        now + 5 * 60_000,
        now,
        false,
      ),
    ).not.toBeNull();

    const readSnapshot = store.getConversationResponseSnapshot.bind(store);
    const readPosts = store.getPosts.bind(store);
    let finished = false;
    store.getConversationResponseSnapshot = async (conversationId) => {
      const snapshot = await readSnapshot(conversationId);
      if (conversationId === root.id && !finished) {
        finished = true;
        expect(
          await store.renewConversationRun(root.id, runId, now + 5 * 60_000, true),
        ).toBe(true);
        await store.upsertPosts([lateReply]);
        expect(
          await store.finishConversationRun(runId, {
            rootId: root.id,
            rootAuthorHandle: root.authorHandle,
            rootText: root.text,
            rootCreatedAt: root.createdAt,
            fetchedAt: new Date().toISOString(),
            status: "complete",
            fullReadAt: new Date().toISOString(),
          }),
        ).toBe(true);
      }
      return snapshot;
    };

    const response = await app.request(`/api/conversations/${root.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConversationResponse;

    // This reader captured the old subset while the run was partial. The run
    // completed before the response finished, but that must not relabel this
    // older snapshot as whole.
    expect(body.posts.map((post) => post.id)).toEqual([root.id]);
    expect(body.truncated).toBe(true);
    expect((await store.getConversationMeta(root.id))?.status).toBe("complete");
    expect(await readPosts(root.id)).toHaveLength(2);
  });

  it("never labels posts read after a complete-to-partial claim complete", async () => {
    const { app, store } = await makeTestApp();
    const root = makePost();
    const firstNewReply = replyTo(root);
    const completedAt = new Date().toISOString();
    await store.upsertPosts([root]);
    await store.upsertConversation({
      rootId: root.id,
      rootAuthorHandle: root.authorHandle,
      rootText: root.text,
      rootCreatedAt: root.createdAt,
      fetchedAt: completedAt,
      status: "complete",
      fullReadAt: completedAt,
    });

    const readSnapshot = store.getConversationResponseSnapshot.bind(store);
    let claimed = false;
    store.getConversationResponseSnapshot = async (conversationId) => {
      if (conversationId === root.id && !claimed) {
        claimed = true;
        const now = Date.now();
        expect(
          await store.claimConversationRun(
            root.id,
            "refreshing-run",
            new Date(now).toISOString(),
            now + 5 * 60_000,
            now,
            false,
          ),
        ).not.toBeNull();
        expect(
          await store.renewConversationRun(root.id, "refreshing-run", now + 5 * 60_000, true),
        ).toBe(true);
        await store.upsertPosts([firstNewReply]);
      }
      return await readSnapshot(conversationId);
    };

    const response = await app.request(`/api/conversations/${root.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConversationResponse;

    expect(body.posts.map((post) => post.id)).toEqual([root.id, firstNewReply.id]);
    expect(body.truncated).toBe(true);
    expect((await store.getConversationMeta(root.id))?.status).toBe("partial");
  });
});

describe("POST /api/conversations/:rootId/resume", () => {
  /** A partial conversation holding its root and its newest `count` replies. */
  async function partial(count = 2): Promise<TestApp & { root: Post; held: Post[] }> {
    const harness = await makeTestApp({ maxPosts: 10 });
    const root = makePost();
    // The replies X served are the newest ones; the older half is what resume
    // has to go back for.
    const held = replies(root, count, 10);
    harness.xapi.onGetPost = () => root;
    harness.xapi.onSearchConversationPage = () => searchPage([root, ...held], { nextToken: "more" });
    await fetchConversationRequest(harness.app, root.id);
    harness.xapi.onSearchConversationPage = undefined;
    return { ...harness, root, held };
  }

  it("404s a conversation that was never cached", async () => {
    const { app, xapi } = await makeTestApp();

    const response = await resume(app, "1796000000000000000");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "conversation not cached" });
    expect(xapi.calls).toEqual([]);
  });

  it("409s a conversation that is already complete, spending nothing", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    await seedConversation(store, root);

    const response = await resume(app, root.id);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conversation is already complete" });
    expect(xapi.calls).toEqual([]);
  });

  /**
   * The money pin: the boundary is the oldest reply we hold, so the posts
   * already paid for are never asked for again. The root is excluded on
   * purpose — it is the oldest post in any conversation, so bounding there
   * would ask for nothing and read the empty answer as "the end".
   */
  it("asks only for posts older than the oldest cached reply", async () => {
    const harness = await partial();
    const older = replies(harness.root, 1, 1);
    harness.xapi.onSearchConversationPage = () => searchPage(older);

    const response = await resume(harness.app, harness.root.id);

    expect(response.status).toBe(200);
    expect(pageOptions(harness.xapi).at(-1)).toMatchObject({
      untilId: harness.held[0]!.id,
      sinceId: undefined,
    });
    const body = (await response.json()) as RefreshResponse;
    expect(body.newCount).toBe(1);
    expect(body.cost).toEqual({ posts: 1, billable: 1, usd: POST_READ_USD });
  });

  it("flips to complete when the older pages run out", async () => {
    const harness = await partial();
    harness.xapi.onSearchConversationPage = () => searchPage(replies(harness.root, 1, 1));

    const response = await resume(harness.app, harness.root.id);

    expect(((await response.json()) as RefreshResponse).truncated).toBe(false);
    expect((await cachedConversation(harness, harness.root.id)).truncated).toBe(false);
  });

  it("stays partial when the budget caps it again", async () => {
    const harness = await partial();
    harness.xapi.onSearchConversationPage = (_id, opts) =>
      searchPage(replies(harness.root, opts.maxResults, 1), { nextToken: "still more" });

    const response = await resume(harness.app, harness.root.id);

    expect(((await response.json()) as RefreshResponse).truncated).toBe(true);
    expect((await cachedConversation(harness, harness.root.id)).truncated).toBe(true);
  });
});

/**
 * Which branch a refresh takes is a spending decision: a full reread gets
 * credit for already-stored page posts only on the same UTC day as the last
 * one, and X's dedup is keyed on the read itself, not on our row. Ancillary
 * lookups remain separately billable. So the fork reads `full_read_at` — the
 * last time we actually reread the whole thing — and nothing else may move it.
 */
describe("POST /api/conversations/:rootId/refresh — the full-read fork", () => {
  const TODAY = "2024-06-01T12:00:00.000Z";
  const YESTERDAY = "2024-05-31T12:00:00.000Z";

  afterEach(() => {
    setSystemTime();
  });

  /** A conversation fully read at `at`, holding its root and one reply. */
  async function fullyReadAt(at: string): Promise<TestApp & { root: Post; reply: Post }> {
    setSystemTime(new Date(at));
    const harness = await makeTestApp();
    const root = makePost({ createdAt: at });
    const reply = replyTo(root, { createdAt: new Date(Date.parse(at) + 60_000).toISOString() });
    harness.xapi.onGetPost = () => root;
    harness.xapi.onSearchConversationPage = () => searchPage([root, reply]);
    await fetchConversationRequest(harness.app, root.id);
    harness.xapi.onSearchConversationPage = undefined;
    return { ...harness, root, reply };
  }

  async function refresh(app: TestApp["app"], rootId: string): Promise<Response> {
    return await app.request(`/api/conversations/${rootId}/refresh`, { method: "POST" });
  }

  it("re-reads the whole conversation when the last full read was today", async () => {
    const harness = await fullyReadAt(TODAY);
    setSystemTime(new Date("2024-06-01T23:00:00.000Z"));
    harness.xapi.onSearchConversationPage = () => searchPage([harness.root, harness.reply]);

    const response = await refresh(harness.app, harness.root.id);

    expect(response.status).toBe(200);
    expect(pageOptions(harness.xapi).at(-1)).toMatchObject({ sinceId: undefined });
    // Free, which is the only reason this branch exists.
    expect(((await response.json()) as RefreshResponse).cost).toMatchObject({ billable: 0 });
  });

  it("asks only for newer posts when the last full read was another day", async () => {
    const harness = await fullyReadAt(YESTERDAY);
    setSystemTime(new Date(TODAY));
    harness.xapi.onSearchConversationPage = () => searchPage([]);

    const response = await refresh(harness.app, harness.root.id);

    expect(response.status).toBe(200);
    expect(pageOptions(harness.xapi).at(-1)).toMatchObject({ sinceId: harness.reply.id });
  });

  /**
   * The cost trap this column exists to close: a since_id refresh reads a
   * handful of new posts, not the conversation, so it must not make the next
   * refresh believe a full re-read is already paid for. It still advances
   * `fetched_at`, which is what "last checked" means.
   */
  it("does not let a since_id refresh buy a free full re-read", async () => {
    const harness = await fullyReadAt(YESTERDAY);
    setSystemTime(new Date(TODAY));
    harness.xapi.onSearchConversationPage = () => searchPage([]);
    await refresh(harness.app, harness.root.id);

    const meta = await harness.store.getConversationMeta(harness.root.id);
    expect(meta?.fetchedAt).toBe(TODAY);
    expect(meta?.fullReadAt?.slice(0, 10)).toBe(YESTERDAY.slice(0, 10));

    await refresh(harness.app, harness.root.id);
    expect(pageOptions(harness.xapi).at(-1)).toMatchObject({ sinceId: harness.reply.id });
  });

  it("does not let a resume buy one either", async () => {
    const harness = await fullyReadAt(YESTERDAY);
    setSystemTime(new Date(TODAY));
    // A refresh that the budget caps leaves the conversation partial, so it
    // can be resumed; the resume then completes it.
    harness.xapi.onSearchConversationPage = () => searchPage([], { nextToken: "more" });
    await refresh(harness.app, harness.root.id);
    expect((await harness.store.getConversationMeta(harness.root.id))?.status).toBe("partial");

    harness.xapi.onSearchConversationPage = () => searchPage([]);
    expect((await resume(harness.app, harness.root.id)).status).toBe(200);

    expect(await harness.store.getConversationMeta(harness.root.id)).toMatchObject({
      status: "complete",
      // Resume read the history, not the whole conversation: the next refresh
      // must still pay attention to what day the last full read was.
      fullReadAt: `${YESTERDAY.slice(0, 10)}T12:00:00.000Z`,
    });
  });

  it("lets a same-day full re-read complete a conversation the cap left partial", async () => {
    const harness = await makeTestApp({ maxPosts: 10 });
    const root = makePost();
    harness.xapi.onGetPost = () => root;
    servePages(harness.xapi, [searchPage([root], { nextToken: "more" })]);
    await fetchConversationRequest(harness.app, root.id);
    expect((await harness.store.getConversationMeta(root.id))?.status).toBe("partial");

    // A capped first read never recorded a full read, so this is the since_id
    // branch; it exhausts, which says nothing about the history it skipped.
    servePages(harness.xapi, [searchPage([])]);
    await harness.app.request(`/api/conversations/${root.id}/refresh`, { method: "POST" });
    expect((await harness.store.getConversationMeta(root.id))?.status).toBe("partial");

    // Forcing a whole read is what can honestly say "complete".
    servePages(harness.xapi, [searchPage([root])]);
    await fetchConversationRequest(harness.app, root.id, { force: true });
    expect((await harness.store.getConversationMeta(root.id))?.status).toBe("complete");
    expect((await cachedConversation(harness, root.id)).truncated).toBe(false);
  });
});

describe("what a run that dies before its first page leaves", () => {
  it("keeps the paid lookup, so the retry doesn't buy it again", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => {
      throw new Error("X died before page one");
    };
    await fetchConversationRequest(app, root.id);

    // The lookup was charged; discarding its result would make every retry
    // of this paste buy the same post again.
    expect(await store.getPost(root.id)).not.toBeNull();

    const retry = await fetchConversationRequest(app, root.id);
    expect(retry.status).toBe(200);
    expect(methods(xapi).filter((m) => m === "getPost")).toHaveLength(1);
  });

  it("refreshes a conversation missing its root as a full read", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    const reply = replyTo(root);
    // The reply is already held (a bookmark, say), so the paste needs no
    // lookup — and the run dies before its first page, leaving a partial row
    // whose conversation has no root.
    await store.upsertPosts([reply]);
    xapi.onSearchConversationPage = () => {
      throw new Error("X died before page one");
    };
    await fetchConversationRequest(app, reply.id);

    // "Newer than what we hold" has no base without the root: a since_id
    // bound at the stray reply would fetch newer posts forever while the
    // root and the history stayed missing. The refresh must read in full.
    servePages(xapi, [searchPage([root, reply])]);
    const response = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(pageOptions(xapi).at(-1)).toMatchObject({ sinceId: undefined });
    expect(await store.getPost(root.id)).not.toBeNull();
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "complete" });
  });
});

describe("what a run that dies restores", () => {
  it("puts a complete conversation's row back when it wrote nothing", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    servePages(xapi, [searchPage([root, replyTo(root)])]);
    await fetchConversationRequest(app, root.id);
    const before = await store.getConversationMeta(root.id);
    expect(before).toMatchObject({ status: "complete" });

    // The refresh's first request dies — a bad token, an outage. Opening the
    // run stamped the row partial; a death with nothing written proved
    // nothing, so the stamp must come back off, or held history gets
    // re-labeled as missing and offered for sale again.
    xapi.onSearchConversationPage = () => {
      throw new Error("X died before page one");
    };
    const failed = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });
    expect(failed.ok).toBe(false);

    expect(await store.getConversationMeta(root.id)).toEqual(before);
  });

  it("keeps a mid-run death partial: the pages it wrote are real", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    servePages(xapi, [searchPage([root, replyTo(root)])]);
    await fetchConversationRequest(app, root.id);

    const landed = replyTo(root);
    let served = 0;
    xapi.onSearchConversationPage = () => {
      if (served++ === 0) return searchPage([landed], { nextToken: "page2" });
      throw new Error("X died on page 2");
    };
    const failed = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });
    expect(failed.ok).toBe(false);

    // Page one landed in the store — durably, not just as a flag the run
    // kept for itself — so this run's data really is unfinished business,
    // and partial stands until a later run closes it.
    expect(await store.getPost(landed.id)).not.toBeNull();
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "partial" });
  });

  it("counts the bought lookup a forced paste stored before the run", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    servePages(xapi, [searchPage([root, replyTo(root)])]);
    await fetchConversationRequest(app, root.id);
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "complete" });

    // A forced paste of a reply we've never seen: the route buys the lookup
    // and stores it BEFORE the run opens the row. When the run then dies on
    // its first page, the row must stay partial — that reply arrived outside
    // the since_id chain, and restoring `complete` over it would seal a gap
    // no ordinary refresh can ever see past.
    const stray = replyTo(root);
    xapi.onGetPost = () => stray;
    xapi.onSearchConversationPage = () => {
      throw new Error("X died before page one");
    };
    const failed = await fetchConversationRequest(app, stray.id, { force: true });
    expect(failed.ok).toBe(false);

    expect(await store.getPost(stray.id)).not.toBeNull();
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "partial" });
  });

  it("reports the fetch's own error even when the restore write fails too", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    servePages(xapi, [searchPage([root, replyTo(root)])]);
    await fetchConversationRequest(app, root.id);

    // The run dies with X's own status AND the restore write fails on top.
    // The 401 is the error with something to say (it carries the login
    // link); a store failure during cleanup must not replace it with a 500.
    xapi.onSearchConversationPage = () => {
      throw new XApiError("X API 401 on /tweets/search/all", 401);
    };
    store.abortConversationRun = () => {
      throw new Error("store died during restore");
    };
    const failed = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });
    expect(failed.status).toBe(401);
  });

  it("leaves a row that was already partial partial, first death and second", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => {
      throw new Error("X died before page one");
    };

    // A first fetch with no prior row: the opened `partial` stamp is the
    // honest state — a fetch never finished — and stays.
    await fetchConversationRequest(app, root.id);
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "partial" });

    // A retry dying the same way restores partial onto partial: a no-op.
    const failed = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });
    expect(failed.ok).toBe(false);
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "partial" });
  });
});

describe("per-conversation run ownership", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("409s an overlapping active run before it can call X", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    await seedConversation(store, root);

    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let finishFirst!: (page: ReturnType<typeof searchPage>) => void;
    const firstPage = new Promise<ReturnType<typeof searchPage>>((resolve) => {
      finishFirst = resolve;
    });
    let calls = 0;
    xapi.onSearchConversationPage = () => {
      if (calls++ === 0) {
        firstStarted();
        return firstPage;
      }
      return searchPage([root]);
    };

    const first = fetchConversationRequest(app, root.id, { force: true });
    await started;
    const overlapping = await fetchConversationRequest(app, root.id, { force: true });
    finishFirst(searchPage([root]));
    const original = await first;

    expect(original.status).toBe(200);
    expect(overlapping.status).toBe(409);
    expect(await overlapping.json()).toEqual({ error: "conversation fetch already in progress" });
    expect(xapi.count("searchConversationPage")).toBe(1);
  });

  it("renews a long live pagination before its original lease can be recovered", async () => {
    const START = "2024-06-01T12:00:00.000Z";
    setSystemTime(new Date(START));
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ createdAt: START });
    await seedConversation(store, root);

    let thirdPageStarted!: () => void;
    const onThirdPage = new Promise<void>((resolve) => {
      thirdPageStarted = resolve;
    });
    let finishThirdPage!: (page: ReturnType<typeof searchPage>) => void;
    const thirdPage = new Promise<ReturnType<typeof searchPage>>((resolve) => {
      finishThirdPage = resolve;
    });
    let calls = 0;
    xapi.onSearchConversationPage = () => {
      if (calls++ === 0) {
        // Page one records the durable write bit, but does so at the original
        // clock time. Its lease therefore still ends at 12:05.
        return searchPage([root, replyTo(root)], { nextToken: "page-2" });
      }
      if (calls === 2) {
        // Page two returns near expiry. The write bit is already set, so the
        // conditional renewal window—not first-write marking—extends the lease.
        setSystemTime(new Date("2024-06-01T12:04:00.000Z"));
        return searchPage([replyTo(root)], { nextToken: "page-3" });
      }
      thirdPageStarted();
      return thirdPage;
    };

    const live = fetchConversationRequest(app, root.id, { force: true });
    await onThirdPage;
    // Past the original 12:05 lease, but still inside page two's renewal.
    setSystemTime(new Date("2024-06-01T12:05:01.000Z"));
    const overlapping = await fetchConversationRequest(app, root.id, { force: true });
    finishThirdPage(searchPage([root]));

    expect(overlapping.status).toBe(409);
    expect((await live).status).toBe(200);
    expect(xapi.count("searchConversationPage")).toBe(3);
  });

  it("keeps the original snapshot when both an expired owner and its recovery write nothing", async () => {
    const ORIGINAL = "2024-06-01T12:00:00.000Z";
    setSystemTime(new Date(ORIGINAL));
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ createdAt: ORIGINAL });
    await seedConversation(store, root);
    const before = await store.getConversationMeta(root.id);

    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let failFirst!: (error: Error) => void;
    const firstPage = new Promise<ReturnType<typeof searchPage>>((_, reject) => {
      failFirst = reject;
    });
    let calls = 0;
    xapi.onSearchConversationPage = () => {
      if (calls++ === 0) {
        firstStarted();
        return firstPage;
      }
      throw new Error("the recovery also failed before page one");
    };

    const expired = fetchConversationRequest(app, root.id, { force: true });
    await started;
    setSystemTime(new Date("2024-06-01T12:10:00.000Z"));
    expect((await fetchConversationRequest(app, root.id, { force: true })).status).toBe(500);
    expect(await store.getConversationMeta(root.id)).toEqual(before);

    failFirst(new Error("the expired owner finally failed"));
    expect((await expired).status).toBe(500);
    expect(await store.getConversationMeta(root.id)).toEqual(before);
  });

  it("keeps recovery partial when the expired owner persisted a page", async () => {
    const ORIGINAL = "2024-06-01T12:00:00.000Z";
    setSystemTime(new Date(ORIGINAL));
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ createdAt: ORIGINAL });
    await seedConversation(store, root);
    const landed = replyTo(root);

    let secondPageStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      secondPageStarted = resolve;
    });
    let failOldPage!: (error: Error) => void;
    const oldPage = new Promise<ReturnType<typeof searchPage>>((_, reject) => {
      failOldPage = reject;
    });
    let calls = 0;
    xapi.onSearchConversationPage = () => {
      if (calls++ === 0) return searchPage([landed], { nextToken: "page-2" });
      if (calls === 2) {
        secondPageStarted();
        return oldPage;
      }
      throw new Error("recovery failed before its first page");
    };

    const expired = fetchConversationRequest(app, root.id, { force: true });
    await started;
    setSystemTime(new Date("2024-06-01T12:10:00.000Z"));
    expect((await fetchConversationRequest(app, root.id, { force: true })).status).toBe(500);
    expect(await store.getPost(landed.id)).not.toBeNull();
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "partial" });

    failOldPage(new Error("the expired page finally failed"));
    expect((await expired).status).toBe(500);
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "partial" });
  });

  it("does not let an expired owner restore over the run that recovered its lease", async () => {
    const ORIGINAL = "2024-06-01T12:00:00.000Z";
    const RECOVERED = "2024-06-01T12:10:00.000Z";
    setSystemTime(new Date(ORIGINAL));
    const { app, store, xapi } = await makeTestApp();
    const root = makePost({ createdAt: ORIGINAL });
    await seedConversation(store, root);

    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let failFirst!: (error: Error) => void;
    const firstPage = new Promise<ReturnType<typeof searchPage>>((_, reject) => {
      failFirst = reject;
    });
    let calls = 0;
    xapi.onSearchConversationPage = () => {
      if (calls++ === 0) {
        firstStarted();
        return firstPage;
      }
      return searchPage([root, replyTo(root)]);
    };

    const stale = fetchConversationRequest(app, root.id, { force: true });
    await started;
    // The first Worker is still suspended, but its durable lease has had a
    // generous ten minutes to expire. A new invocation may recover the run.
    setSystemTime(new Date(RECOVERED));
    const recovered = await fetchConversationRequest(app, root.id, { force: true });
    expect(recovered.status).toBe(200);
    const afterRecovery = await store.getConversationMeta(root.id);
    expect(afterRecovery).toMatchObject({
      status: "complete",
      fetchedAt: RECOVERED,
      fullReadAt: RECOVERED,
    });

    failFirst(new Error("the expired holder finally failed"));
    expect((await stale).status).toBe(500);
    expect(await store.getConversationMeta(root.id)).toEqual(afterRecovery);
  });

  it("holds ownership until paid quote resolution finishes", async () => {
    const { app, store, xapi } = await makeTestApp();
    const quoted = makePost();
    const root = makePost({ quotedPostId: quoted.id });
    await seedConversation(store, root);
    xapi.onSearchConversationPage = () => searchPage([root]);

    let quoteStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      quoteStarted = resolve;
    });
    let finishQuote!: (value: { posts: Post[]; missing: [] }) => void;
    const quote = new Promise<{ posts: Post[]; missing: [] }>((resolve) => {
      finishQuote = resolve;
    });
    xapi.onGetPostsByIds = () => {
      quoteStarted();
      return quote;
    };

    const first = fetchConversationRequest(app, root.id, { force: true });
    await started;
    const overlapping = await fetchConversationRequest(app, root.id, { force: true });
    finishQuote({ posts: [quoted], missing: [] });

    expect(overlapping.status).toBe(409);
    expect((await first).status).toBe(200);
    expect(xapi.count("searchConversationPage")).toBe(1);
    expect(xapi.count("getPostsByIds")).toBe(1);
  });

  it("does not let an expired quote response overwrite the recovered owner's snapshot", async () => {
    const ORIGINAL = "2024-06-01T12:00:00.000Z";
    setSystemTime(new Date(ORIGINAL));
    const { app, store, xapi } = await makeTestApp();
    const quoteId = "1796000000000000999";
    const staleQuote = makePost({ id: quoteId, text: "stale quote snapshot" });
    const currentQuote = makePost({ id: quoteId, text: "recovered owner's quote snapshot" });
    const root = makePost({ createdAt: ORIGINAL, quotedPostId: quoteId });
    await seedConversation(store, root);
    xapi.onSearchConversationPage = () => searchPage([root]);

    let staleQuoteStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      staleQuoteStarted = resolve;
    });
    let finishStaleQuote!: (value: { posts: Post[]; missing: [] }) => void;
    const staleLookup = new Promise<{ posts: Post[]; missing: [] }>((resolve) => {
      finishStaleQuote = resolve;
    });
    let quoteCalls = 0;
    xapi.onGetPostsByIds = () => {
      if (quoteCalls++ === 0) {
        staleQuoteStarted();
        return staleLookup;
      }
      return { posts: [currentQuote], missing: [] };
    };

    const stale = fetchConversationRequest(app, root.id, { force: true });
    await started;
    // The first owner is still waiting on X, but its lease has expired. The
    // recovered owner buys and persists a newer snapshot, then closes its run.
    setSystemTime(new Date("2024-06-01T12:10:00.000Z"));
    expect((await fetchConversationRequest(app, root.id, { force: true })).status).toBe(200);
    expect((await store.getPost(quoteId))?.text).toBe(currentQuote.text);

    finishStaleQuote({ posts: [staleQuote], missing: [] });

    expect((await stale).status).toBe(409);
    expect((await store.getPost(quoteId))?.text).toBe(currentQuote.text);
    expect(xapi.count("getPostsByIds")).toBe(2);
  });

  it("closes and releases ownership after paid quote resolution fails", async () => {
    const { app, store, xapi } = await makeTestApp();
    const quoted = makePost();
    const root = makePost({ quotedPostId: quoted.id });
    await seedConversation(store, root);
    xapi.onSearchConversationPage = () => searchPage([root]);
    xapi.onGetPostsByIds = () => {
      throw new Error("quote lookup failed after the conversation was complete");
    };

    expect((await fetchConversationRequest(app, root.id, { force: true })).status).toBe(500);
    expect(await store.getConversationMeta(root.id)).toMatchObject({ status: "complete" });

    // The quote error travels to the client, but lifecycle close happened after
    // the paid lookup and released the run. A retry can therefore claim rather
    // than inheriting a stranded active lease.
    xapi.onGetPostsByIds = () => ({ posts: [quoted], missing: [] });
    expect((await fetchConversationRequest(app, root.id, { force: true })).status).toBe(200);
    expect(xapi.count("searchConversationPage")).toBe(2);
    expect(xapi.count("getPostsByIds")).toBe(2);
  });
});

describe("empty pages mid-search", () => {
  it("follows the token across an empty page instead of wedging", async () => {
    const harness = await makeTestApp();
    const root = makePost();
    harness.xapi.onGetPost = () => root;
    // Full-archive search can serve an empty slice mid-history. Stopping on
    // the first one would discard the token, and every later resume would
    // repeat the same bounded request into the same empty slice — partial
    // forever. Empty pages bill nothing (X charges per post returned), so
    // following them is free; only an unbroken run of them stops the fetch.
    servePages(harness.xapi, [
      searchPage([root], { nextToken: "empty1" }),
      searchPage([], { nextToken: "empty2" }),
      searchPage([replyTo(root)]),
    ]);

    const response = await fetchConversationRequest(harness.app, root.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ConversationResponse;
    expect(body.posts).toHaveLength(2);
    expect(body.truncated).toBe(false);
  });

  it("still stops a run that serves nothing but tokens", async () => {
    const harness = await makeTestApp();
    const root = makePost();
    harness.xapi.onGetPost = () => root;
    const emptyForever = Array.from({ length: 10 }, (_, i) =>
      searchPage([], { nextToken: `empty${i}` }),
    );
    servePages(harness.xapi, [searchPage([root], { nextToken: "empty0" }), ...emptyForever]);

    const response = await fetchConversationRequest(harness.app, root.id);

    // Stopped, partial, and well short of the ten pages on offer: the guard
    // is a bound on consecutive empties, not a lap counter.
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConversationResponse;
    expect(body.truncated).toBe(true);
    expect(pageOptions(harness.xapi).length).toBeLessThan(8);
  });
});

describe("what the routes make of a partial conversation", () => {
  it("serves it, labeled, without going back to X", async () => {
    const harness = await makeTestApp({ maxPosts: 10 });
    const root = makePost();
    harness.xapi.onGetPost = () => root;
    servePages(harness.xapi, [searchPage([root], { nextToken: "more" })]);
    await fetchConversationRequest(harness.app, root.id);
    const before = [...harness.xapi.calls];

    const response = await fetchConversationRequest(harness.app, root.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ConversationResponse;
    expect(body).toMatchObject({ fromCache: true, truncated: true });
    expect(harness.xapi.calls).toEqual(before);
  });
});

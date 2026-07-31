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
    // that resolved the URL, plus the four posts page one returned.
    const body = (await response.json()) as ApiError;
    expect(body.cost).toEqual({ posts: 5, billable: 5, usd: 5 * POST_READ_USD });

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
    // The retry resolves the pasted URL again — the dead run never stored the
    // post it bought, and a boundary invented from it would be worse than the
    // lookup — but it does not buy the conversation a second time.
    expect(methods(xapi)).toEqual(["getPost", "searchConversationPage", "getPost"]);
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
 * Which branch a refresh takes is a spending decision: a full re-read is free
 * only on the same UTC day as the last one, and X's dedup is keyed on the read
 * itself, not on our row. So the fork reads `full_read_at` — the last time we
 * actually re-read the whole thing — and nothing else may move it.
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

/**
 * The money suite: every behavior where a mistake spends real dollars.
 *
 * X bills $0.005 per post read and $0.001 per Owned Read, deduplicated within
 * a UTC day, so the assertions that matter here are X API *call counts* and
 * the estimate the request's meter reports. A cache guard that silently
 * inverts, or a billing check that moves one line, costs money and shows
 * nothing — these tests are the only thing standing between that and
 * production.
 *
 * Route-shape cases that aren't about spend live in routes.test.ts; the
 * bookmark scan's completeness rules live in xapi.test.ts. This file extends
 * both rather than repeating them.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { runConversationFetch } from "../src/server/conversation-fetch";
import { SpendMeter } from "../src/server/meter";
import { SELF_ID } from "../src/server/oauth";
import type { Storage } from "../src/server/storage";
import { XApiError, type ConversationPage } from "../src/server/xapi";
import { OWNED_READ_USD, POST_READ_USD, USER_READ_USD } from "../src/shared/pricing";
import type {
  ApiError,
  FetchCost,
  FoldersResponse,
  OwnPostsResponse,
  Post,
  RefreshResponse,
  SyncResponse,
} from "../src/shared/types";
import { makePost } from "./fixtures";
import {
  SELF_USER_ID,
  TEST_OAUTH,
  accountRequest,
  fetchConversationRequest,
  idsRequested,
  makeAuthedApp,
  makeBookmarkApp,
  makeTestApp,
  methods,
  replyTo,
  searchPage,
  seedConversation,
  servePages,
  type TestApp,
} from "./harness";

/** A post already in the store, last read on `day` (an ISO date). */
async function seedPostReadOn(store: Storage, day: string, post = makePost()): Promise<Post> {
  const stale = { ...post, fetchedAt: `${day}T09:00:00.000Z` };
  await store.upsertPosts([stale]);
  return stale;
}

/**
 * One conversation fetch, driven the way a route drives it: the service pages,
 * charges, credits and stores, and the estimate is read off the request's
 * meter afterwards. Cost is a property of the request, not of what happened to
 * end up in the store, so exercising the arithmetic means running the real
 * sequence — the ordering these tests pin only exists inside it.
 *
 * `known` is what the caller already holds (the pasted post), which the run
 * stores but is not billed for.
 */
async function ingestFetch(
  { store, xapi }: Pick<TestApp, "store" | "xapi">,
  page: ConversationPage,
  known: Post[] = [],
): Promise<FetchCost> {
  const rootId = (page.posts[0] ?? known[0])!.conversationId;
  const meter = new SpendMeter();
  servePages(xapi, [page]);
  await runConversationFetch(store, xapi, meter, rootId, { maxPosts: 500, known });
  return meter.cost();
}

const YESTERDAY = "2024-05-31";

describe("a conversation fetch — what actually bills", () => {
  it("bills every post of a first read", async () => {
    const app = await makeTestApp();
    const root = makePost();
    const posts = [root, replyTo(root), replyTo(root)];

    const cost = await ingestFetch(app, searchPage(posts));

    expect(cost).toEqual({ posts: 3, billable: 3, usd: 3 * POST_READ_USD });
    // One page, and nothing else bought: the root came back in it.
    expect(methods(app.xapi)).toEqual(["searchConversationPage"]);
  });

  it("credits every post in a repeated plain-page ingest on the same day", async () => {
    const app = await makeTestApp();
    const root = makePost();
    const posts = [root, replyTo(root)];
    await ingestFetch(app, searchPage(posts));

    const again = await ingestFetch(app, searchPage(posts));

    expect(again).toEqual({ posts: 2, billable: 0, usd: 0 });
  });

  it("bills again for a post last read on an earlier day", async () => {
    const app = await makeTestApp();
    const stale = await seedPostReadOn(app.store, YESTERDAY);

    // The same post comes back from X today, carrying today's fetchedAt.
    const cost = await ingestFetch(app, searchPage([makePost({ id: stale.id })]));

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
    const app = await makeTestApp();
    const stale = await seedPostReadOn(app.store, YESTERDAY);
    const readToday = makePost();
    await ingestFetch(app, searchPage([readToday]));

    const cost = await ingestFetch(app, searchPage([makePost({ id: stale.id }), readToday]));

    expect(cost).toEqual({ posts: 2, billable: 1, usd: POST_READ_USD });
  });

  it("counts a post once when it arrives in both posts and referenced", async () => {
    const app = await makeTestApp();
    const root = makePost();
    const reply = replyTo(root);

    const cost = await ingestFetch(app, searchPage([root, reply], { referenced: [root] }));

    expect(cost).toEqual({ posts: 2, billable: 2, usd: 2 * POST_READ_USD });
  });

  it("counts an extra once when the fetch already returned it", async () => {
    const app = await makeTestApp();
    const root = makePost();

    const cost = await ingestFetch(app, searchPage([root]), [root, root]);

    expect(cost.posts).toBe(1);
    expect(cost.billable).toBe(1);
  });

  /**
   * An extra is a post the caller already holds — from the store, or from a
   * lookup it charged for itself. Ingest stores it, but the fetch didn't
   * return it, so the fetch is not billed for it.
   */
  it("stores an extra the fetch missed without billing for it", async () => {
    const app = await makeTestApp();
    const root = makePost();
    const orphan = replyTo(root);

    const cost = await ingestFetch(app, searchPage([root]), [orphan]);

    expect(cost).toEqual({ posts: 1, billable: 1, usd: POST_READ_USD });
    expect((await app.store.getPosts(root.id)).map((p) => p.id).sort()).toEqual(
      [root.id, orphan.id].sort(),
    );
  });

  /**
   * The fetch paid for the current metrics; the caller's copy came out of the
   * store and may be weeks old. Storing the extras after the pages must not
   * put the stale one back on top of what was just bought.
   */
  it("keeps the fetched copy of a post the caller also held", async () => {
    const app = await makeTestApp();
    const root = makePost({ metrics: { ...makePost().metrics, likes: 1 } });
    const stale = { ...root, metrics: { ...root.metrics, likes: 0 } };
    await app.store.upsertPosts([stale]);

    await ingestFetch(app, searchPage([root]), [stale]);

    expect((await app.store.getPost(root.id))?.metrics.likes).toBe(1);
  });

  /**
   * The credit is bound to what the fetch charged for. A post handed in free
   * from the store would otherwise be credited as "already read today" and
   * net out a read the fetch genuinely paid for.
   */
  it("does not credit a stored extra against the fetch", async () => {
    const app = await makeTestApp();
    const known = makePost();
    await app.store.upsertPosts([known]);
    const root = makePost();

    const cost = await ingestFetch(app, searchPage([root]), [known]);

    expect(cost).toEqual({ posts: 1, billable: 1, usd: POST_READ_USD });
  });
});

describe("ingest — quoted-post resolution", () => {
  it("makes no X call when the quoted post is already stored", async () => {
    const app = await makeTestApp();
    const quoted = makePost();
    await app.store.upsertPosts([quoted]);
    const root = makePost({ quotedPostId: quoted.id });

    await ingestFetch(app, searchPage([root]));

    expect(app.xapi.count("getPostsByIds")).toBe(0);
  });

  it("makes no X call when the quoted post came in the same fetch", async () => {
    const app = await makeTestApp();
    const quoted = makePost();
    const root = makePost({ quotedPostId: quoted.id });

    await ingestFetch(app, searchPage([root], { referenced: [quoted] }));

    expect(app.xapi.count("getPostsByIds")).toBe(0);
  });

  it("fetches a missing quote exactly once, batching the whole level", async () => {
    const app = await makeTestApp();
    const q1 = makePost();
    const q2 = makePost();
    const root = makePost({ quotedPostId: q1.id });
    const reply = replyTo(root, { quotedPostId: q2.id });
    app.xapi.onGetPostsByIds = (ids) => ({
      posts: [q1, q2].filter((p) => ids.includes(p.id)),
      missing: [],
    });

    await ingestFetch(app, searchPage([root, reply]));

    expect(app.xapi.count("getPostsByIds")).toBe(1);
    expect(idsRequested(app.xapi)[0]?.sort()).toEqual([q1.id, q2.id].sort());
  });

  /**
   * Resolving a quote is a lookup nobody counted before the receipts landed:
   * the money left the account after the old snapshot was taken (H1).
   */
  it("bills the quotes it had to buy, on top of the fetch", async () => {
    const app = await makeTestApp();
    const quoted = makePost();
    const root = makePost({ quotedPostId: quoted.id });
    app.xapi.onGetPostsByIds = () => ({ posts: [quoted], missing: [] });

    const cost = await ingestFetch(app, searchPage([root]));

    expect(cost).toEqual({ posts: 2, billable: 2, usd: 2 * POST_READ_USD });
  });

  /**
   * Two levels are hydrated so a quote-of-a-quote renders nested; the third
   * renders as a bare x.com link instead. That boundary is a spending
   * decision — each extra level is another $0.005 per distinct quote.
   */
  it("follows a quote of a quote but never asks for the third level", async () => {
    const app = await makeTestApp();
    const level3 = makePost();
    const level2 = makePost({ quotedPostId: level3.id });
    const level1 = makePost({ quotedPostId: level2.id });
    const root = makePost({ quotedPostId: level1.id });
    const byId = new Map([level1, level2, level3].map((p) => [p.id, p]));
    app.xapi.onGetPostsByIds = (ids) => ({
      posts: ids.map((id) => byId.get(id)!).filter(Boolean),
      missing: [],
    });

    await ingestFetch(app, searchPage([root]));

    expect(idsRequested(app.xapi)).toEqual([[level1.id], [level2.id]]);
    expect(await app.store.hasPost(level2.id)).toBe(true);
    expect(await app.store.hasPost(level3.id)).toBe(false);
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
    xapi.onSearchConversationPage = () => searchPage([root, reply]);

    const response = await fetchConversationRequest(app, root.id, { force: true });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { unreadIds: string[] };
    expect(body.unreadIds.sort()).toEqual([root.id, reply.id].sort());
    expect(xapi.count("searchConversationPage")).toBe(1);
  });

  it("keeps a forced refetch free when the posts were already read today", async () => {
    const { app, store, xapi } = await makeTestApp();
    const root = makePost();
    await seedConversation(store, root);
    xapi.onSearchConversationPage = () => searchPage([root]);

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

  /** The since_id the first search page of a refresh was asked for. */
  function sinceIdOf(xapi: { calls: { method: string; args: unknown[] }[] }): unknown {
    const call = xapi.calls.find((c) => c.method === "searchConversationPage");
    return (call?.args[1] as { sinceId?: string } | undefined)?.sinceId;
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
    xapi.onSearchConversationPage = () => searchPage([root]);

    const response = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(xapi.count("searchConversationPage")).toBe(1);
    expect(sinceIdOf(xapi)).toBeUndefined();
    // This fixture has only one already-stored page post and no ancillary
    // lookups, so the same-day page credit makes its billable count zero.
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
    xapi.onSearchConversationPage = () => searchPage([]);

    const response = await app.request(`/api/conversations/${root.id}/refresh`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(sinceIdOf(xapi)).toBe(await store.newestPostId(root.id));
    expect(sinceIdOf(xapi)).toBe(reply.id);
  });

  /**
   * The cross-day branch used to leave `fetchedAt` where it was, because that
   * one column had to answer both "when did we last look" and "does a full
   * reread get today's page credit" — and advancing it would have made the next
   * refresh buy a whole conversation believing those posts were credited
   * (2026-07-30 review, H2).
   *
   * Two columns, two answers: this branch advances the freshness one and
   * leaves the full-read one alone, so metrics stop rotting without the trap
   * coming back.
   */
  it("advances fetchedAt on the cross-day branch, but not the page-credit clock", async () => {
    const { app, store, xapi, root } = await seedAt(SAME_DAY);
    const laterDay = "2024-06-03T09:00:00.000Z";
    setSystemTime(new Date(laterDay));
    xapi.onSearchConversationPage = () => searchPage([]);

    await app.request(`/api/conversations/${root.id}/refresh`, { method: "POST" });

    expect(await store.getConversationMeta(root.id)).toMatchObject({
      fetchedAt: laterDay,
      fullReadAt: SAME_DAY,
    });

    // And the branch is unchanged by it: still since_id, still not free.
    await app.request(`/api/conversations/${root.id}/refresh`, { method: "POST" });
    expect(sinceIdOf(xapi)).toBe(root.id);
  });

  it("treats 23:59:59Z and 00:00:01Z as different UTC days", async () => {
    const before = await seedAt("2024-06-01T23:59:59.000Z");
    before.xapi.onSearchConversationPage = () => searchPage([before.root]);
    await before.app.request(`/api/conversations/${before.root.id}/refresh`, { method: "POST" });
    expect(sinceIdOf(before.xapi)).toBeUndefined();

    const after = await seedAt("2024-06-01T23:59:59.000Z");
    await after.store.upsertPosts([after.root]);
    setSystemTime(new Date("2024-06-02T00:00:01.000Z"));
    after.xapi.onSearchConversationPage = () => searchPage([]);
    await after.app.request(`/api/conversations/${after.root.id}/refresh`, { method: "POST" });
    expect(sinceIdOf(after.xapi)).toBe(after.root.id);
  });

  it("reports newCount as the id-set delta, not the posts returned", async () => {
    const { app, xapi, root } = await seedAt(SAME_DAY);
    const known = replyTo(root, { createdAt: "2024-06-01T12:30:00.000Z" });
    const fresh = replyTo(root, { createdAt: "2024-06-01T12:40:00.000Z" });
    // The first refresh establishes `known`; the second returns it again
    // alongside one genuinely new post.
    xapi.onSearchConversationPage = () => searchPage([root, known]);
    await app.request(`/api/conversations/${root.id}/refresh`, { method: "POST" });

    xapi.onSearchConversationPage = () => searchPage([root, known, fresh]);
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
    const { app, store, xapi } = await makeAuthedApp();
    // Every page would offer another, but three threads is the whole ask.
    xapi.onGetOwnPosts = () => ({ posts: ownPage(3), nextToken: "more" });

    const response = await accountRequest(app, store, "/api/me/posts?threads=3");

    expect(response.status).toBe(200);
    expect(xapi.count("getOwnPosts")).toBe(1);
    expect(((await response.json()) as OwnPostsResponse).items).toHaveLength(3);
  });

  it("keeps paging while pages are short of the target", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const pages = [
      { posts: ownPage(2), nextToken: "p2" },
      { posts: ownPage(2), nextToken: "p3" },
      { posts: ownPage(2) },
    ];
    let served = 0;
    xapi.onGetOwnPosts = () => pages[served++] ?? { posts: [] };

    const response = await accountRequest(app, store, "/api/me/posts?threads=6");

    expect(xapi.count("getOwnPosts")).toBe(3);
    expect(((await response.json()) as OwnPostsResponse).items).toHaveLength(6);
  });

  it("stops when the timeline runs out, short of the target", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    xapi.onGetOwnPosts = () => ({ posts: ownPage(2) });

    const response = await accountRequest(app, store, "/api/me/posts?threads=20");

    expect(xapi.count("getOwnPosts")).toBe(1);
    const body = (await response.json()) as OwnPostsResponse;
    expect(body.items).toHaveLength(2);
    // Nothing trimmed and no next page: there is genuinely no more to find.
    expect(body.hasMore).toBe(false);
  });

  it("stops on an empty page even when X still offers a next token", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    xapi.onGetOwnPosts = () => ({ posts: [], nextToken: "endless" });

    const response = await accountRequest(app, store, "/api/me/posts?threads=5");

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
    const { app, store, xapi } = await makeTestApp();

    const response = await accountRequest(app, store, "/api/me/posts");

    expect(xapi.calls).toEqual([]);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "user context is not configured — visit /auth/login",
    });
  });
});

/**
 * A request that throws after money moved still has to say what it spent —
 * otherwise the one failure mode that costs dollars is the one that reports
 * nothing (2026-07-30 review, H1).
 */
describe("what a failed request discloses", () => {
  it("reports the spend so far when a later step throws", async () => {
    const { app, xapi } = await makeTestApp();
    const root = makePost();
    const quoting = replyTo(root, { quotedPostId: "1796000000000000000" });
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root, quoting]);
    // The quote lookup inside ingest throws — after the search was paid for.
    xapi.onGetPostsByIds = () => {
      throw new Error("X is having a moment");
    };

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(500);
    const body = (await response.json()) as ApiError;
    expect(body.error).toBe("internal error");
    // The lookup that resolved the URL, plus the two posts the search
    // returned — one of which is the root the lookup just bought and stored,
    // so its second reading is credited as X's same-day dedup covers it.
    expect(body.cost).toEqual({ posts: 3, billable: 2, usd: 2 * POST_READ_USD });
  });

  it("attaches no cost to a failure that spent nothing", async () => {
    const { app, xapi } = await makeTestApp();
    xapi.onGetPost = () => {
      throw new XApiError("no such post", 404);
    };

    const response = await fetchConversationRequest(app, "1796000000000000000");

    expect(await response.json()).toEqual({ error: "no such post" });
  });

  it("discloses the pages a paginated fetch bought before it died", async () => {
    const { app, xapi } = await makeTestApp();
    const root = makePost();
    xapi.onGetPost = () => root;
    // Each page is charged as it lands, so the two that did are already on the
    // request's meter when the third fails.
    let served = 0;
    xapi.onSearchConversationPage = () => {
      if (served++ < 2) {
        return searchPage(
          Array.from({ length: 100 }, () => replyTo(root)),
          { nextToken: `page${served + 1}` },
        );
      }
      throw new XApiError("X died on page 3", 500);
    };

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(502);
    const body = (await response.json()) as ApiError;
    // The lookup that resolved the URL, plus two hundred posts the dead
    // fetch bought before page three failed.
    expect(body.cost).toEqual({ posts: 201, billable: 201, usd: 201 * POST_READ_USD });
  });

  /**
   * The other half of the same rule: a call that dies with reads behind it and
   * no value to hand back attaches them to the error, and the error handler
   * has to add them in — otherwise that spend is disclosed nowhere.
   */
  it("absorbs the spend an error carried out of a dying lookup", async () => {
    const { app, xapi } = await makeTestApp();
    const root = makePost();
    const quoting = replyTo(root, { quotedPostId: "1796000000000000000" });
    xapi.onGetPost = () => root;
    xapi.onSearchConversationPage = () => searchPage([root, quoting]);
    xapi.onGetPostsByIds = () => {
      throw Object.assign(new XApiError("X died mid-lookup", 500), {
        spentReceipt: { reads: 40, ownedReads: 0, userReads: 0 },
      });
    };

    const response = await fetchConversationRequest(app, root.id);

    expect(response.status).toBe(502);
    // The URL lookup, the two posts the page returned (the root's second
    // reading credited — the lookup stored it moments earlier today), and the
    // forty the quote lookup had bought before it fell over.
    expect(((await response.json()) as ApiError).cost).toEqual({
      posts: 43,
      billable: 42,
      usd: 42 * POST_READ_USD,
    });
  });
});

describe("GET /api/bookmarks/folders — first-use identity spend", () => {
  it("reports the getMe read the first-ever call pays", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    // Valid tokens with no cached user ID, so userContext must buy a getMe.
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read",
      userId: null,
    });
    xapi.onGetMe = () => ({ id: "42", username: "m", name: "M" });
    xapi.onGetBookmarkFolders = () => [];

    const first = (await (
      await accountRequest(app, store, "/api/bookmarks/folders")
    ).json()) as FoldersResponse;
    // Folders are free; the read that resolved who "the user" is was not.
    //
    // It is a User Read at $0.010, not a post read at $0.005: this expectation
    // said POST_READ_USD until 2026-08-01, which is to say the test codified
    // the app's under-charging rather than X's published rate (N1).
    expect(first.cost).toEqual({ posts: 1, billable: 1, usd: USER_READ_USD });

    // Identity now cached: the next call spends nothing and says nothing.
    const second = (await (
      await accountRequest(app, store, "/api/bookmarks/folders")
    ).json()) as FoldersResponse;
    expect(second.cost).toBeUndefined();
  });
});

describe("POST /api/bookmarks/sync — what the scan bills", () => {
  it("bills the folder pages as Owned Reads and hydration as post reads", async () => {
    const { app, store } = await makeBookmarkApp([makePost(), makePost()], true);

    const response = await accountRequest(app, store, "/api/bookmarks/sync", {
      method: "POST",
    });

    expect(((await response.json()) as SyncResponse).cost).toEqual({
      posts: 4,
      billable: 4,
      usd: 2 * POST_READ_USD + 2 * OWNED_READ_USD,
    });
  });

  it("credits the hydration of posts already read today", async () => {
    const { app, store } = await makeBookmarkApp([makePost()], true);
    await accountRequest(app, store, "/api/bookmarks/sync", { method: "POST" });

    const response = await accountRequest(app, store, "/api/bookmarks/sync", {
      method: "POST",
    });

    // The folder page is enumerated again either way; the lookup that hydrates
    // it is the part X's same-day dedup makes free.
    expect(((await response.json()) as SyncResponse).cost).toEqual({
      posts: 2,
      billable: 1,
      usd: OWNED_READ_USD,
    });
  });
});

describe("GET /api/me/posts — what the scan bills", () => {
  it("bills a timeline page as Owned Reads", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    xapi.onGetOwnPosts = () => ({
      posts: Array.from({ length: 3 }, () => makePost({ authorId: SELF_USER_ID })),
    });

    const response = await accountRequest(app, store, "/api/me/posts?threads=3");

    expect(((await response.json()) as OwnPostsResponse).cost).toEqual({
      posts: 3,
      billable: 3,
      usd: 3 * OWNED_READ_USD,
    });
  });

  /** Root recovery is a lookup, not an Owned Read: different rate, same bill. */
  it("adds the post read that recovers a root the page didn't return", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const root = makePost({ authorId: SELF_USER_ID, createdAt: "2024-05-01T00:00:00.000Z" });
    const continuation = replyTo(root, {
      authorId: SELF_USER_ID,
      createdAt: "2024-06-01T00:00:00.000Z",
    });
    xapi.onGetOwnPosts = () => ({ posts: [continuation] });
    xapi.onGetPostsByIds = () => ({ posts: [root], missing: [] });

    const response = await accountRequest(app, store, "/api/me/posts");

    expect(((await response.json()) as OwnPostsResponse).cost).toEqual({
      posts: 2,
      billable: 2,
      usd: POST_READ_USD + OWNED_READ_USD,
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

    const response = await accountRequest(app, store, "/api/bookmarks/sync", {
      method: "POST",
    });

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

    const response = await accountRequest(app, store, "/api/bookmarks/sync", {
      method: "POST",
    });

    expect(await response.json()).toMatchObject({ complete: true, removed: 0 });
    expect((await store.listSavedItems()).map((i) => i.postId)).toContain(manual.id);
  });

  it("does not re-source a manual item that later shows up in the folder", async () => {
    const shared = makePost();
    const { app, store } = await makeBookmarkApp([shared], true);
    await seedSaved(store, shared, "manual", "2024-01-01T00:00:00.000Z");

    await accountRequest(app, store, "/api/bookmarks/sync", { method: "POST" });

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

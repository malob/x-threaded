import { describe, expect, it } from "bun:test";
import { runConversationFetch } from "../src/server/conversation-fetch";
import { bunDriver } from "../src/server/db/bun";
import { SqlStore } from "../src/server/db/store";
import { SpendMeter } from "../src/server/meter";
import { spentOnFailure, XApi, XApiError, XApiShapeError } from "../src/server/xapi";
import { snowflakeMs } from "../src/shared/snowflake";
import type { FetchCost, Post } from "../src/shared/types";
import { makePost, snowflakeId } from "./fixtures";
import { makeBookmarkApp } from "./harness";
import type { Storage } from "../src/server/storage";
import { withMockFetch } from "./setup";

/** A conversation root old enough to be outside any default search window. */
const ROOT_AT = "2020-01-02T03:04:05.000Z";
const ROOT_ID = snowflakeId(ROOT_AT);

/** One page of /tweets/search/all: `count` posts, plus an optional next_token. */
interface PageSpec {
  count: number;
  nextToken?: string;
}

/** The subset of an X API tweet object these tests care about. */
function apiTweet(id: string, ms: number) {
  return {
    id,
    text: "reply",
    author_id: "100",
    created_at: new Date(ms).toISOString(),
    conversation_id: ROOT_ID,
  };
}

function searchPage(spec: PageSpec, firstIndex: number): string {
  const data = Array.from({ length: spec.count }, (_, i) => {
    const ms = Date.parse(ROOT_AT) + (firstIndex + i + 1) * 1000;
    return apiTweet(snowflakeId(ms), ms);
  });
  return JSON.stringify({
    data,
    meta: {
      result_count: spec.count,
      ...(spec.nextToken === undefined ? {} : { next_token: spec.nextToken }),
    },
  });
}

/**
 * Serve a canned sequence of search pages, recording every request URL. A
 * request past the end of the sequence throws rather than returning an empty
 * page: "it asked for one page too many" is exactly what these tests catch,
 * and against the real API that page would have cost money.
 */
function serveSearchPages(specs: PageSpec[]): { urls: URL[]; restore: () => void } {
  const urls: URL[] = [];
  let served = 0;
  let posts = 0;
  const restore = withMockFetch((url) => {
    urls.push(new URL(url));
    const spec = specs[served++];
    if (!spec) throw new Error(`unexpected page request #${served}: ${url}`);
    const body = searchPage(spec, posts);
    posts += spec.count;
    return new Response(body, { headers: { "content-type": "application/json" } });
  });
  return { urls, restore };
}

const maxResults = (urls: URL[]): (string | null)[] =>
  urls.map((u) => u.searchParams.get("max_results"));

/** What one run of the fetch service left behind, and what it cost. */
interface RunResult {
  posts: number;
  truncated: boolean;
  cost: FetchCost;
}

/**
 * Drive the real fetch service over the real client, with only the network
 * faked. The budget and the search window are the service's decisions and the
 * URL is where they land, so this is the only seam that can check both at
 * once. The root is seeded so resolving it costs nothing and every read the
 * meter reports came from a page.
 */
async function runFetch(
  maxPosts: number,
  opts: { sinceId?: string; untilId?: string } = {},
): Promise<RunResult> {
  const store = new SqlStore(await bunDriver(":memory:"));
  await store.upsertPosts([makePost({ id: ROOT_ID })]);
  const meter = new SpendMeter();
  const api = new XApi("bearer", { pageDelayMs: 0 });
  const run = await runConversationFetch(store, api, meter, ROOT_ID, { maxPosts, ...opts });
  return {
    // Minus the seeded root, which no page returned.
    posts: (await store.existingPostIds(ROOT_ID)).size - 1,
    truncated: run.status === "partial",
    cost: meter.cost(),
  };
}

describe("the conversation fetch page budget", () => {
  it("requests only what's left in the budget", async () => {
    const { urls, restore } = serveSearchPages([
      { count: 100, nextToken: "page2" },
      { count: 50, nextToken: "page3" },
    ]);
    try {
      const result = await runFetch(150);
      expect(maxResults(urls)).toEqual(["100", "50"]);
      expect(result.posts).toBe(150);
      expect(result.truncated).toBe(true);
      // Every post both pages returned, and nothing beyond the budget.
      expect(result.cost).toMatchObject({ posts: 150, billable: 150 });
    } finally {
      restore();
    }
  });

  it("stops under budget when fewer than the API's 10-result floor remains", async () => {
    const { urls, restore } = serveSearchPages([{ count: 100, nextToken: "page2" }]);
    try {
      const result = await runFetch(105);
      expect(maxResults(urls)).toEqual(["100"]);
      expect(result.posts).toBe(100);
      expect(result.truncated).toBe(true);
    } finally {
      restore();
    }
  });

  it("fetches every page when the budget is generous", async () => {
    const { urls, restore } = serveSearchPages([
      { count: 100, nextToken: "page2" },
      { count: 40 },
    ]);
    try {
      const result = await runFetch(500);
      expect(maxResults(urls)).toEqual(["100", "100"]);
      expect(result.posts).toBe(140);
      expect(result.truncated).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("the conversation search window", () => {
  const HOUR_MS = 60 * 60 * 1000;

  it("bounds the search at the root's creation time, not X's 30-day default", async () => {
    const { urls, restore } = serveSearchPages([{ count: 5 }]);
    try {
      await runFetch(500);
      const startTime = urls[0]?.searchParams.get("start_time") ?? "";
      // Second-precision RFC3339 is what /tweets/search/all documents.
      expect(startTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(Date.parse(startTime)).toBe(snowflakeMs(ROOT_ID)! - HOUR_MS);
    } finally {
      restore();
    }
  });

  it("keeps the window on every page of a paginated fetch", async () => {
    const { urls, restore } = serveSearchPages([{ count: 100, nextToken: "page2" }, { count: 3 }]);
    try {
      await runFetch(500);
      const times = urls.map((u) => u.searchParams.get("start_time"));
      expect(times).toHaveLength(2);
      expect(new Set(times).size).toBe(1);
      expect(times[0]).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("omits start_time when since_id already bounds the range", async () => {
    const { urls, restore } = serveSearchPages([{ count: 2 }]);
    try {
      await runFetch(500, { sinceId: "998877" });
      expect(urls[0]?.searchParams.get("since_id")).toBe("998877");
      expect(urls[0]?.searchParams.has("start_time")).toBe(false);
    } finally {
      restore();
    }
  });

  /**
   * Resuming the history keeps the window: until_id says where to stop going
   * back, start_time still says the conversation can't predate its own root.
   */
  it("sends until_id alongside the window when resuming older posts", async () => {
    const { urls, restore } = serveSearchPages([{ count: 2 }]);
    try {
      await runFetch(500, { untilId: "998877" });
      expect(urls[0]?.searchParams.get("until_id")).toBe("998877");
      expect(urls[0]?.searchParams.has("since_id")).toBe(false);
      expect(urls[0]?.searchParams.has("start_time")).toBe(true);
    } finally {
      restore();
    }
  });
});

/**
 * The receipts the routes bill from. X charges per post a response returned,
 * so what counts is what came back — including the `includes` posts we ingest
 * and render, and excluding a post one response served twice.
 */
describe("what the client reports billing", () => {
  const MS = Date.parse(ROOT_AT);

  /** One search response: `data`, plus whatever `includes.tweets` carries. */
  function serveOnePage(data: unknown[], includedTweets: unknown[]): () => void {
    return withMockFetch(
      () =>
        new Response(
          JSON.stringify({
            data,
            includes: { tweets: includedTweets },
            meta: { result_count: data.length },
          }),
        ),
    );
  }

  it("counts a post the same response returned twice as one read", async () => {
    const parent = apiTweet(ROOT_ID, MS);
    const reply = apiTweet(snowflakeId(MS + 1000), MS + 1000);
    // X ships the parent again under includes because the reply references it.
    const restore = serveOnePage([parent, reply], [parent]);
    try {
      const { value, receipt } = await new XApi("bearer", {
        pageDelayMs: 0,
      }).searchConversationPage(ROOT_ID, { maxResults: 100 });
      expect(value.posts).toHaveLength(2);
      expect(receipt).toEqual({ reads: 2, ownedReads: 0 });
    } finally {
      restore();
    }
  });

  /** A quoted post arrives only via includes; we ingest it, so we count it. */
  it("counts an includes-only post as a read of its own", async () => {
    const quoted = apiTweet(snowflakeId(MS - 60_000), MS - 60_000);
    const restore = serveOnePage([apiTweet(ROOT_ID, MS)], [quoted]);
    try {
      const { value, receipt } = await new XApi("bearer", {
        pageDelayMs: 0,
      }).searchConversationPage(ROOT_ID, { maxResults: 100 });
      expect(value.referenced.map((p) => p.id)).toEqual([quoted.id]);
      expect(receipt).toEqual({ reads: 2, ownedReads: 0 });
    } finally {
      restore();
    }
  });

  it("bills a lookup for the posts it got back, not the ids it asked for", async () => {
    const found = apiTweet(ROOT_ID, MS);
    const restore = withMockFetch(() => new Response(JSON.stringify({ data: [found] })));
    try {
      const { value, receipt } = await new XApi("bearer").getPostsByIds([
        ROOT_ID,
        "1796000000000000000",
      ]);
      expect(value.posts).toHaveLength(1);
      expect(value.missing).toHaveLength(1);
      expect(receipt).toEqual({ reads: 1, ownedReads: 0 });
    } finally {
      restore();
    }
  });

  it("bills own posts as Owned Reads", async () => {
    const restore = withMockFetch(
      () => new Response(JSON.stringify({ data: [apiTweet(ROOT_ID, MS)] })),
    );
    try {
      const { receipt } = await new XApi("bearer").getOwnPosts("user-token", "100");
      expect(receipt).toEqual({ reads: 0, ownedReads: 1 });
    } finally {
      restore();
    }
  });
});

describe("wire shapes", () => {
  /** Serve one canned body to every request, whatever it asks for. */
  function serveBody(body: unknown): () => void {
    return withMockFetch(() => new Response(JSON.stringify(body)));
  }

  it("rejects a search page whose data is an object, not an array", async () => {
    // Only `data` is wrong, so the rejection can't be pinned on anything else.
    const restore = serveBody({
      data: apiTweet(ROOT_ID, Date.parse(ROOT_AT)),
      meta: { result_count: 1 },
    });
    try {
      const api = new XApi("bearer", { pageDelayMs: 0 });
      // A cast would make this an empty conversation — money spent, nothing
      // to show, and no sign anything went wrong.
      await expect(api.searchConversationPage(ROOT_ID, { maxResults: 100 })).rejects.toThrow(
        XApiShapeError,
      );
    } finally {
      restore();
    }
  });

  it("rejects a looked-up post that has no id", async () => {
    // Destructuring is how the id gets dropped; the binding is the cost.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _dropped, ...idless } = apiTweet(ROOT_ID, Date.parse(ROOT_AT));
    const restore = serveBody({ data: idless });
    try {
      const error = await new XApi("bearer").getPost(ROOT_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(XApiShapeError);
      // The endpoint, so the log says where the wire moved; and the field.
      expect((error as XApiShapeError).message).toContain(`/tweets/${ROOT_ID}`);
      expect((error as XApiShapeError).message).toContain("data.id");
    } finally {
      restore();
    }
  });

  it("keeps the response body out of the error it throws", async () => {
    const restore = serveBody({
      data: { ...apiTweet(ROOT_ID, Date.parse(ROOT_AT)), id: 12345, text: "kompromat" },
    });
    try {
      const error = await new XApi("bearer").getPost(ROOT_ID).catch((e: unknown) => e);
      const message = (error as Error).message;
      expect(message).toContain("data.id");
      // Valibot's own issue messages quote the offending value; ours must not,
      // or an X response ends up in the logs and back at the client.
      expect(message).not.toContain("12345");
      expect(message).not.toContain("kompromat");
    } finally {
      restore();
    }
  });

  it("parses a response carrying fields we've never heard of", async () => {
    const ms = Date.parse(ROOT_AT);
    const restore = serveBody({
      data: [{ ...apiTweet(ROOT_ID, ms), lang: "en", edit_history_tweet_ids: [ROOT_ID] }],
      includes: {
        users: [{ id: "100", name: "A", username: "a", verified_type: "blue" }],
        some_new_expansion: [{ whatever: true }],
      },
      meta: { result_count: 1, newest_id: ROOT_ID },
      // X adding a top-level key must never take the app down with it.
      unexpected_envelope: { note: "hello" },
    });
    try {
      const { value: result } = await new XApi("bearer", {
        pageDelayMs: 0,
      }).searchConversationPage(ROOT_ID, { maxResults: 100 });
      expect(result.posts.map((p) => p.id)).toEqual([ROOT_ID]);
      expect(result.posts[0]?.authorHandle).toBe("a");
    } finally {
      restore();
    }
  });

  it("truncates an upstream error body instead of carrying it whole", async () => {
    // An intermediary's error page can be arbitrarily large HTML, and this
    // message travels into logs and API responses.
    const restore = withMockFetch(() => new Response("<html>".repeat(2_000), { status: 400 }));
    try {
      const error = await new XApi("bearer").getPost(ROOT_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(XApiError);
      expect((error as Error).message.length).toBeLessThan(500);
    } finally {
      restore();
    }
  });
});

/**
 * A run that dies mid-pagination bought its earlier pages all the same. Each
 * page is charged as it lands, so that spend is already on the request's meter
 * when the next one throws — and a call that dies with reads behind it and no
 * value to return attaches them to the error, the only path left.
 */
describe("what a dying run carries out", () => {
  /** A run that throws, and the estimate its meter is left holding. */
  async function runFetchFailing(
    maxPosts: number,
  ): Promise<{ error: unknown; cost: FetchCost }> {
    const store = new SqlStore(await bunDriver(":memory:"));
    await store.upsertPosts([makePost({ id: ROOT_ID })]);
    const meter = new SpendMeter();
    const api = new XApi("bearer", { pageDelayMs: 0 });
    const error = await runConversationFetch(store, api, meter, ROOT_ID, { maxPosts }).catch(
      (e: unknown) => e,
    );
    return { error, cost: meter.cost() };
  }

  it("keeps the pages a conversation fetch bought before failing", async () => {
    // Page 1 succeeds; the request for page 2 dies on the wire.
    const { restore } = serveSearchPages([{ count: 100, nextToken: "page2" }]);
    try {
      const { error, cost } = await runFetchFailing(500);
      expect(error).toBeInstanceOf(Error);
      expect(cost).toMatchObject({ posts: 100, billable: 100 });
    } finally {
      restore();
    }
  });

  it("counts a dying media re-lookup's page alongside the run's", async () => {
    const MS = Date.parse(ROOT_AT);
    const included = {
      ...apiTweet(snowflakeId(MS - 60_000), MS - 60_000),
      attachments: { media_keys: ["m1"] },
    };
    let calls = 0;
    const restore = withMockFetch(() => {
      if (calls++ === 0) {
        return new Response(
          JSON.stringify({
            data: [apiTweet(snowflakeId(MS + 1000), MS + 1000)],
            includes: { tweets: [included] },
            meta: { result_count: 1 },
          }),
        );
      }
      // The media re-lookup for the included post dies before returning.
      throw new Error("lookup died");
    });
    try {
      const { error, cost } = await runFetchFailing(100);
      expect(error).toBeInstanceOf(Error);
      // The page billed two posts; the lookup died having returned none, so it
      // has nothing of its own to attach.
      expect(cost).toMatchObject({ posts: 2, billable: 2 });
      expect(spentOnFailure(error)).toBeNull();
    } finally {
      restore();
    }
  });

  it("attaches what a lookup bought when a later page dies", async () => {
    let calls = 0;
    const restore = withMockFetch(() => {
      if (calls++ === 0) return new Response(searchPage({ count: 100 }, 0));
      throw new Error("page 2 died");
    });
    try {
      const ids = Array.from({ length: 150 }, (_, i) =>
        snowflakeId(Date.parse(ROOT_AT) + (i + 1) * 1000),
      );
      const error = await new XApi("bearer").getPostsByIds(ids).catch((e: unknown) => e);
      expect(spentOnFailure(error)).toEqual({ reads: 100, ownedReads: 0 });
    } finally {
      restore();
    }
  });
});

describe("getPostsByIds hydration loss", () => {
  const hereMs = Date.parse(ROOT_AT) + 1000;
  const here = snowflakeId(hereMs);
  const gone = snowflakeId(hereMs + 1000);

  it("names the ids the lookup couldn't return, with X's stated reason", async () => {
    const restore = withMockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [apiTweet(here, hereMs)],
            errors: [
              {
                resource_id: gone,
                value: gone,
                title: "Authorization Error",
                detail: `Sorry, you are not authorized to see the Tweet with ids: [${gone}].`,
                type: "https://api.twitter.com/2/problems/not-authorized-for-resource",
              },
            ],
          }),
        ),
    );
    try {
      const { value, receipt } = await new XApi("bearer").getPostsByIds([here, gone]);
      expect(value.posts.map((p) => p.id)).toEqual([here]);
      expect(value.missing).toEqual([{ id: gone, reason: "Authorization Error" }]);
      // Only the post actually returned bills.
      expect(receipt).toEqual({ reads: 1, ownedReads: 0 });
    } finally {
      restore();
    }
  });

  it("counts an absence X never explained as missing, without a reason", async () => {
    const restore = withMockFetch(
      () => new Response(JSON.stringify({ data: [apiTweet(here, hereMs)] })),
    );
    try {
      const { value } = await new XApi("bearer").getPostsByIds([here, gone]);
      expect(value.missing).toEqual([{ id: gone, reason: undefined }]);
    } finally {
      restore();
    }
  });

  it("keeps the page when the errors array itself is garbage", async () => {
    // A malformed errors member may cost the reasons, never the posts beside it.
    const restore = withMockFetch(
      () =>
        new Response(JSON.stringify({ data: [apiTweet(here, hereMs)], errors: "not an array" })),
    );
    try {
      const { value } = await new XApi("bearer").getPostsByIds([here, gone]);
      expect(value.posts.map((p) => p.id)).toEqual([here]);
      expect(value.missing).toEqual([{ id: gone, reason: undefined }]);
    } finally {
      restore();
    }
  });
});

/** Bookmark-folder page: the bare `{id}` stubs the endpoint actually returns. */
interface FolderPage {
  ids: string[];
  nextToken?: string;
}

/**
 * Serve a folder enumeration, hydrating whatever IDs it then looks up. An
 * enumeration request past the end of the sequence throws: the point of these
 * tests is which pages get asked for. IDs in `unavailable` enumerate like any
 * bookmark but hydrate as a partial error, the way a deleted post's would.
 */
function serveFolderPages(pages: FolderPage[], unavailable: string[] = []): () => void {
  let served = 0;
  const withheld = new Set(unavailable);
  return withMockFetch((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/2/tweets") {
      const ids = (parsed.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      const body = {
        data: ids
          .filter((id) => !withheld.has(id))
          .map((id, i) => apiTweet(id, Date.parse(ROOT_AT) + (i + 1) * 1000)),
        errors: ids
          .filter((id) => withheld.has(id))
          .map((id) => ({
            resource_id: id,
            value: id,
            title: "Not Found Error",
            detail: `Could not find tweet with ids: [${id}].`,
          })),
      };
      return new Response(JSON.stringify(body));
    }
    const page = pages[served++];
    if (!page) throw new Error(`unexpected folder page request #${served}: ${url}`);
    const body = {
      data: page.ids.map((id) => ({ id })),
      meta: page.nextToken === undefined ? {} : { next_token: page.nextToken },
    };
    return new Response(JSON.stringify(body));
  });
}

const folderId = (n: number): string => snowflakeId(Date.parse(ROOT_AT) + n * 60_000);

describe("getBookmarksByFolder completeness", () => {
  it("reports incomplete when the page cap cuts the enumeration short", async () => {
    const restore = serveFolderPages([
      { ids: [folderId(1)], nextToken: "p2" },
      { ids: [folderId(2)], nextToken: "p3" },
    ]);
    try {
      const api = new XApi("bearer", { pageDelayMs: 0 });
      const { value: result } = await api.getBookmarksByFolder("user-token", "u1", "folder1", 2);
      expect(result.posts.map((p) => p.id)).toEqual([folderId(1), folderId(2)]);
      expect(result.complete).toBe(false);
    } finally {
      restore();
    }
  });

  it("reports complete when the folder runs out before the page cap", async () => {
    const restore = serveFolderPages([
      { ids: [folderId(1)], nextToken: "p2" },
      { ids: [folderId(2)] },
    ]);
    try {
      const api = new XApi("bearer", { pageDelayMs: 0 });
      const { value: result, receipt } = await api.getBookmarksByFolder(
        "user-token",
        "u1",
        "folder1",
        10,
      );
      expect(result.posts.map((p) => p.id)).toEqual([folderId(1), folderId(2)]);
      expect(result.complete).toBe(true);
      // Two folder pages of stubs, then one lookup hydrating both: the nested
      // call's receipt lands in the scan's, exactly once.
      expect(receipt).toEqual({ reads: 2, ownedReads: 2 });
    } finally {
      restore();
    }
  });

  it("passes hydration loss through beside the ids that stayed bookmarks", async () => {
    const restore = serveFolderPages([{ ids: [folderId(1), folderId(2)] }], [folderId(2)]);
    try {
      const api = new XApi("bearer", { pageDelayMs: 0 });
      const { value: result, receipt } = await api.getBookmarksByFolder(
        "user-token",
        "u1",
        "folder1",
      );
      expect(result.posts.map((p) => p.id)).toEqual([folderId(1)]);
      expect(result.ids).toEqual([folderId(1), folderId(2)]);
      expect(result.missing).toEqual([{ id: folderId(2), reason: "Not Found Error" }]);
      expect(result.complete).toBe(true);
      // Two enumerated stubs, one post actually returned: a missing id bills nothing.
      expect(receipt).toEqual({ reads: 1, ownedReads: 2 });
    } finally {
      restore();
    }
  });
});

describe("POST /api/bookmarks/sync reconciliation", () => {
  /** A bookmark-sourced saved item the enumeration didn't return. */
  async function seedUnseenBookmark(store: Storage): Promise<Post> {
    const post = makePost();
    await store.upsertPosts([post]);
    await store.addSavedItems([
      { postId: post.id, source: "bookmark", addedAt: new Date().toISOString() },
    ]);
    return post;
  }

  it("keeps unseen bookmarks when the folder scan didn't finish", async () => {
    const inFolder = makePost();
    const { app, store } = await makeBookmarkApp([inFolder], false);
    const beyondTheCap = await seedUnseenBookmark(store);

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: false, added: 1, removed: 0 });

    const saved = (await store.listSavedItems()).map((i) => i.postId);
    expect(saved).toContain(beyondTheCap.id);
    expect(saved).toContain(inFolder.id);
  });

  it("removes vanished bookmarks once the whole folder was seen", async () => {
    const inFolder = makePost();
    const { app, store } = await makeBookmarkApp([inFolder], true);
    const unbookmarked = await seedUnseenBookmark(store);

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: true, added: 1, removed: 1 });

    const saved = (await store.listSavedItems()).map((i) => i.postId);
    expect(saved).not.toContain(unbookmarked.id);
    expect(saved).toContain(inFolder.id);
  });
});

describe("POST /api/bookmarks/sync hydration loss", () => {
  it("keeps a bookmark whose post failed to hydrate, on a complete scan", async () => {
    // B's author went private: the folder still lists B's id, but hydration
    // returns no post for it. That is not an un-bookmarking.
    const postA = makePost({ text: "hydrated bookmark" });
    const missingId = snowflakeId("2025-05-05T05:05:05.000Z");
    const goneId = snowflakeId("2025-06-06T06:06:06.000Z");
    const { app, store } = await makeBookmarkApp([postA], true, "u1", [postA.id, missingId]);
    await store.addSavedItems([
      { postId: missingId, source: "bookmark", addedAt: new Date().toISOString() },
      // Genuinely un-bookmarked (absent from the enumerated ids): removable.
      { postId: goneId, source: "bookmark", addedAt: new Date().toISOString() },
    ]);

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ removed: 1, complete: true, unavailable: 1 });

    const remaining = (await store.listSavedItems()).map((i) => i.postId);
    expect(remaining).toContain(missingId);
    expect(remaining).not.toContain(goneId);
  });

  it("reports bookmarks it couldn't hydrate without inventing entries", async () => {
    const postA = makePost({ text: "hydrated bookmark" });
    const ghostId = snowflakeId("2025-07-07T07:07:07.000Z");
    const { app, store } = await makeBookmarkApp([postA], true, "u1", [postA.id, ghostId]);

    const response = await app.request("/api/bookmarks/sync", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ added: 1, removed: 0, unavailable: 1 });

    // Nothing to render for the ghost, so no saved row — but it is counted,
    // and its folder id keeps it from ever reading as un-bookmarked.
    expect((await store.listSavedItems()).map((i) => i.postId)).toEqual([postA.id]);
  });
});

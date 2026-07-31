import { describe, expect, it } from "bun:test";
import { XApi, XApiError, XApiShapeError } from "../src/server/xapi";
import { snowflakeMs } from "../src/shared/snowflake";
import type { Post } from "../src/shared/types";
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

describe("fetchConversation page budget", () => {
  it("requests only what's left in the budget", async () => {
    const { urls, restore } = serveSearchPages([
      { count: 100, nextToken: "page2" },
      { count: 50, nextToken: "page3" },
    ]);
    try {
      const api = new XApi("bearer", { pageDelayMs: 0 });
      const result = await api.fetchConversation(ROOT_ID, 150);
      expect(maxResults(urls)).toEqual(["100", "50"]);
      expect(result.posts).toHaveLength(150);
      expect(result.truncated).toBe(true);
    } finally {
      restore();
    }
  });

  it("stops under budget when fewer than the API's 10-result floor remains", async () => {
    const { urls, restore } = serveSearchPages([{ count: 100, nextToken: "page2" }]);
    try {
      const api = new XApi("bearer", { pageDelayMs: 0 });
      const result = await api.fetchConversation(ROOT_ID, 105);
      expect(maxResults(urls)).toEqual(["100"]);
      expect(result.posts).toHaveLength(100);
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
      const api = new XApi("bearer", { pageDelayMs: 0 });
      const result = await api.fetchConversation(ROOT_ID, 500);
      expect(maxResults(urls)).toEqual(["100", "100"]);
      expect(result.posts).toHaveLength(140);
      expect(result.truncated).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("fetchConversation search window", () => {
  const HOUR_MS = 60 * 60 * 1000;

  it("bounds the search at the root's creation time, not X's 30-day default", async () => {
    const { urls, restore } = serveSearchPages([{ count: 5 }]);
    try {
      await new XApi("bearer", { pageDelayMs: 0 }).fetchConversation(ROOT_ID, 500);
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
      await new XApi("bearer", { pageDelayMs: 0 }).fetchConversation(ROOT_ID, 500);
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
      await new XApi("bearer", { pageDelayMs: 0 }).fetchConversation(ROOT_ID, 500, "998877");
      expect(urls[0]?.searchParams.get("since_id")).toBe("998877");
      expect(urls[0]?.searchParams.has("start_time")).toBe(false);
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
      await expect(api.fetchConversation(ROOT_ID, 100)).rejects.toThrow(XApiShapeError);
    } finally {
      restore();
    }
  });

  it("rejects a looked-up post that has no id", async () => {
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
      const result = await new XApi("bearer", { pageDelayMs: 0 }).fetchConversation(ROOT_ID, 100);
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

/** Bookmark-folder page: the bare `{id}` stubs the endpoint actually returns. */
interface FolderPage {
  ids: string[];
  nextToken?: string;
}

/**
 * Serve a folder enumeration, hydrating whatever IDs it then looks up. An
 * enumeration request past the end of the sequence throws: the point of these
 * tests is which pages get asked for.
 */
function serveFolderPages(pages: FolderPage[]): () => void {
  let served = 0;
  return withMockFetch((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/2/tweets") {
      const ids = (parsed.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      const body = { data: ids.map((id, i) => apiTweet(id, Date.parse(ROOT_AT) + (i + 1) * 1000)) };
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
      const result = await api.getBookmarksByFolder("user-token", "u1", "folder1", 2);
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
      const result = await api.getBookmarksByFolder("user-token", "u1", "folder1", 10);
      expect(result.posts.map((p) => p.id)).toEqual([folderId(1), folderId(2)]);
      expect(result.complete).toBe(true);
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
    expect(await response.json()).toMatchObject({ removed: 1, complete: true });

    const remaining = (await store.listSavedItems()).map((i) => i.postId);
    expect(remaining).toContain(missingId);
    expect(remaining).not.toContain(goneId);
  });
});

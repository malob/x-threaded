import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  BOOKMARK_SYNC_LEASE_MS,
  buildApp,
} from "../src/server/app";
import { bunDriver } from "../src/server/db/bun";
import { SqlStore } from "../src/server/db/store";
import { SELF_ID } from "../src/server/oauth";
import type { Post } from "../src/shared/types";
import { XApiError } from "../src/server/xapi";
import { FakeXApi } from "./fake-xapi";
import { makePost } from "./fixtures";
import { makeAuthedApp, TEST_OAUTH } from "./harness";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function selectFolder(
  app: Awaited<ReturnType<typeof makeAuthedApp>>["app"],
  id: string,
  name: string,
): Promise<Response> {
  return await app.request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookmarkFolderId: id, bookmarkFolderName: name }),
  });
}

describe("bookmark sync ownership", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("rejects a second app before it can spend on the same folder", async () => {
    const driver = await bunDriver(":memory:");
    const storeA = new SqlStore(driver);
    const storeB = new SqlStore(driver);
    const xapi = new FakeXApi();
    const appA = buildApp({ store: storeA, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    const appB = buildApp({ store: storeB, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    await storeA.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account",
    });
    await storeA.setBookmarkFolder("folder", "Reading");

    const firstStarted = deferred<void>();
    const finishFirst = deferred<{
      posts: Post[];
      ids: string[];
      missing: [];
      complete: boolean;
    }>();
    const post = makePost();
    let scans = 0;
    xapi.onGetBookmarksByFolder = () => {
      scans += 1;
      if (scans === 1) {
        firstStarted.resolve();
        return finishFirst.promise;
      }
      return { posts: [], ids: [], missing: [], complete: true };
    };

    const first = appA.request("/api/bookmarks/sync", { method: "POST" });
    await firstStarted.promise;
    const overlapping = await appB.request("/api/bookmarks/sync", { method: "POST" });
    finishFirst.resolve({ posts: [post], ids: [post.id], missing: [], complete: true });
    const original = await first;

    expect(original.status).toBe(200);
    expect(overlapping.status).toBe(409);
    expect(xapi.count("getBookmarksByFolder")).toBe(1);
    expect(await storeB.listSavedItems()).toEqual([
      expect.objectContaining({ postId: post.id, source: "bookmark" }),
    ]);
  });

  it("does not let an old folder scan reconcile over a newer completed sync", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const oldPost = makePost({ id: "1796000000000000101" });
    const newPost = makePost({ id: "1796000000000000102" });
    const oldResult = deferred<{
      posts: Post[];
      ids: string[];
      missing: [];
      complete: boolean;
    }>();
    const oldStarted = deferred<void>();

    expect((await selectFolder(app, "folder-old", "Old folder")).status).toBe(200);
    xapi.onGetBookmarksByFolder = (_token, _userId, folderId) => {
      if (folderId === "folder-old") {
        oldStarted.resolve();
        return oldResult.promise;
      }
      expect(folderId).toBe("folder-new");
      return { posts: [newPost], ids: [newPost.id], missing: [], complete: true };
    };

    const stale = app.request("/api/bookmarks/sync", { method: "POST" });
    await oldStarted.promise;
    expect((await selectFolder(app, "folder-new", "New folder")).status).toBe(200);

    const current = await app.request("/api/bookmarks/sync", { method: "POST" });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ added: 1, removed: 0 });

    oldResult.resolve({
      posts: [oldPost],
      ids: [oldPost.id],
      missing: [],
      complete: true,
    });
    const superseded = await stale;

    expect(superseded.status).toBe(409);
    expect(await superseded.json()).toMatchObject({
      error: "bookmark sync ownership changed; retry",
    });
    expect(await store.listSavedItems()).toEqual([
      expect.objectContaining({ postId: newPost.id, source: "bookmark" }),
    ]);
  });

  it("recovers an expired scan and fences the stale response before hydration", async () => {
    const started = new Date("2024-06-01T12:00:00.000Z");
    setSystemTime(started);
    const driver = await bunDriver(":memory:");
    const storeA = new SqlStore(driver);
    const storeB = new SqlStore(driver);
    const xapi = new FakeXApi();
    const appA = buildApp({ store: storeA, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    const appB = buildApp({ store: storeB, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    await storeA.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: started.getTime() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account",
    });
    await storeA.setBookmarkFolder("folder", "Reading");

    const staleStarted = deferred<void>();
    const staleResult = deferred<{
      posts: Post[];
      ids: string[];
      missing: [];
      complete: boolean;
    }>();
    const stalePost = makePost({ text: "stale snapshot" });
    const recoveredPost = makePost({ text: "recovered snapshot" });
    let scans = 0;
    xapi.onGetBookmarksByFolder = () => {
      scans += 1;
      if (scans === 1) {
        staleStarted.resolve();
        return staleResult.promise;
      }
      return {
        posts: [recoveredPost],
        ids: [recoveredPost.id],
        missing: [],
        complete: true,
      };
    };

    const stale = appA.request("/api/bookmarks/sync", { method: "POST" });
    await staleStarted.promise;
    setSystemTime(new Date(started.getTime() + BOOKMARK_SYNC_LEASE_MS));
    const recovered = await appB.request("/api/bookmarks/sync", { method: "POST" });
    expect(recovered.status).toBe(200);

    staleResult.resolve({
      posts: [stalePost],
      ids: [stalePost.id],
      missing: [],
      complete: true,
    });
    const staleResponse = await stale;
    expect(staleResponse.status).toBe(409);
    expect(await storeB.getPost(stalePost.id)).toBeNull();
    expect((await storeB.listSavedItems()).map((item) => item.postId)).toEqual([
      recoveredPost.id,
    ]);
  });

  it("renews at each outbound boundary so a live long scan cannot be recovered", async () => {
    const started = new Date("2024-06-01T12:00:00.000Z");
    setSystemTime(started);
    const driver = await bunDriver(":memory:");
    const store = new SqlStore(driver);
    const contender = new SqlStore(driver);
    const xapi = new FakeXApi();
    const app = buildApp({ store, xapi, maxPosts: 500, oauth: TEST_OAUTH });
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: started.getTime() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account",
    });
    await store.setBookmarkFolder("folder", "Reading");

    xapi.onGetBookmarksByFolder = async (_token, _userId, _folderId, opts) => {
      setSystemTime(new Date(started.getTime() + 30_000));
      await opts?.beforeRequest?.();
      setSystemTime(new Date(started.getTime() + BOOKMARK_SYNC_LEASE_MS));
      expect(
        await contender.beginBookmarkSync(
          "folder",
          "contender",
          Date.now() + BOOKMARK_SYNC_LEASE_MS,
          Date.now(),
        ),
      ).toBe(false);
      return { posts: [], ids: [], missing: [], complete: true };
    };

    expect((await app.request("/api/bookmarks/sync", { method: "POST" })).status).toBe(200);
  });

  it("releases its owner after an X failure so an immediate retry can run", async () => {
    const { app, xapi } = await makeAuthedApp();
    expect((await selectFolder(app, "folder", "Reading")).status).toBe(200);
    let scans = 0;
    xapi.onGetBookmarksByFolder = () => {
      scans += 1;
      if (scans === 1) throw new XApiError("temporary bookmark failure", 503);
      return { posts: [], ids: [], missing: [], complete: true };
    };

    expect((await app.request("/api/bookmarks/sync", { method: "POST" })).status).toBe(502);
    expect((await app.request("/api/bookmarks/sync", { method: "POST" })).status).toBe(200);
    expect(xapi.count("getBookmarksByFolder")).toBe(2);
  });

  it("stops before a 21st outbound request and releases the lease", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    expect((await selectFolder(app, "folder", "Reading")).status).toBe(200);
    const posts = Array.from({ length: 1_000 }, (_, index) =>
      makePost({ text: `budget ${index}` }),
    );
    let scans = 0;
    xapi.onGetBookmarksByFolder = async (_token, _userId, _folderId, opts) => {
      scans += 1;
      if (scans > 1) return { posts: [], ids: [], missing: [], complete: true };
      // The wrapper modeled page one. Nine more pages plus one retry consume
      // eleven boundaries; the tenth hydration batch would be boundary 21.
      for (let request = 1; request <= 10; request++) await opts?.beforeRequest?.();
      return {
        posts,
        ids: posts.map((post) => post.id),
        missing: [],
        complete: true,
      };
    };

    const stopped = await app.request("/api/bookmarks/sync", { method: "POST" });
    expect(stopped.status).toBe(409);
    expect(await stopped.json()).toMatchObject({
      error: "bookmark sync exceeded its safe request budget; retry",
      cost: { posts: 1_900, billable: 1_900 },
    });
    expect(await store.listSavedItems()).toEqual([]);

    // The handled budget stop releases immediately rather than wedging until expiry.
    expect((await app.request("/api/bookmarks/sync", { method: "POST" })).status).toBe(200);
  });

  it("does not let a superseded scan overwrite a newer post snapshot", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const postId = "1796000000000000103";
    const stalePost = makePost({ id: postId, text: "older snapshot" });
    const currentPost = makePost({ id: postId, text: "newer snapshot" });
    const staleResult = deferred<{
      posts: Post[];
      ids: string[];
      missing: [];
      complete: boolean;
    }>();
    const staleStarted = deferred<void>();

    expect((await selectFolder(app, "folder-old", "Old folder")).status).toBe(200);
    xapi.onGetBookmarksByFolder = (_token, _userId, folderId) => {
      if (folderId === "folder-old") {
        staleStarted.resolve();
        return staleResult.promise;
      }
      return { posts: [currentPost], ids: [postId], missing: [], complete: true };
    };

    const stale = app.request("/api/bookmarks/sync", { method: "POST" });
    await staleStarted.promise;
    expect((await selectFolder(app, "folder-new", "New folder")).status).toBe(200);
    expect((await app.request("/api/bookmarks/sync", { method: "POST" })).status).toBe(200);

    staleResult.resolve({ posts: [stalePost], ids: [postId], missing: [], complete: true });
    expect((await stale).status).toBe(409);
    expect((await store.getPost(postId))?.text).toBe("newer snapshot");
  });

  it("invalidates an account's scan when a fresh OAuth grant replaces it", async () => {
    const { app, store, xapi } = await makeAuthedApp({ userId: "account-a" });
    const post = makePost({ id: "1796000000000000104" });
    const staleResult = deferred<{
      posts: Post[];
      ids: string[];
      missing: [];
      complete: boolean;
    }>();
    const staleStarted = deferred<void>();

    expect((await selectFolder(app, "folder-a", "Account A")).status).toBe(200);
    xapi.onGetBookmarksByFolder = () => {
      staleStarted.resolve();
      return staleResult.promise;
    };

    const stale = app.request("/api/bookmarks/sync", { method: "POST" });
    await staleStarted.promise;
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access-b",
      refreshToken: "refresh-b",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account-b",
    });
    staleResult.resolve({ posts: [post], ids: [post.id], missing: [], complete: true });

    expect((await stale).status).toBe(409);
    expect(await store.listSavedItems()).toEqual([]);
    expect(await store.getPost(post.id)).toBeNull();
  });
});

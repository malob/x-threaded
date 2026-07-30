import type { Hono } from "hono";
import { buildApp } from "../src/server/app";
import { bunDriver } from "../src/server/db/bun";
import { d1Driver } from "../src/server/db/d1";
import { SqlStore } from "../src/server/db/store";
import { SELF_ID, type OAuthConfig } from "../src/server/oauth";
import type { Storage } from "../src/server/storage";
import type { FetchedConversation } from "../src/server/xapi";
import type { Post } from "../src/shared/types";
import { FakeD1Database } from "./fake-d1";
import { FakeXApi } from "./fake-xapi";
import { makePost } from "./fixtures";

export interface TestAppOptions {
  maxPosts?: number;
  oauth?: OAuthConfig | null;
}

export interface TestApp {
  app: Hono;
  store: SqlStore;
  xapi: FakeXApi;
}

/** OAuth client credentials for a deployment that has user context configured. */
export const TEST_OAUTH: OAuthConfig = { clientId: "client", clientSecret: "secret" };

/** The user ID makePost attributes its posts to, so fixtures read as "ours". */
export const SELF_USER_ID = "100";

/**
 * The real routes over a real (in-memory) store and a throwing X API double.
 * Drive it with app.request(); nothing here can reach the network.
 */
export function makeTestApp(opts: TestAppOptions = {}): TestApp {
  const store = new SqlStore(bunDriver(":memory:"));
  const xapi = new FakeXApi();
  const app = buildApp({
    store,
    xapi,
    maxPosts: opts.maxPosts ?? 500,
    oauth: opts.oauth ?? null,
  });
  return { app, store, xapi };
}

/**
 * An app with OAuth configured and unexpired tokens stored, including the
 * cached user ID — so userContext() resolves without a refresh or a getMe and
 * any X call a test records is one the route itself chose to make.
 */
export async function makeAuthedApp(
  opts: TestAppOptions & { userId?: string } = {},
): Promise<TestApp> {
  const harness = makeTestApp({ ...opts, oauth: opts.oauth ?? TEST_OAUTH });
  await harness.store.putOAuthTokens(SELF_ID, {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
    scope: "tweet.read users.read bookmark.read",
    userId: opts.userId ?? SELF_USER_ID,
  });
  return harness;
}

/**
 * An authed app with a bookmark folder chosen and its enumeration canned, so
 * POST /api/bookmarks/sync runs end to end without touching the network.
 */
export async function makeBookmarkApp(
  folderPosts: Post[],
  complete: boolean,
  userId = "u1",
  /** Folder IDs the scan enumerated; defaults to the hydrated posts' ids. */
  folderIds?: string[],
): Promise<TestApp> {
  const harness = await makeAuthedApp({ userId });
  await harness.app.request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookmarkFolderId: "folder1", bookmarkFolderName: "Reading" }),
  });
  harness.xapi.onGetBookmarksByFolder = () => ({
    posts: folderPosts,
    ids: folderIds ?? folderPosts.map((p) => p.id),
    complete,
  });
  return harness;
}

/** The same SqlStore the Worker runs, over a fresh D1 stand-in. */
export function makeD1TestStore(): SqlStore {
  return new SqlStore(d1Driver(new FakeD1Database()));
}

/** POST /api/conversations with the usual JSON body. */
export async function fetchConversationRequest(
  app: Hono,
  url: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return await app.request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...extra }),
  });
}

/** Posts plus the conversation row — i.e. what a completed fetch leaves behind. */
export async function seedConversation(
  store: Storage,
  root: Post,
  replies: Post[] = [],
): Promise<void> {
  await store.upsertPosts([root, ...replies]);
  await store.upsertConversation({
    rootId: root.id,
    rootAuthorHandle: root.authorHandle,
    rootText: root.text,
    rootCreatedAt: root.createdAt,
    fetchedAt: new Date().toISOString(),
  });
}

/** The method names of every X call the route made, in order. */
export function methods(xapi: { calls: { method: string }[] }): string[] {
  return xapi.calls.map((call) => call.method);
}

/** The `ids` argument of each getPostsByIds call, in order. */
export function idsRequested(xapi: FakeXApi): string[][] {
  return xapi.calls
    .filter((call) => call.method === "getPostsByIds")
    .map((call) => call.args[0] as string[]);
}

export function replyTo(root: Post, overrides: Partial<Post> = {}): Post {
  return makePost({ conversationId: root.id, parentId: root.id, ...overrides });
}

/** A FetchedConversation, with the fields a test doesn't care about defaulted. */
export function fetchResult(
  posts: Post[],
  extra: Partial<FetchedConversation> = {},
): FetchedConversation {
  return { posts, referenced: [], truncated: false, ...extra };
}

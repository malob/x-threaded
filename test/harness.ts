import { buildApp, type ApiApp } from "../src/server/app";
import { bunDriver } from "../src/server/db/bun";
import { d1Driver } from "../src/server/db/d1";
import { SqlStore } from "../src/server/db/store";
import { SELF_ID, type OAuthConfig } from "../src/server/oauth";
import type { Storage } from "../src/server/storage";
import type { ConversationPage } from "../src/server/xapi";
import { ACCOUNT_GENERATION_HEADER, type Post } from "../src/shared/types";
import { FakeD1Database } from "./fake-d1";
import { FakeXApi } from "./fake-xapi";
import { makePost } from "./fixtures";

export interface TestAppOptions {
  maxPosts?: number;
  oauth?: OAuthConfig | null;
}

export interface TestApp {
  app: ApiApp;
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
export async function makeTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const store = new SqlStore(await bunDriver(":memory:"));
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
  const harness = await makeTestApp({ ...opts, oauth: opts.oauth ?? TEST_OAUTH });
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
  // Fixture setup bypasses the staged-switch API: its X scan is what the
  // route under test is about, and this helper starts from an already active
  // selection.
  await harness.store.setBookmarkFolder("folder1", "Reading");
  const ids = folderIds ?? folderPosts.map((p) => p.id);
  const hydrated = new Set(folderPosts.map((p) => p.id));
  harness.xapi.onGetBookmarksByFolder = () => ({
    posts: folderPosts,
    ids,
    // Derived the way the real client derives it: enumerated but not hydrated.
    missing: ids.filter((id) => !hydrated.has(id)).map((id) => ({ id })),
    complete,
  });
  return harness;
}

/** The same SqlStore the Worker runs, over a fresh D1 stand-in. */
export async function makeD1TestStore(): Promise<SqlStore> {
  return new SqlStore(d1Driver(await FakeD1Database.create()));
}

/** Test-only admission helper for routes bound to the browser's account namespace. */
export async function accountRequest(
  app: ApiApp,
  store: Storage,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const generation = await store.getOrCreateAccountGeneration(SELF_ID, crypto.randomUUID());
  const headers = new Headers(init.headers);
  headers.set(ACCOUNT_GENERATION_HEADER, generation);
  return await app.request(path, { ...init, headers });
}

/** Attach a generation already read before a query-count reset. */
export function withAccountGeneration(
  accountGeneration: string,
  init: RequestInit = {},
): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(ACCOUNT_GENERATION_HEADER, accountGeneration);
  return { ...init, headers };
}

/** POST /api/conversations with the usual JSON body. */
export async function fetchConversationRequest(
  app: ApiApp,
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
  const now = new Date().toISOString();
  await store.upsertPosts([root, ...replies]);
  await store.upsertConversation({
    rootId: root.id,
    rootAuthorHandle: root.authorHandle,
    rootText: root.text,
    rootCreatedAt: root.createdAt,
    fetchedAt: now,
    status: "complete",
    fullReadAt: now,
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

/**
 * One search page, with the fields a test doesn't care about defaulted. No
 * `nextToken` means the search is exhausted, which is what makes a fetch
 * driven by this land as a complete conversation.
 */
export function searchPage(posts: Post[], extra: Partial<ConversationPage> = {}): ConversationPage {
  return { posts, referenced: [], unresolvedMediaIds: [], ...extra };
}

/**
 * Serve a canned sequence of search pages. A request past the end throws
 * rather than returning an empty page: "it asked for one page too many" is
 * exactly what these tests catch, and against the real API that page costs
 * money.
 */
export function servePages(xapi: FakeXApi, pages: ConversationPage[]): void {
  let served = 0;
  xapi.onSearchConversationPage = () => {
    const page = pages[served++];
    if (!page) throw new Error(`unexpected search page request #${served}`);
    return page;
  };
}

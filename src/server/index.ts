import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { Store } from "./db";
import { parsePostUrl } from "./urls";
import { XApi, XApiError, type FetchedConversation } from "./xapi";
import type {
  ConversationListResponse,
  ConversationResponse,
  Post,
  RefreshResponse,
} from "../shared/types";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? "data/x-threaded.sqlite";
const maxPosts = Number(process.env.MAX_POSTS_PER_FETCH ?? 500);
const bearerToken = process.env.X_BEARER_TOKEN;

if (!bearerToken) {
  console.error("X_BEARER_TOKEN is not set; refusing to start.");
  process.exit(1);
}

const store = new Store(dbPath);
const xapi = new XApi(bearerToken);

function conversationResponse(
  rootId: string,
  focusId: string | null,
  opts: { truncated?: boolean; fromCache: boolean },
): ConversationResponse {
  const posts = store.getPosts(rootId);
  return {
    rootId,
    focusId,
    posts,
    quoted: store.getQuotedFor(posts),
    unreadIds: store.getUnreadIds(rootId),
    truncated: opts.truncated ?? false,
    fromCache: opts.fromCache,
  };
}

/** Resolve quoted posts two levels deep; anything deeper renders as a link. */
async function resolveQuotedPosts(all: Post[], byId: Map<string, Post>): Promise<void> {
  let sources = all;
  for (let level = 0; level < 2; level++) {
    const ids = [
      ...new Set(sources.map((p) => p.quotedPostId).filter((id): id is string => id !== null)),
    ];
    const missing = ids.filter((id) => !byId.has(id) && !store.hasPost(id));
    if (missing.length > 0) {
      const fetched = await xapi.getPostsByIds(missing);
      for (const post of fetched) byId.set(post.id, post);
      store.upsertPosts(fetched);
    }
    sources = ids
      .map((id) => byId.get(id) ?? store.getPost(id))
      .filter((p): p is Post => p !== null && p !== undefined);
  }
}

/** Upsert a fetch result (posts + referenced) and resolve its quotes. */
async function ingest(fetched: FetchedConversation, extra: Post[] = []): Promise<void> {
  const byId = new Map(fetched.posts.map((p) => [p.id, p]));
  for (const post of extra) if (!byId.has(post.id)) byId.set(post.id, post);
  for (const post of fetched.referenced) if (!byId.has(post.id)) byId.set(post.id, post);
  const all = [...byId.values()];
  store.upsertPosts(all);
  await resolveQuotedPosts(all, byId);
}

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof XApiError) {
    console.error(`X API error (${err.status}): ${err.message}`);
    return c.json({ error: err.message }, err.status === 404 ? 404 : 502);
  }
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.get("/api/conversations", (c) => {
  const roots: Post[] = [];
  const conversations = store
    .listConversations()
    .flatMap((row) => {
      const root = store.getPost(row.rootId);
      if (!root) return [];
      roots.push(root);
      return [{ root, postCount: row.postCount, unreadCount: row.unreadCount, fetchedAt: row.fetchedAt }];
    });
  const response: ConversationListResponse = { conversations, quoted: store.getQuotedFor(roots) };
  return c.json(response);
});

app.get("/api/conversations/:rootId", (c) => {
  const rootId = c.req.param("rootId");
  if (!store.hasConversation(rootId)) {
    return c.json({ error: "conversation not cached" }, 404);
  }
  return c.json(conversationResponse(rootId, null, { fromCache: true }));
});

app.post("/api/conversations", async (c) => {
  const body = await c.req.json<{ url?: string; force?: boolean }>();
  const postId = body.url ? parsePostUrl(body.url) : null;
  if (!postId) {
    return c.json({ error: "could not parse a post URL or ID from input" }, 400);
  }

  const requested = await xapi.getPost(postId);
  const rootId = requested.conversationId;
  const focusId = postId === rootId ? null : postId;
  const firstFetch = !store.hasConversation(rootId);

  if (!firstFetch && !body.force) {
    return c.json(conversationResponse(rootId, focusId, { fromCache: true }));
  }

  const fetched = await xapi.fetchConversation(rootId, maxPosts);
  const root =
    fetched.posts.find((p) => p.id === rootId) ??
    fetched.referenced.find((p) => p.id === rootId) ??
    (requested.id === rootId ? requested : await xapi.getPost(rootId));

  store.upsertConversation({
    rootId,
    rootAuthorHandle: root.authorHandle,
    rootText: root.text,
    rootCreatedAt: root.createdAt,
    fetchedAt: new Date().toISOString(),
  });
  await ingest(fetched, [requested, root]);

  // A conversation you just pulled up is one you're about to read; unread is
  // reserved for posts that arrive later.
  if (firstFetch) store.markConversationRead(rootId);

  return c.json(conversationResponse(rootId, focusId, { truncated: fetched.truncated, fromCache: false }));
});

app.post("/api/conversations/:rootId/refresh", async (c) => {
  const rootId = c.req.param("rootId");
  const meta = store.getConversationMeta(rootId);
  if (!meta) {
    return c.json({ error: "conversation not cached" }, 404);
  }

  const before = store.existingPostIds(rootId);
  // Post reads deduplicate within a UTC day, so a full re-read on the same day
  // as the last one is free and refreshes metrics; otherwise fetch only new
  // posts via since_id.
  const sameUtcDay = meta.fetchedAt.slice(0, 10) === new Date().toISOString().slice(0, 10);
  let truncated = false;

  if (sameUtcDay) {
    const fetched = await xapi.fetchConversation(rootId, maxPosts);
    await ingest(fetched);
    store.upsertConversation({ rootId, ...meta, fetchedAt: new Date().toISOString() });
    truncated = fetched.truncated;
  } else {
    const sinceId = store.newestPostId(rootId);
    const fetched = await xapi.fetchConversation(rootId, maxPosts, sinceId ?? undefined);
    await ingest(fetched);
  }

  const newCount = store.existingPostIds(rootId).size - before.size;
  const response: RefreshResponse = {
    ...conversationResponse(rootId, null, { truncated, fromCache: false }),
    newCount,
    metricsUpdated: sameUtcDay,
  };
  return c.json(response);
});

app.post("/api/conversations/:rootId/read", (c) => {
  const rootId = c.req.param("rootId");
  if (!store.hasConversation(rootId)) {
    return c.json({ error: "conversation not cached" }, 404);
  }
  store.markConversationRead(rootId);
  return c.json({ ok: true });
});

app.post("/api/read-state", async (c) => {
  const body = await c.req.json<{ postIds?: string[]; read?: boolean }>();
  if (!Array.isArray(body.postIds) || typeof body.read !== "boolean") {
    return c.json({ error: "expected { postIds: string[], read: boolean }" }, 400);
  }
  store.setReadState(body.postIds, body.read);
  return c.json({ ok: true });
});

app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

console.log(`x-threaded server listening on http://localhost:${port}`);

export default { port, fetch: app.fetch };

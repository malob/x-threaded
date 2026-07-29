import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { Store } from "./db";
import { parsePostUrl } from "./urls";
import { XApi, XApiError } from "./xapi";
import type { ConversationResponse, Post } from "../shared/types";

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
  return c.json(store.listConversations());
});

app.get("/api/conversations/:rootId", (c) => {
  const rootId = c.req.param("rootId");
  if (!store.hasConversation(rootId)) {
    return c.json({ error: "conversation not cached" }, 404);
  }
  const posts = store.getPosts(rootId);
  const response: ConversationResponse = {
    rootId,
    focusId: null,
    posts,
    quoted: store.getQuotedFor(posts),
    truncated: false,
    fromCache: true,
  };
  return c.json(response);
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

  if (store.hasConversation(rootId) && !body.force) {
    const posts = store.getPosts(rootId);
    const response: ConversationResponse = {
      rootId,
      focusId,
      posts,
      quoted: store.getQuotedFor(posts),
      truncated: false,
      fromCache: true,
    };
    return c.json(response);
  }

  const { posts, referenced, truncated } = await xapi.fetchConversation(rootId, maxPosts);

  const byId = new Map(posts.map((p) => [p.id, p]));
  if (!byId.has(requested.id)) byId.set(requested.id, requested);
  let root = byId.get(rootId);
  if (!root) {
    root = referenced.find((p) => p.id === rootId) ?? (await xapi.getPost(rootId));
    byId.set(rootId, root);
  }

  for (const post of referenced) {
    if (!byId.has(post.id)) byId.set(post.id, post);
  }

  const all = [...byId.values()];
  store.upsertConversation({
    rootId,
    rootAuthorHandle: root.authorHandle,
    rootText: root.text,
    rootCreatedAt: root.createdAt,
    fetchedAt: new Date().toISOString(),
  });
  store.upsertPosts(all);

  // Resolve quoted posts two levels deep (a quote card and one nested card);
  // anything deeper renders as a link.
  let quoteSources: Post[] = all;
  for (let level = 0; level < 2; level++) {
    const ids = [
      ...new Set(quoteSources.map((p) => p.quotedPostId).filter((id): id is string => id !== null)),
    ];
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const fetched = await xapi.getPostsByIds(missing);
      for (const post of fetched) byId.set(post.id, post);
      store.upsertPosts(fetched);
    }
    quoteSources = ids
      .map((id) => byId.get(id))
      .filter((p): p is Post => p !== undefined);
  }

  const stored = store.getPosts(rootId);
  const response: ConversationResponse = {
    rootId,
    focusId,
    posts: stored,
    quoted: store.getQuotedFor(stored),
    truncated,
    fromCache: false,
  };
  return c.json(response);
});

app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

console.log(`x-threaded server listening on http://localhost:${port}`);

export default { port, fetch: app.fetch };

import { Hono } from "hono";
import type {
  ConversationListResponse,
  ConversationResponse,
  Post,
  RefreshResponse,
} from "../shared/types";
import { getQuotedFor, type Storage } from "./storage";
import { parsePostUrl } from "./urls";
import { XApiError, type FetchedConversation, type XApi } from "./xapi";

export interface AppDeps {
  store: Storage;
  xapi: XApi;
  /** Safety cap on posts fetched per conversation load. */
  maxPosts: number;
}

/** The API routes, independent of runtime (Bun server or Cloudflare Worker). */
export function buildApp({ store, xapi, maxPosts }: AppDeps): Hono {
  async function conversationResponse(
    rootId: string,
    focusId: string | null,
    opts: { truncated?: boolean; fromCache: boolean },
  ): Promise<ConversationResponse> {
    const posts = await store.getPosts(rootId);
    return {
      rootId,
      focusId,
      posts,
      quoted: await getQuotedFor(store, posts),
      unreadIds: await store.getUnreadIds(rootId),
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
      const missing: string[] = [];
      for (const id of ids) {
        if (!byId.has(id) && !(await store.hasPost(id))) missing.push(id);
      }
      if (missing.length > 0) {
        const fetched = await xapi.getPostsByIds(missing);
        for (const post of fetched) byId.set(post.id, post);
        await store.upsertPosts(fetched);
      }
      const resolved: Post[] = [];
      for (const id of ids) {
        const post = byId.get(id) ?? (await store.getPost(id));
        if (post) resolved.push(post);
      }
      sources = resolved;
    }
  }

  /** Upsert a fetch result (posts + referenced) and resolve its quotes. */
  async function ingest(fetched: FetchedConversation, extra: Post[] = []): Promise<void> {
    const byId = new Map(fetched.posts.map((p) => [p.id, p]));
    for (const post of extra) if (!byId.has(post.id)) byId.set(post.id, post);
    for (const post of fetched.referenced) if (!byId.has(post.id)) byId.set(post.id, post);
    const all = [...byId.values()];
    await store.upsertPosts(all);
    await resolveQuotedPosts(all, byId);
  }

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof XApiError) {
      console.error(`X API error (${err.status}): ${err.message}`);
      return c.json({ error: err.message }, err.status === 404 ? 404 : 502);
    }
    console.error(err);
    return c.json({ error: (err as Error).message }, 500);
  });

  // Resolve a post ID to its cached conversation, without touching the X API.
  // null means the conversation isn't cached; the client offers to fetch it.
  app.get("/api/resolve/:postId", async (c) => {
    const post = await store.getPost(c.req.param("postId"));
    const rootId =
      post && (await store.hasConversation(post.conversationId)) ? post.conversationId : null;
    return c.json({ rootId });
  });

  app.get("/api/conversations", async (c) => {
    const roots: Post[] = [];
    const conversations = [];
    for (const row of await store.listConversations()) {
      const root = await store.getPost(row.rootId);
      if (!root) continue;
      roots.push(root);
      conversations.push({
        root,
        postCount: row.postCount,
        unreadCount: row.unreadCount,
        fetchedAt: row.fetchedAt,
      });
    }
    const response: ConversationListResponse = {
      conversations,
      quoted: await getQuotedFor(store, roots),
    };
    return c.json(response);
  });

  app.get("/api/conversations/:rootId", async (c) => {
    const rootId = c.req.param("rootId");
    if (!(await store.hasConversation(rootId))) {
      return c.json({ error: "conversation not cached" }, 404);
    }
    return c.json(await conversationResponse(rootId, null, { fromCache: true }));
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
    const firstFetch = !(await store.hasConversation(rootId));

    if (!firstFetch && !body.force) {
      return c.json(await conversationResponse(rootId, focusId, { fromCache: true }));
    }

    const fetched = await xapi.fetchConversation(rootId, maxPosts);
    const root =
      fetched.posts.find((p) => p.id === rootId) ??
      fetched.referenced.find((p) => p.id === rootId) ??
      (requested.id === rootId ? requested : await xapi.getPost(rootId));

    await store.upsertConversation({
      rootId,
      rootAuthorHandle: root.authorHandle,
      rootText: root.text,
      rootCreatedAt: root.createdAt,
      fetchedAt: new Date().toISOString(),
    });
    await ingest(fetched, [requested, root]);

    // A conversation you just pulled up is one you're about to read; unread is
    // reserved for posts that arrive later.
    if (firstFetch) await store.markConversationRead(rootId);

    return c.json(
      await conversationResponse(rootId, focusId, {
        truncated: fetched.truncated,
        fromCache: false,
      }),
    );
  });

  app.post("/api/conversations/:rootId/refresh", async (c) => {
    const rootId = c.req.param("rootId");
    const meta = await store.getConversationMeta(rootId);
    if (!meta) {
      return c.json({ error: "conversation not cached" }, 404);
    }

    const before = await store.existingPostIds(rootId);
    // Post reads deduplicate within a UTC day, so a full re-read on the same
    // day as the last one is free and refreshes metrics; otherwise fetch only
    // new posts via since_id.
    const sameUtcDay = meta.fetchedAt.slice(0, 10) === new Date().toISOString().slice(0, 10);
    let truncated = false;

    if (sameUtcDay) {
      const fetched = await xapi.fetchConversation(rootId, maxPosts);
      await ingest(fetched);
      await store.upsertConversation({ rootId, ...meta, fetchedAt: new Date().toISOString() });
      truncated = fetched.truncated;
    } else {
      const sinceId = await store.newestPostId(rootId);
      const fetched = await xapi.fetchConversation(rootId, maxPosts, sinceId ?? undefined);
      await ingest(fetched);
    }

    const newCount = (await store.existingPostIds(rootId)).size - before.size;
    const response: RefreshResponse = {
      ...(await conversationResponse(rootId, null, { truncated, fromCache: false })),
      newCount,
      metricsUpdated: sameUtcDay,
    };
    return c.json(response);
  });

  app.post("/api/conversations/:rootId/read", async (c) => {
    const rootId = c.req.param("rootId");
    if (!(await store.hasConversation(rootId))) {
      return c.json({ error: "conversation not cached" }, 404);
    }
    await store.markConversationRead(rootId);
    return c.json({ ok: true });
  });

  app.post("/api/read-state", async (c) => {
    const body = await c.req.json<{ postIds?: string[]; read?: boolean }>();
    if (!Array.isArray(body.postIds) || typeof body.read !== "boolean") {
      return c.json({ error: "expected { postIds: string[], read: boolean }" }, 400);
    }
    await store.setReadState(body.postIds, body.read);
    return c.json({ ok: true });
  });

  return app;
}

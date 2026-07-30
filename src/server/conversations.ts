import { POST_READ_USD } from "../shared/pricing";
import type { ConversationResponse, Post } from "../shared/types";
import { getQuotedFor, type Storage } from "./storage";
import type { FetchedConversation, XApiClient } from "./xapi";

/** Everything a client needs to render a conversation, read from the store. */
export async function conversationResponse(
  store: Storage,
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
export async function resolveQuotedPosts(
  store: Storage,
  xapi: XApiClient,
  all: Post[],
  byId: Map<string, Post>,
): Promise<void> {
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

/**
 * Upsert a fetch result (posts + referenced) and resolve its quotes.
 * Returns what it actually cost: posts we hadn't already read today, since
 * same-day re-reads don't bill.
 */
export async function ingest(
  store: Storage,
  xapi: XApiClient,
  fetched: FetchedConversation,
  extra: Post[] = [],
): Promise<{ posts: number; billable: number; usd: number }> {
  const byId = new Map(fetched.posts.map((p) => [p.id, p]));
  for (const post of extra) if (!byId.has(post.id)) byId.set(post.id, post);
  for (const post of fetched.referenced) if (!byId.has(post.id)) byId.set(post.id, post);
  const all = [...byId.values()];
  // Check before upserting: writing the posts overwrites fetched_at.
  const free = await store.postIdsReadToday(all.map((p) => p.id));
  await store.upsertPosts(all);
  await resolveQuotedPosts(store, xapi, all, byId);
  const billable = all.length - free.size;
  return { posts: all.length, billable, usd: billable * POST_READ_USD };
}

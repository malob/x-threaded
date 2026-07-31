import { postReads } from "../shared/pricing";
import type { ConversationResponse, Post } from "../shared/types";
import type { SpendMeter } from "./meter";
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

/**
 * Resolve quoted posts two levels deep; anything deeper renders as a link.
 * Each level that has to be bought is a lookup, and it bills — which is why
 * the meter is threaded down here rather than reconstructed upstairs.
 */
export async function resolveQuotedPosts(
  store: Storage,
  xapi: XApiClient,
  meter: SpendMeter,
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
      const fetched = meter.charge(await xapi.getPostsByIds(missing));
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
 *
 * Two things reach the meter here: the credit for posts the fetch paid for
 * that we had already read today, and whatever the quote resolution buys.
 * The fetch's own receipt is charged by its caller, at the call — a rule that
 * keeps the accounting right when the next line throws.
 */
export async function ingest(
  store: Storage,
  xapi: XApiClient,
  meter: SpendMeter,
  fetched: FetchedConversation,
  extra: Post[] = [],
): Promise<void> {
  const byId = new Map(fetched.posts.map((p) => [p.id, p]));
  for (const post of extra) if (!byId.has(post.id)) byId.set(post.id, post);
  for (const post of fetched.referenced) if (!byId.has(post.id)) byId.set(post.id, post);
  const all = [...byId.values()];
  // Check before upserting: writing the posts overwrites fetched_at, and every
  // one of them would then read as already-read-today.
  //
  // Only the fetch's own posts are credited. An `extra` came either from the
  // store, which never charged for it, or from a lookup that charged
  // separately — crediting those would net out a read someone paid for.
  const fetchedIds = [...fetched.posts, ...fetched.referenced].map((p) => p.id);
  const free = await store.postIdsReadToday([...new Set(fetchedIds)]);
  meter.credit(postReads(free.size));
  await store.upsertPosts(all);
  await resolveQuotedPosts(store, xapi, meter, all, byId);
}

import { postReads } from "../shared/pricing";
import type { ConversationResponse, Post } from "../shared/types";
import type { SpendMeter } from "./meter";
import { getQuotedFor, type Storage } from "./storage";
import type { PostLookupOptions, XApiClient } from "./xapi";

export interface QuoteResolutionOptions extends PostLookupOptions {
  /** Ownership/write marker after X answers and immediately before its posts persist. */
  beforePersist?: (posts: Post[]) => void | Promise<void>;
}

/**
 * Everything a client needs to render a conversation, read from the store.
 *
 * `truncated` comes from the stored status, never from whatever the fetch in
 * this request happened to report: incompleteness outlives the request that
 * discovered it, and a cached read that forgets it is a cache claiming to be
 * whole (2026-07-30 review, H2).
 */
export async function conversationResponse(
  store: Storage,
  rootId: string,
  focusId: string | null,
  opts: { fromCache: boolean },
): Promise<ConversationResponse> {
  // The lifecycle flag and posts must come from one database snapshot. Either
  // ordering of two independent reads has an unsafe direction: posts→meta can
  // label a pre-finish subset complete, while meta→posts can keep an old
  // complete flag after a refresh has claimed partial and appended one page.
  const snapshot = await store.getConversationResponseSnapshot(rootId);
  const posts = snapshot?.posts ?? [];
  return {
    rootId,
    focusId,
    posts,
    quoted: await getQuotedFor(store, posts),
    unreadIds: await store.getUnreadIds(rootId),
    truncated: snapshot?.status === "partial",
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
  lookup: QuoteResolutionOptions = {},
): Promise<void> {
  let sources = all;
  for (let level = 0; level < 2; level++) {
    const ids = [
      ...new Set(sources.map((p) => p.quotedPostId).filter((id): id is string => id !== null)),
    ];
    const candidates = ids.filter((id) => !byId.has(id));
    if (candidates.length > 0) {
      // One set read per level, not hasPost()+getPost() for every quote. D1's
      // query allowance belongs to the whole Worker invocation, and a page of
      // distinct quote cards must not consume it one row at a time.
      for (const post of await store.getPostsByIds(candidates)) byId.set(post.id, post);
    }
    const missing = candidates.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      // Quote ids the lookup couldn't return are dropped here: the card
      // simply doesn't resolve and the post falls back to its t.co link.
      const fetched = meter.charge(await xapi.getPostsByIds(missing, lookup)).posts;
      for (const post of fetched) byId.set(post.id, post);
      // The request-side check happened before X and may now be several
      // minutes old. Re-check after the paid response, and mark the durable
      // write before touching the store, so a recovered owner cannot have its
      // newer quote snapshot overwritten by this stale result.
      await lookup.beforePersist?.(fetched);
      await store.upsertPosts(fetched);
    }
    sources = ids.flatMap((id) => {
      const post = byId.get(id);
      return post ? [post] : [];
    });
  }
}

/**
 * Store what one search page returned, crediting the reads X's same-day dedup
 * covers.
 *
 * Check before upserting: writing the posts overwrites `fetched_at`, and every
 * one of them would then read as already-read-today — the credit would swallow
 * the whole bill and every fetch would report itself free.
 *
 * Only posts a page actually returned belong here. A post the caller already
 * held came either from the store, which never charged for it, or from a
 * lookup that charged separately; crediting those would net out a read someone
 * paid for.
 */
export async function persistFetchedPosts(
  store: Storage,
  meter: SpendMeter,
  posts: Post[],
): Promise<void> {
  if (posts.length === 0) return;
  // First occurrence wins, and callers pass a page's results before its
  // includes: X attaches media only to the results, so the same post arriving
  // in both is fuller as a result than as someone else's referenced parent.
  const byId = new Map<string, Post>();
  for (const post of posts) if (!byId.has(post.id)) byId.set(post.id, post);
  const free = await store.postIdsReadToday([...byId.keys()]);
  meter.credit(postReads(free.size));
  await store.upsertPosts([...byId.values()]);
}

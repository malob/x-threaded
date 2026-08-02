import type { OwnThread, Post } from "../shared/types";
import type { SpendMeter } from "./meter";
import type { Storage } from "./storage";
import type { XApiClient } from "./xapi";

/**
 * How many posts the thread itself is: the root plus its chain of
 * self-replies. Counting every post the author has in the conversation
 * would fold in their replies to other people — one two-post thread that
 * sparked a long discussion measured 21 that way.
 *
 * The renderer walks the same spine independently (`buildThreadModel` in
 * src/web/thread/model.ts) and the two can disagree, so this number is a
 * label rather than a promise about what the reader will see. Two known
 * divergences: on a forked self-reply this keeps the *last* candidate for a
 * given parent (byParent overwrites) while the renderer takes the *earliest*
 * child; and this walks only the timeline posts it was handed, so a
 * self-reply the scan didn't return truncates the chain here but not there.
 * Change one and check the other.
 */
export function spineLength(root: Post, ownPosts: Post[]): number {
  const byParent = new Map<string, Post>();
  for (const post of ownPosts) {
    if (post.parentId) byParent.set(post.parentId, post);
  }
  let length = 1;
  let current = root;
  for (;;) {
    const next = byParent.get(current.id);
    if (!next) return length;
    length++;
    current = next;
  }
}

/** Group the user's posts into threads they started, newest activity first. */
export async function groupOwnThreads(
  store: Storage,
  xapi: XApiClient,
  meter: SpendMeter,
  posts: Post[],
  userId: string,
): Promise<OwnThread[]> {
  const byConversation = new Map<string, Post[]>();
  for (const post of posts) {
    const group = byConversation.get(post.conversationId) ?? [];
    group.push(post);
    byConversation.set(post.conversationId, group);
  }

  // Roots the scan didn't return, read from the store in one query rather
  // than one per conversation: this runs inside the pagination loop, so a
  // per-row lookup is a sequential D1 round trip per thread per page
  // (2026-07-30 review, S3).
  const wanted = [...byConversation]
    .filter(([conversationId, group]) => !group.some((p) => p.id === conversationId))
    .map(([conversationId]) => conversationId);
  const roots = new Map((await store.getPostsByIds(wanted)).map((p) => [p.id, p]));

  // Roots older than the scan window aren't cached either; pull those from X
  // in one batch, then read them back the way every other root arrives here.
  // A lookup, not an Owned Read: the timeline's rate doesn't apply off it.
  // A root the lookup can't return (deleted, went private) just leaves its
  // thread grouped without one, same as before the fetch.
  const missing = wanted.filter((id) => !roots.has(id));
  if (missing.length > 0) {
    await store.upsertPosts(meter.charge(await xapi.getPostsByIds(missing)).posts);
    for (const post of await store.getPostsByIds(missing)) roots.set(post.id, post);
  }

  const found: { conversationId: string; root: Post; group: Post[] }[] = [];
  for (const [conversationId, group] of byConversation) {
    const root = group.find((p) => p.id === conversationId) ?? roots.get(conversationId);
    // Conversations rooted by someone else are replies into their threads,
    // not the user's own posts.
    if (!root || root.authorId !== userId) continue;
    found.push({ conversationId, root, group });
  }

  const loaded = await store.hasConversations(found.map((f) => f.conversationId));
  const items: OwnThread[] = found.map(({ conversationId, root, group }) => ({
    root,
    ownPostCount: spineLength(root, group),
    latestAt: group.reduce(
      (latest, p) => (p.createdAt > latest ? p.createdAt : latest),
      group[0]!.createdAt,
    ),
    loaded: loaded.has(conversationId),
  }));
  items.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  return items;
}

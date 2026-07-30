import type { OwnThread, Post } from "../shared/types";
import type { Storage } from "./storage";
import type { XApiClient } from "./xapi";

/**
 * How many posts the thread itself is: the root plus its chain of
 * self-replies. Counting every post the author has in the conversation
 * would fold in their replies to other people — one two-post thread that
 * sparked a long discussion measured 21 that way.
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
  posts: Post[],
  userId: string,
): Promise<OwnThread[]> {
  const byConversation = new Map<string, Post[]>();
  for (const post of posts) {
    const group = byConversation.get(post.conversationId) ?? [];
    group.push(post);
    byConversation.set(post.conversationId, group);
  }

  // Roots older than the scan window aren't in the timeline response; pull
  // any we don't already have in one batch.
  const missing: string[] = [];
  for (const [conversationId, group] of byConversation) {
    const known =
      group.some((p) => p.id === conversationId) || (await store.hasPost(conversationId));
    if (!known) missing.push(conversationId);
  }
  if (missing.length > 0) {
    await store.upsertPosts(await xapi.getPostsByIds(missing));
  }

  const items: OwnThread[] = [];
  for (const [conversationId, group] of byConversation) {
    const root =
      group.find((p) => p.id === conversationId) ?? (await store.getPost(conversationId));
    // Conversations rooted by someone else are replies into their threads,
    // not the user's own posts.
    if (!root || root.authorId !== userId) continue;
    const latestAt = group.reduce(
      (latest, p) => (p.createdAt > latest ? p.createdAt : latest),
      group[0]!.createdAt,
    );
    items.push({
      root,
      ownPostCount: spineLength(root, group),
      latestAt,
      loaded: await store.hasConversation(conversationId),
    });
  }
  items.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  return items;
}

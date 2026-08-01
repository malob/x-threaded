import type { Post } from "../shared/types";
import { persistFetchedPosts, resolveQuotedPosts } from "./conversations";
import type { SpendMeter } from "./meter";
import type { ConversationStatus, Storage } from "./storage";
import {
  conversationStartTime,
  MIN_SEARCH_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
  type XApiClient,
} from "./xapi";

/**
 * Reading a conversation into the store, page by page.
 *
 * This sits between the routes and the X gateway because a fetch is a
 * transaction with money in it, and the two halves belong to different layers:
 * the gateway knows the wire and what a response billed, this knows what is
 * worth buying and what has to survive a failure (2026-07-30 review, H2/H3).
 *
 * The invariant it maintains: **every page is in the store before the next one
 * is asked for, and the row says `partial` until a run proves otherwise.** So
 * a fetch that dies on page five leaves four pages of posts and a conversation
 * that knows it is missing history — which the resume path can go back for —
 * rather than either nothing at all or a cache quietly claiming to be whole.
 */

export interface ConversationFetchOptions {
  /** Cap on posts this run may read; the API's 10-result floor rounds it down. */
  maxPosts: number;
  /** Only posts newer than this: a refresh looking for replies that arrived. */
  sinceId?: string;
  /** Only posts older than this: resuming the history a stopped run skipped. */
  untilId?: string;
  /**
   * Posts the caller already holds — the pasted post, typically. They are
   * stored with the run and can spare it a paid lookup for the root, but they
   * are not billed to it: they came from the store, or from a call that
   * charged for them itself.
   */
  known?: Post[];
}

export interface ConversationRun {
  /** Where the conversation stands now, as written to the row. */
  status: ConversationStatus;
  /** The root, as the run finally resolved it. */
  root: Post;
}

/** How many empty pages in a row a run follows before giving up on the token. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

/**
 * Read a conversation into the store and leave its row honest about how much
 * of it we now have.
 *
 * A run with neither bound is a *full read*: it starts at the newest post and,
 * if it exhausts the search, has seen everything — the one thing that may set
 * `full_read_at`, which is what makes the next same-day re-read free. A
 * `since_id` run only ever learns that nothing newer is missing, so exhausting
 * it says nothing about the history before its bound and leaves the status
 * where it was.
 */
export async function runConversationFetch(
  store: Storage,
  xapi: XApiClient,
  meter: SpendMeter,
  rootId: string,
  opts: ConversationFetchOptions,
): Promise<ConversationRun> {
  // Read before opening: opening declares the fetch in flight and marks the
  // row partial, which is exactly the state a bounded run has to restore.
  const prior = await store.getConversationMeta(rootId);
  await store.openConversation(rootId, new Date().toISOString());

  const startTime = conversationStartTime(rootId);
  const posts: Post[] = [];
  const referencedById = new Map<string, Post>();
  const unresolvedMedia = new Set<string>();
  let nextToken: string | undefined;
  let exhausted = false;
  let emptyPages = 0;

  for (;;) {
    // Ask for no more than the budget allows: checking the cap only after a
    // full 100-post page would bill for up to 99 posts past it. The API won't
    // serve a page smaller than MIN_SEARCH_PAGE_SIZE, so a budget with less
    // than that left ends the run short rather than overshooting.
    const remaining = opts.maxPosts - posts.length;
    if (remaining < MIN_SEARCH_PAGE_SIZE) break;

    const page = meter.charge(
      await xapi.searchConversationPage(rootId, {
        maxResults: Math.min(SEARCH_PAGE_SIZE, remaining),
        sinceId: opts.sinceId,
        untilId: opts.untilId,
        nextToken,
        startTime,
      }),
    );
    posts.push(...page.posts);
    for (const post of page.referenced) referencedById.set(post.id, post);
    for (const id of page.unresolvedMediaIds) unresolvedMedia.add(id);
    // Before the next request, which is the one that can fail: what this page
    // billed for is in the store either way.
    await persistFetchedPosts(store, meter, [...page.posts, ...page.referenced]);

    nextToken = page.nextToken;
    if (!nextToken) {
      exhausted = true;
      break;
    }
    // Full-archive search can serve an empty slice mid-history, and an empty
    // page is free — X bills per post returned — so the token is worth
    // following. But only so far: the budget advances on posts, so a search
    // serving nothing but tokens would otherwise loop forever. Stopping on
    // the first empty page instead would discard the token, and every later
    // resume would repeat the same bounded request into the same empty slice —
    // partial forever.
    if (page.posts.length === 0) {
      emptyPages += 1;
      if (emptyPages >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
    } else {
      emptyPages = 0;
    }
  }

  // Referenced posts arrive without their media objects (the endpoint only
  // ships media for main results); re-look them up to resolve images. A second
  // response, so it bills again — and it is not credited against the page that
  // already paid for the same post, because both readings are real.
  const pageIds = new Set(posts.map((p) => p.id));
  const toRefetch = [...unresolvedMedia].filter((id) => !pageIds.has(id));
  if (toRefetch.length > 0) {
    // Ids the lookup couldn't return are dropped: the post already rendered
    // from the search response, it just keeps its media unresolved.
    const refetched = meter.charge(await xapi.getPostsByIds(toRefetch)).posts;
    for (const post of refetched) referencedById.set(post.id, post);
    await store.upsertPosts(refetched);
  }

  // What the pages returned wins over what the caller brought: a `known` post
  // came out of the store and may be a metrics snapshot from last week, while
  // this run just paid for the current one.
  const byId = new Map<string, Post>();
  for (const post of posts) if (!byId.has(post.id)) byId.set(post.id, post);
  for (const post of referencedById.values()) if (!byId.has(post.id)) byId.set(post.id, post);
  const fromPages = new Set(byId.keys());
  for (const post of opts.known ?? []) if (!byId.has(post.id)) byId.set(post.id, post);

  // The root last, and cheapest first: a search pages newest to oldest, so a
  // capped or bounded run may never have seen the conversation's own root.
  const root =
    byId.get(rootId) ??
    (await store.getPost(rootId)) ??
    meter.charge(await xapi.getPost(rootId));
  byId.set(rootId, root);
  // Only what the pages didn't already store, which they did as they landed.
  const extras = new Map<string, Post>();
  for (const post of [root, ...(opts.known ?? [])]) {
    if (!fromPages.has(post.id)) extras.set(post.id, post);
  }
  await store.upsertPosts([...extras.values()]);

  // Running out of pages means nothing more is there — except for a since_id
  // run, which only ever learns that about the posts newer than its bound and
  // so leaves the standing answer alone.
  const status: ConversationStatus = !exhausted
    ? "partial"
    : opts.sinceId === undefined
      ? "complete"
      : (prior?.status ?? "partial");
  const finishedAt = new Date().toISOString();
  const fullRead = opts.sinceId === undefined && opts.untilId === undefined;
  // Closed here, before the quotes: how much of the conversation we hold is
  // settled by its own pages. A quoted post belongs to some other thread, and
  // failing to look one up leaves a link unrendered — not a conversation with
  // history missing, which is what `partial` would then send someone back to
  // buy.
  await store.upsertConversation({
    rootId,
    rootAuthorHandle: root.authorHandle,
    rootText: root.text,
    rootCreatedAt: root.createdAt,
    fetchedAt: finishedAt,
    status,
    fullReadAt: fullRead && exhausted ? finishedAt : null,
  });

  await resolveQuotedPosts(store, xapi, meter, [...byId.values()], byId);

  return { status, root };
}

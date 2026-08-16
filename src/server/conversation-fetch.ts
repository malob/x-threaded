import type { Post } from "../shared/types";
import { persistFetchedPosts, resolveQuotedPosts } from "./conversations";
import type { SpendMeter } from "./meter";
import type { ConversationMeta, ConversationStatus, Storage } from "./storage";
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
 *
 * With one refinement: a run that dies having written *nothing* also proved
 * nothing, so it restores whatever the row said before it opened. Without
 * that, a refresh 401-ing on its first request re-labels a complete
 * conversation partial and sends the reader off to buy history that was never
 * missing (seen live, 2026-08-09).
 */

export interface ConversationFetchOptions {
  /** Main search-result cap; includes and follow-up lookups do not consume it. */
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
  /**
   * The caller already persisted posts into this conversation during this
   * same request — a bought lookup, stored the moment it landed so a retry
   * can't be billed for it again. That store write happened before the run
   * opened the row, so a "write-less" death is a lie here: the failure
   * restore must not fire, or a lookup that arrived out of the since_id
   * chain gets sealed under a `complete` label and every later refresh
   * steps over the gap beneath it (Codex review of b1543e6, finding 1).
   */
  callerPersisted?: boolean;
}

export interface ConversationRun {
  /** Where the conversation stands now, as written to the row. */
  status: ConversationStatus;
  /** The root, as the run finally resolved it. */
  root: Post;
}

/** A second request tried to spend on a conversation whose durable run is active. */
export class ConversationRunConflictError extends Error {}

/**
 * A crashed Worker heals without manual intervention after this. Live runs
 * renew conditionally before every outbound X boundary and before their first
 * post write; the 90-second window below covers X's bounded 60-second retry
 * without spending one D1 query per ordinary page.
 */
export const CONVERSATION_RUN_LEASE_MS = 5 * 60_000;

/** Renew with enough room for X's one retry and its capped 60-second wait. */
const CONVERSATION_RUN_RENEW_WINDOW_MS = 90_000;

/** How many empty pages in a row a run follows before giving up on the token. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

interface RunLease {
  until: number;
  wrotePosts: boolean;
}

async function ensureRunLease(
  store: Storage,
  rootId: string,
  runId: string,
  lease: RunLease,
  willWritePosts: boolean,
): Promise<void> {
  const now = Date.now();
  const needsWriteMark = willWritePosts && !lease.wrotePosts;
  if (!needsWriteMark && lease.until - now > CONVERSATION_RUN_RENEW_WINDOW_MS) return;

  const nextUntil = now + CONVERSATION_RUN_LEASE_MS;
  const renewed = await store.renewConversationRun(
    rootId,
    runId,
    nextUntil,
    willWritePosts,
  );
  if (!renewed) {
    throw new ConversationRunConflictError("conversation fetch ownership changed; retry");
  }
  lease.until = nextUntil;
  if (willWritePosts) lease.wrotePosts = true;
}

/**
 * Read a conversation into the store and leave its row honest about how much
 * of it we now have.
 *
 * A run with neither bound is a *full read*: it starts at the newest post and,
 * if it exhausts the search, has seen everything — the one thing that may set
 * `full_read_at`, which makes the next same-day page results eligible for the
 * store's read credit. It does not make ancillary media/root/quote lookups free.
 * A `since_id` run only ever learns that nothing newer is missing, so exhausting
 * it says nothing about the history before its bound and leaves the status where
 * it was.
 */
export async function runConversationFetch(
  store: Storage,
  xapi: XApiClient,
  meter: SpendMeter,
  rootId: string,
  opts: ConversationFetchOptions,
): Promise<ConversationRun> {
  const runId = crypto.randomUUID();
  const claimedAt = Date.now();
  const leaseUntil = claimedAt + CONVERSATION_RUN_LEASE_MS;
  // This conditional write is the spend gate. It is deliberately before the
  // first search/root/media call: a losing request returns 409 without asking
  // X for anything, including across Worker isolates.
  const claim = await store.claimConversationRun(
    rootId,
    runId,
    new Date(claimedAt).toISOString(),
    leaseUntil,
    claimedAt,
    opts.callerPersisted === true,
  );
  if (!claim) throw new ConversationRunConflictError("conversation fetch already in progress");
  const prior = claim.prior;
  const lease: RunLease = { until: leaseUntil, wrotePosts: opts.callerPersisted === true };

  try {
    return await fetchAndClose(store, xapi, meter, rootId, runId, lease, opts, prior);
  } catch (error) {
    // The claim stamped the row partial and durably captured the values it
    // changed. A write-less failure asks to restore those values; a run that
    // persisted paid posts leaves partial standing. Both paths clear the lease
    // only if this run still owns it. If it expired and another Worker
    // recovered, the stale cleanup is a no-op rather than a metadata rollback.
    try {
      await store.abortConversationRun(rootId, runId);
    } catch {
      // The fetch error is the one worth reporting; a failed cleanup must not
      // replace it.
    }
    throw error;
  }
}

/**
 * The run itself, from first page to closed row — split from the wrapper
 * above so it can restore the row when this dies having written nothing. That
 * answer is durable in the lease row rather than invocation-local state.
 */
async function fetchAndClose(
  store: Storage,
  xapi: XApiClient,
  meter: SpendMeter,
  rootId: string,
  runId: string,
  lease: RunLease,
  opts: ConversationFetchOptions,
  prior: Omit<ConversationMeta, "rootId"> | null,
): Promise<ConversationRun> {
  const startTime = conversationStartTime(rootId);
  const posts: Post[] = [];
  const referencedById = new Map<string, Post>();
  const unresolvedMedia = new Set<string>();
  let nextToken: string | undefined;
  let exhausted = false;
  let emptyPages = 0;

  for (;;) {
    // Ask for no more main results than the configured bound allows: checking
    // only after a full 100-post page would bill for up to 99 main results past
    // it. The API will not serve a page below MIN_SEARCH_PAGE_SIZE, so less than
    // that remaining ends the run short rather than overshooting.
    const remaining = opts.maxPosts - posts.length;
    if (remaining < MIN_SEARCH_PAGE_SIZE) break;

    await ensureRunLease(store, rootId, runId, lease, false);
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
    const landed = [...page.posts, ...page.referenced];
    // Set the durable write bit before the post batch. If the Worker dies in
    // the batch, recovery must conservatively keep partial rather than restore
    // complete over a page that may have landed.
    await ensureRunLease(store, rootId, runId, lease, landed.length > 0);
    await persistFetchedPosts(store, meter, landed);

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
    const refetched = meter.charge(
      await xapi.getPostsByIds(toRefetch, {
        beforeRequest: () => ensureRunLease(store, rootId, runId, lease, false),
      }),
    ).posts;
    for (const post of refetched) referencedById.set(post.id, post);
    await ensureRunLease(store, rootId, runId, lease, refetched.length > 0);
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
  let root = byId.get(rootId) ?? (await store.getPost(rootId));
  if (!root) {
    await ensureRunLease(store, rootId, runId, lease, false);
    root = meter.charge(await xapi.getPost(rootId));
  }
  byId.set(rootId, root);
  // Only what the pages didn't already store, which they did as they landed.
  const extras = new Map<string, Post>();
  for (const post of [root, ...(opts.known ?? [])]) {
    if (!fromPages.has(post.id)) extras.set(post.id, post);
  }
  await ensureRunLease(store, rootId, runId, lease, extras.size > 0);
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
  // Keep ownership through quote resolution too: it can make several paid
  // 100-id lookups. A quote failure still closes the conversation—its own
  // history is settled—but the lease is released only after that paid work is
  // done, so another run cannot overlap it.
  let quoteFailure: { error: unknown } | null = null;
  try {
    await resolveQuotedPosts(store, xapi, meter, [...byId.values()], byId, {
      beforeRequest: () => ensureRunLease(store, rootId, runId, lease, false),
      beforePersist: (fetched) =>
        ensureRunLease(store, rootId, runId, lease, fetched.length > 0),
    });
  } catch (error) {
    quoteFailure = { error };
  }

  await ensureRunLease(store, rootId, runId, lease, false);
  const closed = await store.finishConversationRun(runId, {
    rootId,
    rootAuthorHandle: root.authorHandle,
    rootText: root.text,
    rootCreatedAt: root.createdAt,
    fetchedAt: finishedAt,
    status,
    fullReadAt: fullRead && exhausted ? finishedAt : null,
  });
  if (!closed) {
    throw new ConversationRunConflictError("conversation fetch ownership changed; retry");
  }
  if (quoteFailure) throw quoteFailure.error;

  return { status, root };
}

import type { MediaItem, Post, PostEntities } from "../shared/types";

/**
 * How much of a conversation we hold.
 *
 * `partial` — a fetch is in flight, or the last one stopped early: the budget
 *   capped it, or it died between pages. Servable and labeled as such, and
 *   `POST /api/conversations/:rootId/resume` is how the rest is bought.
 * `complete` — a run with no lower bound exhausted the search. A root with no
 *   replies at all is a perfectly good complete conversation.
 *
 * Two states rather than three: with pages persisted as they land, a failed
 * run and a budget-capped one leave the same thing behind — a partial
 * conversation that can be resumed — and nothing here acts on the difference
 * between them.
 */
export type ConversationStatus = "partial" | "complete";

export interface ConversationMeta {
  rootId: string;
  rootAuthorHandle: string;
  rootText: string;
  rootCreatedAt: string;
  /** When a run last landed for this conversation, whatever it asked X for. */
  fetchedAt: string;
  status: ConversationStatus;
  /**
   * When the last *complete full* read finished, or null if there has never
   * been one. What the refresh fork reads: a full re-read on the same UTC
   * calendar day is free under X's dedup, and only an actual full read may
   * say so.
   */
  fullReadAt: string | null;
}

/** The lifecycle row observed atomically when a conversation run took ownership. */
export interface ConversationRunClaim {
  /** Null when the claim created the conversation's first partial row. */
  prior: Omit<ConversationMeta, "rootId"> | null;
}

/** Metadata and posts captured by one database statement for response rendering. */
export interface ConversationResponseSnapshot {
  status: ConversationStatus;
  posts: Post[];
}

/**
 * Storage backend for conversations, posts, and read state. Async so the
 * same interface can be backed by bun:sqlite (sync under the hood, used by
 * the Bun server) or Cloudflare D1 (natively async, used by the Worker).
 */
export interface Storage {
  getConversationMeta(rootId: string): Promise<Omit<ConversationMeta, "rootId"> | null>;
  /**
   * Read response-visible lifecycle state and its post set atomically. A run
   * may transition in either direction around this statement, but cannot make
   * the returned status describe a different post snapshot.
   */
  getConversationResponseSnapshot(rootId: string): Promise<ConversationResponseSnapshot | null>;
  /**
   * Atomically own a fetch before it spends anything: create the row as
   * `partial`, take an unleased row, or recover a lease no longer active at
   * `now`. An active owner's row returns null and must not be sent to X.
   *
   * The previous lifecycle values are captured durably with the lease. That is
   * what lets `abortConversationRun` restore a write-less failure without an
   * unversioned process-local snapshot. The root's fields stay blank on a new
   * row until the owning run finishes.
   */
  claimConversationRun(
    rootId: string,
    runId: string,
    startedAt: string,
    leaseUntil: number,
    now: number,
    wrotePosts: boolean,
  ): Promise<ConversationRunClaim | null>;
  /**
   * Extend a live run immediately before a persistence boundary. When that
   * boundary will write posts, record the fact first so even a crash during
   * the write makes recovery conservatively keep the row partial.
   */
  renewConversationRun(
    rootId: string,
    runId: string,
    leaseUntil: number,
    willWritePosts: boolean,
  ): Promise<boolean>;
  /**
   * Close a run and release its lease, but only while `runId` still owns the
   * row. False means an expired lease was recovered and this result is stale.
   */
  finishConversationRun(runId: string, meta: ConversationMeta): Promise<boolean>;
  /**
   * Release a failed run conditionally. The durable write bit decides whether
   * to restore the lifecycle values captured by its own claim or leave the row
   * partial because this run persisted (or may have persisted) paid posts. A
   * first-ever failed run has no prior row and remains partial either way.
   */
  abortConversationRun(rootId: string, runId: string): Promise<boolean>;
  /**
   * Administrative/unleased write used by imports and fixtures. It cannot
   * update a row while a conversation run owns it.
   *
   * A null `fullReadAt` leaves the recorded one standing rather than clearing
   * it, so a since_id refresh or a resume can say "I am not a full read"
   * without erasing the last one. The root's identity is written once, when it
   * is first known: a re-fetch must not overwrite it with whatever a caller
   * happened to pass.
   */
  upsertConversation(meta: ConversationMeta): Promise<void>;
  hasConversation(rootId: string): Promise<boolean>;
  /**
   * Which of these conversations are cached. The set form exists because the
   * callers ask about a whole page at once, and one query per row is a
   * sequential D1 round trip each (2026-07-30 review, S3).
   */
  hasConversations(rootIds: string[]): Promise<Set<string>>;

  upsertPosts(posts: Post[]): Promise<void>;
  getPosts(conversationId: string): Promise<Post[]>;
  getPostsByIds(ids: string[]): Promise<Post[]>;
  /**
   * Which of these posts we already read on the current UTC calendar day. X
   * deduplicates reads within one, so those should be free to read again —
   * this is how spend is estimated rather than guessed.
   *
   * "Should be": the dedup is observed behaviour, not a rate X will confirm
   * (docs/x-api-notes.md N2). A billing discrepancy that traces back here is
   * upstream policy having moved, not an arithmetic bug.
   */
  postIdsReadToday(ids: string[]): Promise<Set<string>>;
  getPost(id: string): Promise<Post | null>;
  hasPost(id: string): Promise<boolean>;
  newestPostId(conversationId: string): Promise<string | null>;
  /**
   * The oldest cached *reply*, which is where resuming a partial conversation
   * picks up: the search pages newest first, so what a stopped run is missing
   * is everything older than this.
   *
   * The root is excluded deliberately. It is by definition the oldest post in
   * its conversation, so bounding an `until_id` search there asks for posts
   * older than the conversation, gets nothing, and reads that empty answer as
   * "there is nothing left" — marking a conversation we barely read complete.
   * Null means no reply is cached, and the resume is an unbounded read.
   *
   * The boundary assumes what we hold runs unbroken from here to the newest
   * post, which is what a run that pages newest-first leaves. A reply stored
   * from outside one — a bookmark synced on its own, the pasted post — can sit
   * older than that, and resuming from it would step over the gap between the
   * two. A full re-read is what closes such a gap; a cursor column would not,
   * since it can drift from the posts it claims to describe.
   */
  oldestReplyId(conversationId: string): Promise<string | null>;
  existingPostIds(conversationId: string): Promise<Set<string>>;

  getUnreadIds(conversationId: string): Promise<string[]>;
  setReadState(postIds: string[], read: boolean): Promise<void>;
  markConversationRead(conversationId: string): Promise<void>;

  /** The whole stored grant, lease bookkeeping included. */
  getOAuthTokens(id: string): Promise<StoredTokens | null>;
  /**
   * Write a grant outright, resetting the lease state: ready, unleased, with
   * the recovery allowance restored. This is what a fresh `/auth/login`
   * does — and the only escape from `broken`. A rotation must go through
   * `finalizeTokenLease` instead, which checks it still owns the row.
   */
  putOAuthTokens(id: string, tokens: OAuthTokens): Promise<void>;
  /**
   * Cache the signed-in user's identity, touching nothing else. Narrow on
   * purpose: it runs after a billable `/2/users/me` round-trip, during which
   * a rotation may have landed, and writing a whole row back would revive
   * the dead refresh token it was read with.
   */
  /** CAS on the observed refresh token; false = the grant changed underneath. */
  putUserProfile(id: string, observedRefreshToken: string, profile: UserProfile): Promise<boolean>;

  /**
   * Own the first billable profile read for one coherently observed grant.
   * An active lease on that grant rejects a second caller; an expired lease,
   * or one left by a grant that has since rotated, may be replaced. This is
   * intentionally independent of the single-use token-refresh lease below:
   * repeating getMe after a crash costs money, but cannot revoke the grant.
   */
  claimUserProfileLease(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
    leaseUntil: number,
    now: number,
  ): Promise<boolean>;
  /**
   * Cache the profile and release its lease atomically, only if both the grant
   * and lease are still the ones this caller observed. False means a fresh
   * login, token rotation, or expired-lease recovery won the race.
   */
  finishUserProfileLease(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
    profile: UserProfile,
  ): Promise<boolean>;
  /** Release an owned profile lease after a getMe failure, without touching tokens. */
  releaseUserProfileLease(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
  ): Promise<boolean>;

  /**
   * Take the refresh lease: the one statement that decides who calls X.
   *
   * True means this caller won and must either finalize, release, or break the
   * row; false means someone else holds it or the grant already rotated, and
   * the caller must re-read rather than call X with a token it no longer owns.
   * Binding to `observed` is what stops a stale reader from leasing a row whose
   * refresh token has already been spent (dialogue r2, answer 1).
   */
  claimTokenLease(
    id: string,
    observed: string,
    leaseId: string,
    leaseUntil: number,
  ): Promise<boolean>;
  /**
   * Take over a lease whose holder never came back — once per grant.
   *
   * `expiredBefore` is the instant the previous lease must already have passed,
   * which callers set to now minus a grace period so a merely slow holder still
   * gets to finalize. Sets `recovery_used`, so a second crash cannot mint a
   * second attempt: the holder may have exchanged the token before dying, and
   * re-presenting a spent one can revoke the grant (dialogue r3, verdict 1).
   */
  claimRecoveryLease(
    id: string,
    observed: string,
    leaseId: string,
    leaseUntil: number,
    expiredBefore: number,
  ): Promise<boolean>;
  /**
   * Persist a rotation, if this caller still holds the lease it opened *and*
   * the row still carries the token it exchanged. False means the lease was
   * lost: the caller must write nothing further and re-read.
   */
  finalizeTokenLease(
    id: string,
    leaseId: string,
    observed: string,
    next: OAuthTokens,
  ): Promise<boolean>;
  /**
   * Hand the lease back without rotating, for a refresh that X refused in a
   * way that leaves the token unspent. Leaves the pair exactly as found.
   */
  releaseTokenLease(id: string, leaseId: string, observed: string): Promise<boolean>;
  /**
   * Record that the grant is dead and only `/auth/login` can fix it. Bound to
   * the observed token so a late failure can't bury a rotation that has since
   * succeeded.
   */
  markTokenBroken(id: string, observed: string, reason: string): Promise<boolean>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  /** Read the bookmark folder's id/name pair in one database snapshot. */
  getBookmarkFolder(): Promise<BookmarkFolderSetting>;
  /** Atomically store the bookmark folder's id/name pair and invalidate any older scan. */
  setBookmarkFolder(folderId: string, folderName: string): Promise<void>;
  /**
   * Own a scan for `folderId`, but only if it is still selected and no live
   * owner exists. An expired owner may be recovered by a new run; the run ID
   * fences every later renewal, release, and reconciliation write.
   */
  beginBookmarkSync(
    folderId: string,
    runId: string,
    leaseUntil: number,
    now: number,
  ): Promise<boolean>;
  /** Extend an owned scan before another X request. False means ownership moved. */
  renewBookmarkSync(folderId: string, runId: string, leaseUntil: number): Promise<boolean>;
  /** Best-effort owner-bound release after a handled failure. */
  abortBookmarkSync(folderId: string, runId: string): Promise<boolean>;
  /**
   * Persist hydrated posts and reconcile bookmark-owned saved rows in one
   * transaction, only while `runId` still owns the scan. Manual rows are
   * never removed or re-sourced, and a superseded scan writes no post cache.
   */
  finishBookmarkSync(
    folderId: string,
    runId: string,
    posts: Post[],
    folderPostIds: string[],
    complete: boolean,
    addedAt: string,
    /** Refuse before issuing the transaction when its expanded batch is larger. */
    maxStatements?: number,
  ): Promise<BookmarkSyncCommit>;

  /** Posts queued for reading, newest first. */
  listSavedItems(): Promise<SavedItem[]>;
  /**
   * Whether any saved entry already stands for this conversation — its own
   * root, or a reply somewhere inside it. A bookmarked mid-thread reply is
   * the queue entry for that whole thread, so opening it must not leave a
   * second one keyed on the root (2026-07-30 review, H5).
   */
  hasSavedConversation(rootId: string): Promise<boolean>;
  getSavedItem(postId: string): Promise<SavedItem | null>;
  addSavedItems(items: SavedItem[]): Promise<void>;
  removeSavedItem(postId: string): Promise<void>;
  /** Remove several at once, all or nothing. */
  removeSavedItems(postIds: string[]): Promise<void>;
}

export interface SavedItem {
  postId: string;
  /** "bookmark" (synced from the folder) or "manual" (added in the app). */
  source: string;
  addedAt: string;
}

export interface BookmarkSyncCommit {
  /** False when a newer scan or folder selection superseded this run. */
  applied: boolean;
  added: number;
  removed: number;
  /** No database write ran because the expanded transaction exceeded its caller's budget. */
  budgetExceeded?: true;
}

export interface BookmarkFolderSetting {
  id: string | null;
  name: string | null;
}

/**
 * Where the stored grant is in the refresh protocol.
 *
 * `ready` — usable, nobody is refreshing it.
 * `refreshing` — one caller holds a lease and may be talking to X right now.
 * `broken` — the grant is gone; only a fresh `/auth/login` revives it.
 */
export type TokenState = "ready" | "refreshing" | "broken";

/** A grant as the OAuth code hands it over: the token pair and what we know. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  expiresAt: number;
  scope: string;
  /** The authenticated user's ID, resolved lazily and cached. */
  userId?: string | null;
  /** Their handle, cached alongside — `/2/users/me` is a billable read. */
  username?: string | null;
  displayName?: string | null;
}

/** The identity `/2/users/me` resolves, cached so it is asked for once. */
export interface UserProfile {
  userId: string;
  username: string;
  displayName: string;
}

/** A grant as stored: the pair, the profile, and the lease bookkeeping. */
export interface StoredTokens extends OAuthTokens {
  userId: string | null;
  username: string | null;
  displayName: string | null;
  state: TokenState;
  /** Non-null only while `state` is `refreshing`. */
  leaseId: string | null;
  /** Unix ms the lease lapses at. */
  leaseUntil: number | null;
  /** This grant has already spent its one crash-recovery attempt. */
  recoveryUsed: boolean;
  /** Set with `broken`; what to tell the user. */
  brokenReason: string | null;
}

export interface PostRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  author_id: string;
  author_handle: string;
  author_name: string;
  author_avatar_url: string | null;
  text: string;
  created_at: string;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  bookmarks: number;
  impressions: number;
  entities_json: string | null;
  quoted_post_id: string | null;
  media_json: string | null;
  fetched_at: string;
}

export interface ConversationRow {
  root_id: string;
  root_author_handle: string;
  root_text: string;
  root_created_at: string;
  fetched_at: string;
  status: string;
  full_read_at: string | null;
}

export interface ConversationRunRow extends ConversationRow {
  run_id: string | null;
  run_lease_until: number | null;
  run_wrote_posts: number;
  run_previous_status: string | null;
  run_previous_fetched_at: string | null;
  run_previous_full_read_at: string | null;
}

export function rowToPost(row: PostRow): Post {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    authorId: row.author_id,
    authorHandle: row.author_handle,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    text: row.text,
    createdAt: row.created_at,
    metrics: {
      likes: row.likes,
      replies: row.replies,
      reposts: row.reposts,
      quotes: row.quotes,
      bookmarks: row.bookmarks,
      impressions: row.impressions,
    },
    entities: row.entities_json ? (JSON.parse(row.entities_json) as PostEntities) : null,
    quotedPostId: row.quoted_post_id,
    media: row.media_json ? (JSON.parse(row.media_json) as MediaItem[]) : null,
    fetchedAt: row.fetched_at,
  };
}

/**
 * Quoted posts referenced by any of the given posts, keyed by ID. Follows
 * one extra level so a quote-of-a-quote can render nested when its data
 * happens to be cached.
 */
export async function getQuotedFor(store: Storage, posts: Post[]): Promise<Record<string, Post>> {
  const result: Record<string, Post> = {};
  let wanted = [
    ...new Set(posts.map((p) => p.quotedPostId).filter((id): id is string => id !== null)),
  ];
  for (let level = 0; level < 2 && wanted.length > 0; level++) {
    const found = await store.getPostsByIds(wanted);
    for (const post of found) result[post.id] = post;
    wanted = [
      ...new Set(
        found
          .map((p) => p.quotedPostId)
          .filter((id): id is string => id !== null && !(id in result)),
      ),
    ];
  }
  return result;
}

import type { MediaItem, Post, PostEntities } from "../shared/types";

export interface ConversationMeta {
  rootId: string;
  rootAuthorHandle: string;
  rootText: string;
  rootCreatedAt: string;
  fetchedAt: string;
}

/**
 * Storage backend for conversations, posts, and read state. Async so the
 * same interface can be backed by bun:sqlite (sync under the hood, used by
 * the Bun server) or Cloudflare D1 (natively async, used by the Worker).
 */
export interface Storage {
  getConversationMeta(rootId: string): Promise<Omit<ConversationMeta, "rootId"> | null>;
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
   * Which of these posts we already read today (UTC). X deduplicates reads
   * within a UTC day, so those are free to read again — this is how actual
   * spend is computed rather than guessed.
   */
  postIdsReadToday(ids: string[]): Promise<Set<string>>;
  getPost(id: string): Promise<Post | null>;
  hasPost(id: string): Promise<boolean>;
  newestPostId(conversationId: string): Promise<string | null>;
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
  putUserProfile(id: string, profile: UserProfile): Promise<void>;

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

  /** Posts queued for reading, newest first. */
  listSavedItems(): Promise<SavedItem[]>;
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

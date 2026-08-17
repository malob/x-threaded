/** Browser-held account namespace required on every account-bound API call. */
export const ACCOUNT_GENERATION_HEADER = "X-Account-Generation";

export interface PostMetrics {
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  bookmarks: number;
  impressions: number;
}

export interface UrlEntity {
  url: string;
  expanded_url: string;
  display_url: string;
}

export interface PostEntities {
  urls?: UrlEntity[];
}

export interface MediaItem {
  mediaKey: string;
  type: string;
  url: string | null;
  previewImageUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface Post {
  id: string;
  conversationId: string;
  /** ID of the post this replies to; null for the conversation root. */
  parentId: string | null;
  authorId: string;
  authorHandle: string;
  authorName: string;
  authorAvatarUrl: string | null;
  text: string;
  createdAt: string;
  metrics: PostMetrics;
  entities: PostEntities | null;
  /** ID of a post this one quote-posts, if any. */
  quotedPostId: string | null;
  media: MediaItem[] | null;
  fetchedAt: string;
}

export interface ConversationResponse {
  rootId: string;
  /** Post the pasted URL pointed at, when it wasn't the root. */
  focusId: string | null;
  posts: Post[];
  /** Posts quoted by posts in this conversation, keyed by ID. */
  quoted: Record<string, Post>;
  /** IDs of posts not yet marked read. */
  unreadIds: string[];
  /**
   * True when we hold only part of this conversation: a fetch stopped at
   * MAX_POSTS_PER_FETCH, or one never finished. A property of what is stored,
   * not of the request that noticed — so it is still true on a later cached
   * read, and "load older replies" is the way out of it.
   */
  truncated: boolean;
  /**
   * True when these posts came out of the local cache rather than a fetch.
   * It does not mean the request was free: resolving *which* conversation to
   * serve can cost a lookup for a post we have never seen, so a cached
   * response can still carry a `cost`. That field, not this one, is what a
   * billing question should be asked of.
   */
  fromCache: boolean;
  /** Present when this response involved API reads; absent when nothing billed. */
  cost?: FetchCost;
}

/**
 * What a request estimates it spent at X, after same-day deduplication.
 *
 * An estimate, not a statement: `billable` is our reading of X's dedup rules,
 * not their invoice (docs/x-api-notes.md N2).
 */
export interface FetchCost {
  /** Reads billed by X: posts at either post rate, plus any User Read. */
  posts: number;
  /** Of those, ones we hadn't already read today — the ones that bill. */
  billable: number;
  usd: number;
}

export interface RefreshResponse extends ConversationResponse {
  /** Posts added by this refresh. */
  newCount: number;
  cost?: FetchCost;
}

export interface ApiError {
  error: string;
  /**
   * What the request had already spent when it failed. Present only when
   * money moved: a request can throw well after the reads it paid for, and a
   * bare "internal error" would be the one failure that hides a bill.
   */
  cost?: FetchCost;
}

/**
 * An error only a (re)connection fixes, so it carries where to go. Distinct
 * from a plain ApiError because the client offers a login link, not a retry.
 */
export interface AuthRequiredError extends ApiError {
  loginUrl: string;
}

/** A write that either happened or raised; there is nothing else to report. */
export interface OkResponse {
  ok: boolean;
}

/** Terminal X disconnect also tells the client which account-cache namespace is current. */
export interface DisconnectResponse extends OkResponse {
  accountGeneration: string;
}

export interface ResolveResponse {
  /** The cached conversation this post belongs to, or null if we have none. */
  rootId: string | null;
  /** Replies on the post, for estimating a fetch; null when it's unknown to us. */
  replyCount: number | null;
}

export interface SyncResponse {
  /** Posts the folder scan hydrated. */
  synced: number;
  added: number;
  removed: number;
  /**
   * Bookmarks whose posts X wouldn't return (deleted, or the author went
   * private): still bookmarked, never removed, but nothing to show in Saved.
   */
  unavailable: number;
  /** False when the scan hit its page cap; removals were skipped. */
  complete: boolean;
  /** Enumerating a folder and hydrating it both bill; a big folder is dollars. */
  cost: FetchCost;
}

export interface SavedEntry {
  post: Post;
  /** "bookmark" (synced from the folder) or "manual" (added in the app). */
  source: string;
  addedAt: string;
  rootId: string;
  /**
   * Whether a conversation row exists for it — so opening it renders without
   * a fetch. Not a promise that the whole tree is here: a partial fetch also
   * leaves a row, and `ConversationResponse.truncated` is what says so.
   */
  loaded: boolean;
}

export interface SavedListResponse {
  items: SavedEntry[];
  quoted: Record<string, Post>;
}

/** One of the user's own threads, represented by its root post. */
export interface OwnThread {
  root: Post;
  /**
   * How long the thread itself is: the root plus its chain of self-replies
   * (1 = a lone post). Not every post the user has in the conversation —
   * their replies to other participants are deliberately excluded, or a
   * two-post thread that sparked a long discussion reads as a 21-post one.
   * Computed by `spineLength` in src/server/threads.ts.
   */
  ownPostCount: number;
  /** Timestamp of their most recent post in it, for ordering. */
  latestAt: string;
  /** Whether a conversation row exists for it; see SavedEntry.loaded. */
  loaded: boolean;
}

/** Largest Your-posts thread target one request will accept. */
export const MAX_OWN_POST_THREADS = 50;

export interface OwnPostsResponse {
  items: OwnThread[];
  quoted: Record<string, Post>;
  /**
   * There may be more threads than were returned — either the scan found more
   * than it was asked to show, or the timeline still has pages. False only
   * when the timeline ran out with nothing trimmed.
   */
  hasMore: boolean;
  /** Owned Reads for the timeline pages, plus any root the scan had to buy. */
  cost: FetchCost;
}

export interface SettingsResponse {
  bookmarkFolderId: string | null;
  bookmarkFolderName: string | null;
}

export interface FoldersResponse {
  folders: { id: string; name: string }[];
  /** Folders are free, but the first-ever call pays a getMe; absent when $0. */
  cost?: FetchCost;
}

/**
 * Where this deployment stands with X — one of five states, not a bag of
 * booleans that can spell states there is no such thing as.
 *
 * `unconfigured` — no OAuth client credentials; user-context features are off.
 * `unauthorized` — credentials, but nobody has consented yet.
 * `broken` — the grant is gone and only a fresh login revives it.
 * `disconnecting` — provider revocation owns the grant; it is deliberately
 *   unusable until local deletion succeeds or revocation fails and releases.
 * `authorized` — usable; `user` is null until something has paid for the
 *   billable `/2/users/me` that resolves it, so the status route never does.
 * `accountGeneration` is the durable opaque namespace for account-owned
 * client caches. Fresh login and terminal disconnect rotate it; same-account
 * reconnect and token refresh preserve it.
 */
export type AuthStatus = { accountGeneration: string } &
  (
    | { state: "unconfigured" }
    | { state: "unauthorized"; loginUrl: string }
    | { state: "disconnecting" }
    | { state: "broken"; reason: string; loginUrl: string }
    | {
        state: "authorized";
        user: { username: string; name: string } | null;
        scopes: string[];
        expiresAt: number;
      }
  );

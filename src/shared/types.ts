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
  /** True when the fetch stopped at MAX_POSTS_PER_FETCH. */
  truncated: boolean;
  /** True when served from the local cache without hitting the X API. */
  fromCache: boolean;
  /** Present when this response involved API reads. */
  cost?: FetchCost;
}

/** What an API call actually cost, after same-day deduplication. */
export interface FetchCost {
  /** Posts returned. */
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
}

export interface SavedEntry {
  post: Post;
  /** "bookmark" (synced from the folder) or "manual" (added in the app). */
  source: string;
  addedAt: string;
  rootId: string;
  /** Whether the full conversation is already cached. */
  loaded: boolean;
}

export interface SavedListResponse {
  items: SavedEntry[];
  quoted: Record<string, Post>;
}

/** One of the user's own threads, represented by its root post. */
export interface OwnThread {
  root: Post;
  /** How many posts in this thread are the user's own (1 = a lone post). */
  ownPostCount: number;
  /** Timestamp of their most recent post in it, for ordering. */
  latestAt: string;
  loaded: boolean;
}

export interface OwnPostsResponse {
  items: OwnThread[];
  quoted: Record<string, Post>;
  /** The scan filled its quota, so asking for more may yield more. */
  hasMore: boolean;
}

export interface SettingsResponse {
  bookmarkFolderId: string | null;
  bookmarkFolderName: string | null;
}

export interface FoldersResponse {
  folders: { id: string; name: string }[];
}

/**
 * Where this deployment stands with X — one of four states, not a bag of
 * booleans that can spell states there is no such thing as.
 *
 * `unconfigured` — no OAuth client credentials; user-context features are off.
 * `unauthorized` — credentials, but nobody has consented yet.
 * `broken` — the grant is gone and only a fresh login revives it.
 * `authorized` — usable; `user` is null until something has paid for the
 *   billable `/2/users/me` that resolves it, so the status route never does.
 */
export type AuthStatus =
  | { state: "unconfigured" }
  | { state: "unauthorized"; loginUrl: string }
  | { state: "broken"; reason: string; loginUrl: string }
  | {
      state: "authorized";
      user: { username: string; name: string } | null;
      scopes: string[];
      expiresAt: number;
    };

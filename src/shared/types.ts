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

export interface ConversationSummary {
  rootId: string;
  rootAuthorHandle: string;
  rootText: string;
  rootCreatedAt: string;
  postCount: number;
  unreadCount: number;
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
}

export interface RefreshResponse extends ConversationResponse {
  /** Posts added by this refresh. */
  newCount: number;
  /** True when the refresh was a free same-day full re-read (metrics updated). */
  metricsUpdated: boolean;
}

export interface ApiError {
  error: string;
}

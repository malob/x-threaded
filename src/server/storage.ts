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

  getOAuthTokens(id: string): Promise<OAuthTokens | null>;
  putOAuthTokens(id: string, tokens: OAuthTokens): Promise<void>;

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

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  expiresAt: number;
  scope: string;
  /** The authenticated user's ID, resolved lazily and cached. */
  userId?: string | null;
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

import { Database } from "bun:sqlite";
import type { ConversationSummary, MediaItem, Post, PostEntities } from "../shared/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  root_id TEXT PRIMARY KEY,
  root_author_handle TEXT NOT NULL,
  root_text TEXT NOT NULL,
  root_created_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_id TEXT,
  author_id TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_avatar_url TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  quotes INTEGER NOT NULL DEFAULT 0,
  bookmarks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  entities_json TEXT,
  quoted_post_id TEXT,
  media_json TEXT,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_conversation ON posts(conversation_id);
`;

interface PostRow {
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

interface ConversationRow {
  root_id: string;
  root_author_handle: string;
  root_text: string;
  root_created_at: string;
  fetched_at: string;
  post_count: number;
}

function rowToPost(row: PostRow): Post {
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

function rowToSummary(row: ConversationRow): ConversationSummary {
  return {
    rootId: row.root_id,
    rootAuthorHandle: row.root_author_handle,
    rootText: row.root_text,
    rootCreatedAt: row.root_created_at,
    postCount: row.post_count,
    fetchedAt: row.fetched_at,
  };
}

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run(SCHEMA);
    const columns = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(posts)`)
      .all()
      .map((c) => c.name);
    if (!columns.includes("entities_json")) {
      this.db.run("ALTER TABLE posts ADD COLUMN entities_json TEXT");
    }
    if (!columns.includes("quoted_post_id")) {
      this.db.run("ALTER TABLE posts ADD COLUMN quoted_post_id TEXT");
    }
    if (!columns.includes("media_json")) {
      this.db.run("ALTER TABLE posts ADD COLUMN media_json TEXT");
    }
    if (!columns.includes("bookmarks")) {
      this.db.run("ALTER TABLE posts ADD COLUMN bookmarks INTEGER NOT NULL DEFAULT 0");
    }
  }

  upsertConversation(summary: Omit<ConversationSummary, "postCount">): void {
    this.db
      .query(
        `INSERT INTO conversations (root_id, root_author_handle, root_text, root_created_at, fetched_at)
         VALUES ($rootId, $handle, $text, $createdAt, $fetchedAt)
         ON CONFLICT(root_id) DO UPDATE SET fetched_at = $fetchedAt`,
      )
      .run({
        $rootId: summary.rootId,
        $handle: summary.rootAuthorHandle,
        $text: summary.rootText,
        $createdAt: summary.rootCreatedAt,
        $fetchedAt: summary.fetchedAt,
      });
  }

  upsertPosts(posts: Post[]): void {
    const stmt = this.db.query(
      `INSERT OR REPLACE INTO posts
         (id, conversation_id, parent_id, author_id, author_handle, author_name,
          author_avatar_url, text, created_at, likes, replies, reposts, quotes,
          impressions, bookmarks, entities_json, quoted_post_id, media_json, fetched_at)
       VALUES
         ($id, $conversationId, $parentId, $authorId, $authorHandle, $authorName,
          $authorAvatarUrl, $text, $createdAt, $likes, $replies, $reposts, $quotes,
          $impressions, $bookmarks, $entitiesJson, $quotedPostId, $mediaJson, $fetchedAt)`,
    );
    const insertAll = this.db.transaction((rows: Post[]) => {
      for (const p of rows) {
        stmt.run({
          $id: p.id,
          $conversationId: p.conversationId,
          $parentId: p.parentId,
          $authorId: p.authorId,
          $authorHandle: p.authorHandle,
          $authorName: p.authorName,
          $authorAvatarUrl: p.authorAvatarUrl,
          $text: p.text,
          $createdAt: p.createdAt,
          $likes: p.metrics.likes,
          $replies: p.metrics.replies,
          $reposts: p.metrics.reposts,
          $quotes: p.metrics.quotes,
          $impressions: p.metrics.impressions,
          $bookmarks: p.metrics.bookmarks,
          $entitiesJson: p.entities ? JSON.stringify(p.entities) : null,
          $quotedPostId: p.quotedPostId,
          $mediaJson: p.media ? JSON.stringify(p.media) : null,
          $fetchedAt: p.fetchedAt,
        });
      }
    });
    insertAll(posts);
  }

  getPosts(conversationId: string): Post[] {
    const rows = this.db
      .query<PostRow, { $id: string }>(
        `SELECT * FROM posts WHERE conversation_id = $id ORDER BY created_at ASC`,
      )
      .all({ $id: conversationId });
    return rows.map(rowToPost);
  }

  /**
   * Quoted posts referenced by any of the given posts, keyed by ID. Follows
   * one extra level so a quote-of-a-quote can render nested when its data
   * happens to be cached.
   */
  getQuotedFor(posts: Post[]): Record<string, Post> {
    const result: Record<string, Post> = {};
    let wanted = [
      ...new Set(posts.map((p) => p.quotedPostId).filter((id): id is string => id !== null)),
    ];
    for (let level = 0; level < 2 && wanted.length > 0; level++) {
      const placeholders = wanted.map(() => "?").join(",");
      const found = this.db
        .query<PostRow, string[]>(`SELECT * FROM posts WHERE id IN (${placeholders})`)
        .all(...wanted)
        .map(rowToPost);
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

  hasConversation(rootId: string): boolean {
    const row = this.db
      .query<{ root_id: string }, { $id: string }>(
        `SELECT root_id FROM conversations WHERE root_id = $id`,
      )
      .get({ $id: rootId });
    return row !== null;
  }

  listConversations(): ConversationSummary[] {
    const rows = this.db
      .query<ConversationRow, []>(
        `SELECT c.*, COUNT(p.id) AS post_count
         FROM conversations c
         LEFT JOIN posts p ON p.conversation_id = c.root_id
         GROUP BY c.root_id
         ORDER BY c.fetched_at DESC`,
      )
      .all();
    return rows.map(rowToSummary);
  }
}

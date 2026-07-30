import type { Post } from "../shared/types";
import {
  rowToPost,
  rowToSummary,
  type ConversationMeta,
  type ConversationRow,
  type ConversationRowSummary,
  type PostRow,
  type Storage,
} from "./storage";

/**
 * Minimal structural types for the D1 binding — just the surface this store
 * uses. Declared locally instead of pulling in @cloudflare/workers-types,
 * whose globals collide with Bun's in a single tsconfig.
 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

/**
 * Cloudflare D1 implementation of Storage for the Worker. Schema is applied
 * via migrations/ (wrangler d1 migrations apply), not at construction.
 */
export class D1Store implements Storage {
  constructor(private db: D1Database) {}

  async getConversationMeta(rootId: string): Promise<Omit<ConversationMeta, "rootId"> | null> {
    const row = await this.db
      .prepare(`SELECT * FROM conversations WHERE root_id = ?`)
      .bind(rootId)
      .first<Omit<ConversationRow, "post_count" | "unread_count">>();
    if (!row) return null;
    return {
      rootAuthorHandle: row.root_author_handle,
      rootText: row.root_text,
      rootCreatedAt: row.root_created_at,
      fetchedAt: row.fetched_at,
    };
  }

  async upsertConversation(meta: ConversationMeta): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO conversations (root_id, root_author_handle, root_text, root_created_at, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(root_id) DO UPDATE SET fetched_at = excluded.fetched_at`,
      )
      .bind(meta.rootId, meta.rootAuthorHandle, meta.rootText, meta.rootCreatedAt, meta.fetchedAt)
      .run();
  }

  async hasConversation(rootId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT root_id FROM conversations WHERE root_id = ?`)
      .bind(rootId)
      .first<{ root_id: string }>();
    return row !== null;
  }

  async listConversations(): Promise<ConversationRowSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.*, COUNT(p.id) AS post_count,
                SUM(CASE WHEN p.id IS NOT NULL AND r.post_id IS NULL THEN 1 ELSE 0 END) AS unread_count
         FROM conversations c
         LEFT JOIN posts p ON p.conversation_id = c.root_id
         LEFT JOIN read_state r ON r.post_id = p.id
         GROUP BY c.root_id
         ORDER BY c.fetched_at DESC`,
      )
      .all<ConversationRow>();
    return results.map(rowToSummary);
  }

  async upsertPosts(posts: Post[]): Promise<void> {
    if (posts.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO posts
         (id, conversation_id, parent_id, author_id, author_handle, author_name,
          author_avatar_url, text, created_at, likes, replies, reposts, quotes,
          impressions, bookmarks, entities_json, quoted_post_id, media_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await this.db.batch(
      posts.map((p) =>
        stmt.bind(
          p.id,
          p.conversationId,
          p.parentId,
          p.authorId,
          p.authorHandle,
          p.authorName,
          p.authorAvatarUrl,
          p.text,
          p.createdAt,
          p.metrics.likes,
          p.metrics.replies,
          p.metrics.reposts,
          p.metrics.quotes,
          p.metrics.impressions,
          p.metrics.bookmarks,
          p.entities ? JSON.stringify(p.entities) : null,
          p.quotedPostId,
          p.media ? JSON.stringify(p.media) : null,
          p.fetchedAt,
        ),
      ),
    );
  }

  async getPosts(conversationId: string): Promise<Post[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM posts WHERE conversation_id = ? ORDER BY created_at ASC`)
      .bind(conversationId)
      .all<PostRow>();
    return results.map(rowToPost);
  }

  async getPostsByIds(ids: string[]): Promise<Post[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<PostRow>();
    return results.map(rowToPost);
  }

  async getPost(id: string): Promise<Post | null> {
    const row = await this.db
      .prepare(`SELECT * FROM posts WHERE id = ?`)
      .bind(id)
      .first<PostRow>();
    return row ? rowToPost(row) : null;
  }

  async hasPost(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT id FROM posts WHERE id = ?`)
      .bind(id)
      .first<{ id: string }>();
    return row !== null;
  }

  async newestPostId(conversationId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM posts WHERE conversation_id = ?
         ORDER BY LENGTH(id) DESC, id DESC LIMIT 1`,
      )
      .bind(conversationId)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async existingPostIds(conversationId: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare(`SELECT id FROM posts WHERE conversation_id = ?`)
      .bind(conversationId)
      .all<{ id: string }>();
    return new Set(results.map((row) => row.id));
  }

  async getUnreadIds(conversationId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.id FROM posts p
         LEFT JOIN read_state r ON r.post_id = p.id
         WHERE p.conversation_id = ? AND r.post_id IS NULL`,
      )
      .bind(conversationId)
      .all<{ id: string }>();
    return results.map((row) => row.id);
  }

  async setReadState(postIds: string[], read: boolean): Promise<void> {
    if (postIds.length === 0) return;
    if (read) {
      const at = new Date().toISOString();
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO read_state (post_id, read_at) VALUES (?, ?)`,
      );
      await this.db.batch(postIds.map((id) => stmt.bind(id, at)));
    } else {
      const placeholders = postIds.map(() => "?").join(",");
      await this.db
        .prepare(`DELETE FROM read_state WHERE post_id IN (${placeholders})`)
        .bind(...postIds)
        .run();
    }
  }

  async markConversationRead(conversationId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO read_state (post_id, read_at)
         SELECT id, ? FROM posts WHERE conversation_id = ?`,
      )
      .bind(new Date().toISOString(), conversationId)
      .run();
  }
}

import type { Post } from "../shared/types";
import { MAX_SQL_PARAMS, chunked } from "./chunk";
import {
  rowToPost,
  rowToSummary,
  type ConversationMeta,
  type ConversationRow,
  type ConversationRowSummary,
  type OAuthTokens,
  type PostRow,
  type SavedItem,
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

  /** Unordered: callers key the result by id (getQuotedFor, /api/saved). */
  async getPostsByIds(ids: string[]): Promise<Post[]> {
    const posts: Post[] = [];
    for (const chunk of chunked(ids, MAX_SQL_PARAMS)) {
      const placeholders = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all<PostRow>();
      posts.push(...results.map(rowToPost));
    }
    return posts;
  }

  async postIdsReadToday(ids: string[]): Promise<Set<string>> {
    const today = new Date().toISOString().slice(0, 10);
    const found = new Set<string>();
    // One short: `today` is bound alongside the ids in every statement.
    for (const chunk of chunked(ids, MAX_SQL_PARAMS - 1)) {
      const placeholders = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(
          `SELECT id FROM posts WHERE id IN (${placeholders}) AND substr(fetched_at, 1, 10) = ?`,
        )
        .bind(...chunk, today)
        .all<{ id: string }>();
      for (const row of results ?? []) found.add(row.id);
    }
    return found;
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
      await this.db.batch(
        chunked(postIds, MAX_SQL_PARAMS).map((chunk) =>
          this.db
            .prepare(
              `DELETE FROM read_state WHERE post_id IN (${chunk.map(() => "?").join(",")})`,
            )
            .bind(...chunk),
        ),
      );
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

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
      )
      .bind(key, value, new Date().toISOString())
      .run();
  }

  async listSavedItems(): Promise<SavedItem[]> {
    const { results } = await this.db
      .prepare(`SELECT post_id, source, added_at FROM saved_items ORDER BY added_at DESC`)
      .all<{ post_id: string; source: string; added_at: string }>();
    return (results ?? []).map((r) => ({
      postId: r.post_id,
      source: r.source,
      addedAt: r.added_at,
    }));
  }

  async addSavedItems(items: SavedItem[]): Promise<void> {
    if (items.length === 0) return;
    // INSERT OR IGNORE: re-syncing must not reset a row's original addedAt.
    await this.db.batch(
      items.map((item) =>
        this.db
          .prepare(`INSERT OR IGNORE INTO saved_items (post_id, source, added_at) VALUES (?, ?, ?)`)
          .bind(item.postId, item.source, item.addedAt),
      ),
    );
  }

  async removeSavedItem(postId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM saved_items WHERE post_id = ?`).bind(postId).run();
  }

  async getOAuthTokens(id: string): Promise<OAuthTokens | null> {
    const row = await this.db
      .prepare(
        `SELECT access_token, refresh_token, expires_at, scope, user_id FROM oauth_tokens WHERE id = ?`,
      )
      .bind(id)
      .first<{
        access_token: string;
        refresh_token: string;
        expires_at: number;
        scope: string;
        user_id: string | null;
      }>();
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      scope: row.scope,
      userId: row.user_id,
    };
  }

  async putOAuthTokens(id: string, tokens: OAuthTokens): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO oauth_tokens
           (id, access_token, refresh_token, expires_at, scope, user_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresAt,
        tokens.scope,
        tokens.userId ?? null,
        new Date().toISOString(),
      )
      .run();
  }
}

import type { Post } from "../../shared/types";
import {
  rowToPost,
  type ConversationMeta,
  type ConversationRow,
  type OAuthTokens,
  type PostRow,
  type SavedItem,
  type Storage,
} from "../storage";
import { chunked, placeholders, type SqlDriver } from "./driver";

interface IdRow {
  id: string;
}

interface SavedItemRow {
  post_id: string;
  source: string;
  added_at: string;
}

interface OAuthTokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  user_id: string | null;
}

const UPSERT_POST = `INSERT OR REPLACE INTO posts
   (id, conversation_id, parent_id, author_id, author_handle, author_name,
    author_avatar_url, text, created_at, likes, replies, reposts, quotes,
    impressions, bookmarks, entities_json, quoted_post_id, media_json, fetched_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const MARK_READ = `INSERT OR REPLACE INTO read_state (post_id, read_at) VALUES (?, ?)`;

function postParams(p: Post): unknown[] {
  return [
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
  ];
}

function toSavedItem(row: SavedItemRow): SavedItem {
  return { postId: row.post_id, source: row.source, addedAt: row.added_at };
}

/**
 * The one Storage implementation. Every query is written here exactly once and
 * runs on whichever SqlDriver it was constructed with — bun:sqlite locally,
 * D1 on the Worker.
 *
 * Chunking of `IN (…)` lists lives here rather than in the driver: only the
 * store knows how many of a statement's parameters are ids and how many are
 * fixed extras riding along.
 */
export class SqlStore implements Storage {
  constructor(private readonly db: SqlDriver) {}

  async getConversationMeta(rootId: string): Promise<Omit<ConversationMeta, "rootId"> | null> {
    const row = await this.db.first<ConversationRow>(
      `SELECT * FROM conversations WHERE root_id = ?`,
      [rootId],
    );
    if (!row) return null;
    return {
      rootAuthorHandle: row.root_author_handle,
      rootText: row.root_text,
      rootCreatedAt: row.root_created_at,
      fetchedAt: row.fetched_at,
    };
  }

  async upsertConversation(meta: ConversationMeta): Promise<void> {
    await this.db.run(
      `INSERT INTO conversations (root_id, root_author_handle, root_text, root_created_at, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(root_id) DO UPDATE SET fetched_at = excluded.fetched_at`,
      [meta.rootId, meta.rootAuthorHandle, meta.rootText, meta.rootCreatedAt, meta.fetchedAt],
    );
  }

  async hasConversation(rootId: string): Promise<boolean> {
    const row = await this.db.first<{ root_id: string }>(
      `SELECT root_id FROM conversations WHERE root_id = ?`,
      [rootId],
    );
    return row !== null;
  }

  async hasConversations(rootIds: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunked(rootIds, this.db.maxParams)) {
      const rows = await this.db.all<{ root_id: string }>(
        `SELECT root_id FROM conversations WHERE root_id IN (${placeholders(chunk.length)})`,
        chunk,
      );
      for (const row of rows) found.add(row.root_id);
    }
    return found;
  }

  async upsertPosts(posts: Post[]): Promise<void> {
    if (posts.length === 0) return;
    await this.db.batch(posts.map((p) => ({ sql: UPSERT_POST, params: postParams(p) })));
  }

  async getPosts(conversationId: string): Promise<Post[]> {
    const rows = await this.db.all<PostRow>(
      `SELECT * FROM posts WHERE conversation_id = ? ORDER BY created_at ASC`,
      [conversationId],
    );
    return rows.map(rowToPost);
  }

  /** Unordered: callers key the result by id (getQuotedFor, /api/saved). */
  async getPostsByIds(ids: string[]): Promise<Post[]> {
    const posts: Post[] = [];
    for (const chunk of chunked(ids, this.db.maxParams)) {
      const rows = await this.db.all<PostRow>(
        `SELECT * FROM posts WHERE id IN (${placeholders(chunk.length)})`,
        chunk,
      );
      posts.push(...rows.map(rowToPost));
    }
    return posts;
  }

  async postIdsReadToday(ids: string[]): Promise<Set<string>> {
    const today = new Date().toISOString().slice(0, 10);
    const found = new Set<string>();
    // One short: `today` is bound alongside the ids in every statement.
    for (const chunk of chunked(ids, this.db.maxParams - 1)) {
      const rows = await this.db.all<IdRow>(
        `SELECT id FROM posts WHERE id IN (${placeholders(chunk.length)})
           AND substr(fetched_at, 1, 10) = ?`,
        [...chunk, today],
      );
      for (const row of rows) found.add(row.id);
    }
    return found;
  }

  async getPost(id: string): Promise<Post | null> {
    const row = await this.db.first<PostRow>(`SELECT * FROM posts WHERE id = ?`, [id]);
    return row ? rowToPost(row) : null;
  }

  async hasPost(id: string): Promise<boolean> {
    const row = await this.db.first<IdRow>(`SELECT id FROM posts WHERE id = ?`, [id]);
    return row !== null;
  }

  async newestPostId(conversationId: string): Promise<string | null> {
    const row = await this.db.first<IdRow>(
      `SELECT id FROM posts WHERE conversation_id = ?
       ORDER BY LENGTH(id) DESC, id DESC LIMIT 1`,
      [conversationId],
    );
    return row?.id ?? null;
  }

  async existingPostIds(conversationId: string): Promise<Set<string>> {
    const rows = await this.db.all<IdRow>(`SELECT id FROM posts WHERE conversation_id = ?`, [
      conversationId,
    ]);
    return new Set(rows.map((row) => row.id));
  }

  async getUnreadIds(conversationId: string): Promise<string[]> {
    const rows = await this.db.all<IdRow>(
      `SELECT p.id FROM posts p
       LEFT JOIN read_state r ON r.post_id = p.id
       WHERE p.conversation_id = ? AND r.post_id IS NULL`,
      [conversationId],
    );
    return rows.map((row) => row.id);
  }

  async setReadState(postIds: string[], read: boolean): Promise<void> {
    if (postIds.length === 0) return;
    if (read) {
      const at = new Date().toISOString();
      await this.db.batch(postIds.map((id) => ({ sql: MARK_READ, params: [id, at] })));
    } else {
      // One batch, so a multi-chunk unread lands whole or not at all.
      await this.db.batch(
        chunked(postIds, this.db.maxParams).map((chunk) => ({
          sql: `DELETE FROM read_state WHERE post_id IN (${placeholders(chunk.length)})`,
          params: chunk,
        })),
      );
    }
  }

  async markConversationRead(conversationId: string): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO read_state (post_id, read_at)
       SELECT id, ? FROM posts WHERE conversation_id = ?`,
      [new Date().toISOString(), conversationId],
    );
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db.first<{ value: string }>(
      `SELECT value FROM settings WHERE key = ?`,
      [key],
    );
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [key, value, new Date().toISOString()],
    );
  }

  async listSavedItems(): Promise<SavedItem[]> {
    const rows = await this.db.all<SavedItemRow>(
      `SELECT post_id, source, added_at FROM saved_items ORDER BY added_at DESC`,
    );
    return rows.map(toSavedItem);
  }

  async getSavedItem(postId: string): Promise<SavedItem | null> {
    const row = await this.db.first<SavedItemRow>(
      `SELECT post_id, source, added_at FROM saved_items WHERE post_id = ?`,
      [postId],
    );
    return row ? toSavedItem(row) : null;
  }

  async addSavedItems(items: SavedItem[]): Promise<void> {
    if (items.length === 0) return;
    // INSERT OR IGNORE: re-syncing must not reset a row's original addedAt.
    await this.db.batch(
      items.map((item) => ({
        sql: `INSERT OR IGNORE INTO saved_items (post_id, source, added_at) VALUES (?, ?, ?)`,
        params: [item.postId, item.source, item.addedAt],
      })),
    );
  }

  async removeSavedItem(postId: string): Promise<void> {
    await this.db.run(`DELETE FROM saved_items WHERE post_id = ?`, [postId]);
  }

  async removeSavedItems(postIds: string[]): Promise<void> {
    if (postIds.length === 0) return;
    // One batch, so a multi-chunk removal can't half-apply and leave the
    // saved list disagreeing with the folder it was reconciled against.
    await this.db.batch(
      chunked(postIds, this.db.maxParams).map((chunk) => ({
        sql: `DELETE FROM saved_items WHERE post_id IN (${placeholders(chunk.length)})`,
        params: chunk,
      })),
    );
  }

  async getOAuthTokens(id: string): Promise<OAuthTokens | null> {
    const row = await this.db.first<OAuthTokenRow>(
      `SELECT access_token, refresh_token, expires_at, scope, user_id
       FROM oauth_tokens WHERE id = ?`,
      [id],
    );
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
    await this.db.run(
      `INSERT OR REPLACE INTO oauth_tokens
         (id, access_token, refresh_token, expires_at, scope, user_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresAt,
        tokens.scope,
        tokens.userId ?? null,
        new Date().toISOString(),
      ],
    );
  }
}

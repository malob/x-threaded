import { Database } from "bun:sqlite";
import type { Post } from "../shared/types";
import { MAX_SQL_PARAMS, chunked } from "./chunk";
import {
  SCHEMA,
  rowToPost,
  type ConversationMeta,
  type ConversationRow,
  type OAuthTokens,
  type PostRow,
  type SavedItem,
  type Storage,
} from "./storage";

/**
 * bun:sqlite implementation of Storage for the Bun server. Synchronous under
 * the hood; async only to satisfy the shared interface.
 */
export class SqliteStore implements Storage {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run(SCHEMA);
    // CREATE TABLE IF NOT EXISTS won't add columns to a table that predates
    // them, so bring older local databases forward. (The Worker gets the
    // equivalent from migrations/.)
    this.addMissingColumns("posts", {
      entities_json: "TEXT",
      quoted_post_id: "TEXT",
      media_json: "TEXT",
      bookmarks: "INTEGER NOT NULL DEFAULT 0",
    });
    this.addMissingColumns("oauth_tokens", { user_id: "TEXT" });
  }

  private addMissingColumns(table: string, columns: Record<string, string>): void {
    const existing = new Set(
      this.db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  async getConversationMeta(rootId: string): Promise<Omit<ConversationMeta, "rootId"> | null> {
    const row = this.db
      .query<ConversationRow, { $id: string }>(`SELECT * FROM conversations WHERE root_id = $id`)
      .get({ $id: rootId });
    if (!row) return null;
    return {
      rootAuthorHandle: row.root_author_handle,
      rootText: row.root_text,
      rootCreatedAt: row.root_created_at,
      fetchedAt: row.fetched_at,
    };
  }

  async upsertConversation(meta: ConversationMeta): Promise<void> {
    this.db
      .query(
        `INSERT INTO conversations (root_id, root_author_handle, root_text, root_created_at, fetched_at)
         VALUES ($rootId, $handle, $text, $createdAt, $fetchedAt)
         ON CONFLICT(root_id) DO UPDATE SET fetched_at = $fetchedAt`,
      )
      .run({
        $rootId: meta.rootId,
        $handle: meta.rootAuthorHandle,
        $text: meta.rootText,
        $createdAt: meta.rootCreatedAt,
        $fetchedAt: meta.fetchedAt,
      });
  }

  async hasConversation(rootId: string): Promise<boolean> {
    const row = this.db
      .query<{ root_id: string }, { $id: string }>(
        `SELECT root_id FROM conversations WHERE root_id = $id`,
      )
      .get({ $id: rootId });
    return row !== null;
  }

  async upsertPosts(posts: Post[]): Promise<void> {
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

  async getPosts(conversationId: string): Promise<Post[]> {
    const rows = this.db
      .query<PostRow, { $id: string }>(
        `SELECT * FROM posts WHERE conversation_id = $id ORDER BY created_at ASC`,
      )
      .all({ $id: conversationId });
    return rows.map(rowToPost);
  }

  /**
   * Unordered: callers key the result by id (getQuotedFor, /api/saved).
   * Chunked to match D1, which caps a statement at MAX_SQL_PARAMS bound
   * parameters — bun:sqlite would take the whole list, but the two stores
   * answering identically is worth more than the saved round trips.
   */
  async getPostsByIds(ids: string[]): Promise<Post[]> {
    const posts: Post[] = [];
    for (const chunk of chunked(ids, MAX_SQL_PARAMS)) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .query<PostRow, string[]>(`SELECT * FROM posts WHERE id IN (${placeholders})`)
        .all(...chunk);
      posts.push(...rows.map(rowToPost));
    }
    return posts;
  }

  async postIdsReadToday(ids: string[]): Promise<Set<string>> {
    const today = new Date().toISOString().slice(0, 10);
    const found = new Set<string>();
    // One short: `today` is bound alongside the ids in every statement.
    for (const chunk of chunked(ids, MAX_SQL_PARAMS - 1)) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .query<{ id: string }, string[]>(
          `SELECT id FROM posts WHERE id IN (${placeholders}) AND substr(fetched_at, 1, 10) = ?`,
        )
        .all(...chunk, today);
      for (const row of rows) found.add(row.id);
    }
    return found;
  }

  async getPost(id: string): Promise<Post | null> {
    const row = this.db
      .query<PostRow, { $id: string }>(`SELECT * FROM posts WHERE id = $id`)
      .get({ $id: id });
    return row ? rowToPost(row) : null;
  }

  async hasPost(id: string): Promise<boolean> {
    const row = this.db
      .query<{ id: string }, { $id: string }>(`SELECT id FROM posts WHERE id = $id`)
      .get({ $id: id });
    return row !== null;
  }

  async newestPostId(conversationId: string): Promise<string | null> {
    const row = this.db
      .query<{ id: string }, { $id: string }>(
        `SELECT id FROM posts WHERE conversation_id = $id
         ORDER BY LENGTH(id) DESC, id DESC LIMIT 1`,
      )
      .get({ $id: conversationId });
    return row?.id ?? null;
  }

  async existingPostIds(conversationId: string): Promise<Set<string>> {
    const rows = this.db
      .query<{ id: string }, { $id: string }>(
        `SELECT id FROM posts WHERE conversation_id = $id`,
      )
      .all({ $id: conversationId });
    return new Set(rows.map((row) => row.id));
  }

  async getUnreadIds(conversationId: string): Promise<string[]> {
    return this.db
      .query<{ id: string }, { $id: string }>(
        `SELECT p.id FROM posts p
         LEFT JOIN read_state r ON r.post_id = p.id
         WHERE p.conversation_id = $id AND r.post_id IS NULL`,
      )
      .all({ $id: conversationId })
      .map((row) => row.id);
  }

  async setReadState(postIds: string[], read: boolean): Promise<void> {
    if (postIds.length === 0) return;
    if (read) {
      const stmt = this.db.query(
        `INSERT OR REPLACE INTO read_state (post_id, read_at) VALUES ($id, $at)`,
      );
      const at = new Date().toISOString();
      const insertAll = this.db.transaction((ids: string[]) => {
        for (const id of ids) stmt.run({ $id: id, $at: at });
      });
      insertAll(postIds);
    } else {
      const deleteAll = this.db.transaction((chunks: string[][]) => {
        for (const chunk of chunks) {
          const placeholders = chunk.map(() => "?").join(",");
          this.db.run(`DELETE FROM read_state WHERE post_id IN (${placeholders})`, chunk);
        }
      });
      deleteAll(chunked(postIds, MAX_SQL_PARAMS));
    }
  }

  async getSetting(key: string): Promise<string | null> {
    const row = this.db
      .query<{ value: string }, { $key: string }>(`SELECT value FROM settings WHERE key = $key`)
      .get({ $key: key });
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db
      .query(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ($key, $value, $at)`)
      .run({ $key: key, $value: value, $at: new Date().toISOString() });
  }

  async listSavedItems(): Promise<SavedItem[]> {
    return this.db
      .query<{ post_id: string; source: string; added_at: string }, []>(
        `SELECT post_id, source, added_at FROM saved_items ORDER BY added_at DESC`,
      )
      .all()
      .map((r) => ({ postId: r.post_id, source: r.source, addedAt: r.added_at }));
  }

  async addSavedItems(items: SavedItem[]): Promise<void> {
    if (items.length === 0) return;
    // INSERT OR IGNORE: re-syncing must not reset a row's original addedAt.
    const stmt = this.db.query(
      `INSERT OR IGNORE INTO saved_items (post_id, source, added_at) VALUES ($id, $source, $at)`,
    );
    const insertAll = this.db.transaction((rows: SavedItem[]) => {
      for (const item of rows) {
        stmt.run({ $id: item.postId, $source: item.source, $at: item.addedAt });
      }
    });
    insertAll(items);
  }

  async removeSavedItem(postId: string): Promise<void> {
    this.db.run(`DELETE FROM saved_items WHERE post_id = ?`, [postId]);
  }

  async getOAuthTokens(id: string): Promise<OAuthTokens | null> {
    const row = this.db
      .query<
        {
          access_token: string;
          refresh_token: string;
          expires_at: number;
          scope: string;
          user_id: string | null;
        },
        { $id: string }
      >(
        `SELECT access_token, refresh_token, expires_at, scope, user_id FROM oauth_tokens WHERE id = $id`,
      )
      .get({ $id: id });
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
    this.db
      .query(
        `INSERT OR REPLACE INTO oauth_tokens
           (id, access_token, refresh_token, expires_at, scope, user_id, updated_at)
         VALUES ($id, $access, $refresh, $expires, $scope, $userId, $updated)`,
      )
      .run({
        $id: id,
        $access: tokens.accessToken,
        $refresh: tokens.refreshToken,
        $expires: tokens.expiresAt,
        $scope: tokens.scope,
        $userId: tokens.userId ?? null,
        $updated: new Date().toISOString(),
      });
  }

  async markConversationRead(conversationId: string): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO read_state (post_id, read_at)
         SELECT id, $at FROM posts WHERE conversation_id = $id`,
      )
      .run({ $at: new Date().toISOString(), $id: conversationId });
  }
}

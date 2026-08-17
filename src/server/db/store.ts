import type { Post } from "../../shared/types";
import {
  rowToPost,
  type ConversationMeta,
  type ConversationResponseSnapshot,
  type ConversationRow,
  type ConversationRunClaim,
  type ConversationRunRow,
  type ConversationStatus,
  type BookmarkFolderSetting,
  type BookmarkDisposition,
  type BookmarkSyncCommit,
  type OAuthTokens,
  type OAuthStatusSnapshot,
  type OAuthReauthorizationPromotion,
  type PostRow,
  type SavedItem,
  type Storage,
  type StoredTokens,
  type TokenState,
  type UserProfile,
} from "../storage";
import type { SqlDriver } from "./driver";

interface IdRow {
  id: string;
}

interface SavedItemRow {
  post_id: string;
  source: string;
  added_at: string;
}

type ConversationResponseRow = Omit<PostRow, "id"> & {
  conversation_status: string;
  /** Null on the LEFT JOIN row for a conversation that has no posts. */
  id: string | null;
};

interface OAuthTokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  user_id: string | null;
  username: string | null;
  display_name: string | null;
  state: string;
  lease_id: string | null;
  lease_until: number | null;
  recovery_used: number;
  broken_reason: string | null;
}

type OAuthStatusRow = {
  account_generation: string;
  oauth_id: string | null;
} & {
  [K in keyof OAuthTokenRow]: OAuthTokenRow[K] | null;
};

const OAUTH_COLUMNS = `access_token, refresh_token, expires_at, scope, user_id, username,
   display_name, state, lease_id, lease_until, recovery_used, broken_reason`;

/**
 * The columns a rotation replaces. Profile fields that landed after the
 * refresher's row snapshot win: the refresh-token CAS proves this is still the
 * same grant, and overwriting those fields with the older null snapshot would
 * charge for getMe again. A fresh login changes the refresh token and makes
 * this whole UPDATE lose instead.
 */
const ROTATION_SET = `access_token = ?, refresh_token = ?, expires_at = ?, scope = ?,
       user_id = COALESCE(user_id, ?), username = COALESCE(username, ?),
       display_name = COALESCE(display_name, ?),
       state = 'ready', lease_id = NULL, lease_until = NULL,
       recovery_used = 0, broken_reason = NULL, updated_at = ?`;

function rotationParams(tokens: OAuthTokens): unknown[] {
  return [
    tokens.accessToken,
    tokens.refreshToken,
    tokens.expiresAt,
    tokens.scope,
    tokens.userId ?? null,
    tokens.username ?? null,
    tokens.displayName ?? null,
    new Date().toISOString(),
  ];
}

function toTokenState(value: string): TokenState {
  return value === "refreshing" ||
    value === "broken" ||
    value === "reauthorizing" ||
    value === "disconnecting"
    ? value
    : "ready";
}

function storedTokens(row: OAuthTokenRow): StoredTokens {
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    scope: row.scope,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    state: toTokenState(row.state),
    leaseId: row.lease_id,
    leaseUntil: row.lease_until,
    recoveryUsed: row.recovery_used !== 0,
    brokenReason: row.broken_reason,
  };
}

function toConversationStatus(value: string): ConversationStatus {
  return value === "partial" ? "partial" : "complete";
}

function conversationMeta(row: ConversationRow): Omit<ConversationMeta, "rootId"> {
  return {
    rootAuthorHandle: row.root_author_handle,
    rootText: row.root_text,
    rootCreatedAt: row.root_created_at,
    fetchedAt: row.fetched_at,
    status: toConversationStatus(row.status),
    fullReadAt: row.full_read_at,
  };
}

function priorConversationMeta(row: ConversationRunRow): Omit<ConversationMeta, "rootId"> | null {
  if (row.run_previous_status === null) return null;
  if (row.run_previous_fetched_at === null) {
    throw new Error(`conversation ${row.root_id} has an incomplete run snapshot`);
  }
  return {
    rootAuthorHandle: row.root_author_handle,
    rootText: row.root_text,
    rootCreatedAt: row.root_created_at,
    fetchedAt: row.run_previous_fetched_at,
    status: toConversationStatus(row.run_previous_status),
    fullReadAt: row.run_previous_full_read_at,
  };
}

const POST_COLUMNS = `id, conversation_id, parent_id, author_id, author_handle, author_name,
   author_avatar_url, text, created_at, likes, replies, reposts, quotes,
   impressions, bookmarks, entities_json, quoted_post_id, media_json, fetched_at`;

/**
 * Expand a JSON array of post-parameter arrays inside SQLite so one ordinary
 * API page is one D1 query, rather than one query per post. D1 officially
 * supports json_each() on a bound JSON string specifically to reduce query
 * round trips; that matters because Free Workers get 50 D1 queries for the
 * whole invocation, and every statement in db.batch() counts separately.
 */
const UPSERT_POSTS = `INSERT OR REPLACE INTO posts (${POST_COLUMNS})
 SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
        json_extract(value, '$[2]'), json_extract(value, '$[3]'),
        json_extract(value, '$[4]'), json_extract(value, '$[5]'),
        json_extract(value, '$[6]'), json_extract(value, '$[7]'),
        json_extract(value, '$[8]'), json_extract(value, '$[9]'),
        json_extract(value, '$[10]'), json_extract(value, '$[11]'),
        json_extract(value, '$[12]'), json_extract(value, '$[13]'),
        json_extract(value, '$[14]'), json_extract(value, '$[15]'),
        json_extract(value, '$[16]'), json_extract(value, '$[17]'),
        json_extract(value, '$[18]')
   FROM json_each(?)`;

// D1 permits a 2 MB string value. Leave ample headroom for encoding and
// platform changes while still fitting normal 100-post pages into one query.
const MAX_BOUND_JSON_BYTES = 1_500_000;
const UTF8 = new TextEncoder();

const BOOKMARK_FOLDER_KEY = "bookmark_folder_id";
const BOOKMARK_FOLDER_NAME_KEY = "bookmark_folder_name";
const BOOKMARK_SYNC_RUN_KEY = "bookmark_sync_run";
const USER_PROFILE_LEASE_PREFIX = "oauth_profile_lease:";
const OAUTH_INSTALL_LEASE_PREFIX = "oauth_install_lease:";
const ACCOUNT_GENERATION_PREFIX = "oauth_account_generation:";

function userProfileLeaseKey(id: string): string {
  return `${USER_PROFILE_LEASE_PREFIX}${id}`;
}

function oauthInstallLeaseKey(id: string): string {
  return `${OAUTH_INSTALL_LEASE_PREFIX}${id}`;
}

function accountGenerationKey(id: string): string {
  return `${ACCOUNT_GENERATION_PREFIX}${id}`;
}

function accountGenerationGuard(
  id: string,
  expectedAccountGeneration: string | undefined,
): { sql: string; params: unknown[] } {
  return expectedAccountGeneration === undefined
    ? { sql: "1", params: [] }
    : {
        sql: `EXISTS (
          SELECT 1 FROM settings WHERE key = ? AND value = ?
        )`,
        params: [accountGenerationKey(id), expectedAccountGeneration],
      };
}

/** Bind a settings lease to a grant without duplicating its refresh token. */
async function grantFingerprint(refreshToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", UTF8.encode(refreshToken));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function userProfileLeaseValue(leaseId: string, leaseUntil: number, grant: string): string {
  return JSON.stringify({ leaseId, leaseUntil, grant });
}

function bookmarkSyncLeaseValue(folderId: string, runId: string, leaseUntil: number): string {
  return JSON.stringify({
    v: 2,
    mode: "sync",
    sourceFolderId: folderId,
    folderId,
    runId,
    leaseUntil,
  });
}

function bookmarkSwitchLeaseValue(
  sourceFolderId: string | null,
  folderId: string,
  folderName: string,
  runId: string,
  leaseUntil: number,
): string {
  return JSON.stringify({
    v: 2,
    mode: "switch",
    sourceFolderId: sourceFolderId ?? "",
    folderId,
    folderName,
    runId,
    leaseUntil,
  });
}

/** Read a field without letting an old non-JSON settings value abort the query. */
function bookmarkLeaseField(
  field: "mode" | "sourceFolderId" | "folderId" | "folderName" | "runId" | "leaseUntil",
): string {
  return `json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.${field}')`;
}

/** Version-one leases used folderId as both the source and target. */
function bookmarkLeaseSource(): string {
  return `COALESCE(CAST(${bookmarkLeaseField("sourceFolderId")} AS TEXT), CAST(${bookmarkLeaseField("folderId")} AS TEXT), '')`;
}

/** Version-one leases were ordinary syncs. */
function bookmarkLeaseMode(): string {
  return `COALESCE(CAST(${bookmarkLeaseField("mode")} AS TEXT), 'sync')`;
}

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

/** Bound JSON payloads small enough for D1's value limit. */
function jsonBatches<T>(
  items: T[],
  serialize: (item: T) => string,
  describe: (item: T) => string,
): string[] {
  const batches: string[] = [];
  let rows: string[] = [];
  let bytes = 2; // opening and closing brackets

  const flush = () => {
    if (rows.length === 0) return;
    batches.push(`[${rows.join(",")}]`);
    rows = [];
    bytes = 2;
  };

  for (const item of items) {
    const row = serialize(item);
    const rowBytes = UTF8.encode(row).byteLength;
    if (rowBytes + 2 > MAX_BOUND_JSON_BYTES) {
      throw new Error(`${describe(item)} is too large to persist safely`);
    }
    const separatorBytes = rows.length === 0 ? 0 : 1;
    if (bytes + separatorBytes + rowBytes > MAX_BOUND_JSON_BYTES) flush();
    rows.push(row);
    bytes += (rows.length === 1 ? 0 : 1) + rowBytes;
  }
  flush();
  return batches;
}

function postJsonBatches(posts: Post[]): string[] {
  return jsonBatches(
    posts,
    (post) => JSON.stringify(postParams(post)),
    (post) => `post ${post.id}`,
  );
}

function idJsonBatches(ids: string[]): string[] {
  return jsonBatches(
    ids,
    (id) => JSON.stringify(id),
    (id) => `post id ${id}`,
  );
}

/** One bounded JSON value for operations whose meaning cannot be chunked. */
function boundJson(value: unknown, description: string): string {
  const json = JSON.stringify(value);
  if (UTF8.encode(json).byteLength > MAX_BOUND_JSON_BYTES) {
    throw new Error(`${description} is too large to persist safely`);
  }
  return json;
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
    return row ? conversationMeta(row) : null;
  }

  async getConversationResponseSnapshot(
    rootId: string,
  ): Promise<ConversationResponseSnapshot | null> {
    // One SELECT is the snapshot boundary. Separate metadata/posts queries
    // admit both status transitions between them: partial→complete can pair
    // an old subset with complete, and complete→partial can pair an old
    // complete flag with a newly appended partial page.
    const rows = await this.db.all<ConversationResponseRow>(
      `SELECT c.status AS conversation_status, p.*
         FROM conversations c
         LEFT JOIN posts p ON p.conversation_id = c.root_id
        WHERE c.root_id = ?
        ORDER BY p.created_at ASC`,
      [rootId],
    );
    const first = rows[0];
    if (!first) return null;
    const posts = rows
      .filter((row): row is ConversationResponseRow & { id: string } => typeof row.id === "string")
      .map((row) => rowToPost(row));
    return { status: toConversationStatus(first.conversation_status), posts };
  }

  async claimConversationRun(
    rootId: string,
    runId: string,
    startedAt: string,
    leaseUntil: number,
    now: number,
    wrotePosts: boolean,
  ): Promise<ConversationRunClaim | null> {
    // Capture the old lifecycle values in the same atomic statement that owns
    // the row. A later restore therefore needs only run_id, never a stale
    // in-process snapshot. An expired owner is replaceable; an active one is
    // the conflict branch and changes zero rows.
    const claimed = await this.db.run(
      `INSERT INTO conversations
         (root_id, root_author_handle, root_text, root_created_at, fetched_at, status, full_read_at,
          run_id, run_lease_until, run_wrote_posts, run_previous_status, run_previous_fetched_at,
          run_previous_full_read_at)
       VALUES (?, '', '', '', ?, 'partial', NULL, ?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT(root_id) DO UPDATE SET
         -- Recovering a write-less dead run inherits its original snapshot;
         -- recovering one that may have stored posts starts from partial.
         run_previous_status = CASE
           WHEN conversations.run_id IS NOT NULL AND conversations.run_wrote_posts = 0
             THEN conversations.run_previous_status
           ELSE conversations.status END,
         run_previous_fetched_at = CASE
           WHEN conversations.run_id IS NOT NULL AND conversations.run_wrote_posts = 0
             THEN conversations.run_previous_fetched_at
           ELSE conversations.fetched_at END,
         run_previous_full_read_at = CASE
           WHEN conversations.run_id IS NOT NULL AND conversations.run_wrote_posts = 0
             THEN conversations.run_previous_full_read_at
           ELSE conversations.full_read_at END,
         status = 'partial',
         run_id = excluded.run_id,
         run_lease_until = excluded.run_lease_until,
         run_wrote_posts = excluded.run_wrote_posts
       WHERE conversations.run_id IS NULL
          OR COALESCE(conversations.run_lease_until, 0) <= ?`,
      [rootId, startedAt, runId, leaseUntil, wrotePosts ? 1 : 0, now],
    );
    if (claimed.rowsAffected !== 1) return null;

    // D1's portable run() result has no RETURNING rows. The lease protects
    // this immediate read, and the columns above hold exactly the pre-claim
    // values even though status is now partial.
    const row = await this.db.first<ConversationRunRow>(
      `SELECT * FROM conversations WHERE root_id = ? AND run_id = ?`,
      [rootId, runId],
    );
    if (!row) throw new Error(`conversation ${rootId} lease disappeared after claim`);
    return { prior: priorConversationMeta(row) };
  }

  async renewConversationRun(
    rootId: string,
    runId: string,
    leaseUntil: number,
    willWritePosts: boolean,
  ): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE conversations SET
         run_lease_until = ?,
         run_wrote_posts = CASE WHEN ? = 1 THEN 1 ELSE run_wrote_posts END
       WHERE root_id = ? AND run_id = ?`,
      [leaseUntil, willWritePosts ? 1 : 0, rootId, runId],
    );
    return result.rowsAffected === 1;
  }

  async finishConversationRun(runId: string, meta: ConversationMeta): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE conversations SET
         fetched_at = ?, status = ?,
         -- Null means "no full read happened here", not "forget the last one".
         full_read_at = COALESCE(?, full_read_at),
         root_author_handle = COALESCE(NULLIF(root_author_handle, ''), ?),
         root_text = COALESCE(NULLIF(root_text, ''), ?),
         root_created_at = COALESCE(NULLIF(root_created_at, ''), ?),
         run_id = NULL, run_lease_until = NULL, run_wrote_posts = 0,
         run_previous_status = NULL, run_previous_fetched_at = NULL,
         run_previous_full_read_at = NULL
       WHERE root_id = ? AND run_id = ?`,
      [
        meta.fetchedAt,
        meta.status,
        meta.fullReadAt,
        meta.rootAuthorHandle,
        meta.rootText,
        meta.rootCreatedAt,
        meta.rootId,
        runId,
      ],
    );
    return result.rowsAffected === 1;
  }

  async abortConversationRun(rootId: string, runId: string): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE conversations SET
         status = CASE
           WHEN run_wrote_posts = 0 AND run_previous_status IS NOT NULL THEN run_previous_status
           ELSE status END,
         fetched_at = CASE
           WHEN run_wrote_posts = 0 AND run_previous_status IS NOT NULL THEN run_previous_fetched_at
           ELSE fetched_at END,
         full_read_at = CASE
           WHEN run_wrote_posts = 0 AND run_previous_status IS NOT NULL THEN run_previous_full_read_at
           ELSE full_read_at END,
         run_id = NULL, run_lease_until = NULL, run_wrote_posts = 0,
         run_previous_status = NULL, run_previous_fetched_at = NULL,
         run_previous_full_read_at = NULL
       WHERE root_id = ? AND run_id = ?`,
      [rootId, runId],
    );
    return result.rowsAffected === 1;
  }

  async upsertConversation(meta: ConversationMeta): Promise<void> {
    await this.db.run(
      `INSERT INTO conversations
         (root_id, root_author_handle, root_text, root_created_at, fetched_at, status, full_read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_id) DO UPDATE SET
         fetched_at = excluded.fetched_at,
         status = excluded.status,
         -- Null means "no full read happened here", not "forget the last one".
         full_read_at = COALESCE(excluded.full_read_at, full_read_at),
         -- Written once, when the root is first known: a lease claim leaves
         -- these blank, and a re-fetch must not clobber a known root.
         root_author_handle = COALESCE(NULLIF(root_author_handle, ''), excluded.root_author_handle),
         root_text = COALESCE(NULLIF(root_text, ''), excluded.root_text),
         root_created_at = COALESCE(NULLIF(root_created_at, ''), excluded.root_created_at)
       WHERE conversations.run_id IS NULL`,
      [
        meta.rootId,
        meta.rootAuthorHandle,
        meta.rootText,
        meta.rootCreatedAt,
        meta.fetchedAt,
        meta.status,
        meta.fullReadAt,
      ],
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
    for (const ids of idJsonBatches(rootIds)) {
      const rows = await this.db.all<{ root_id: string }>(
        `SELECT root_id FROM conversations
          WHERE root_id IN (SELECT value FROM json_each(?))`,
        [ids],
      );
      for (const row of rows) found.add(row.root_id);
    }
    return found;
  }

  async upsertPosts(posts: Post[]): Promise<void> {
    if (posts.length === 0) return;
    await this.db.batch(postJsonBatches(posts).map((json) => ({ sql: UPSERT_POSTS, params: [json] })));
  }

  async upsertPostsIfOAuthGrantCurrent(
    id: string,
    observedRefreshToken: string,
    posts: Post[],
    maxStatements = Number.POSITIVE_INFINITY,
    expectedAccountGeneration?: string,
  ): Promise<boolean> {
    if (posts.length === 0) {
      return await this.isOAuthGrantCurrent(id, observedRefreshToken, expectedAccountGeneration);
    }
    const batches = postJsonBatches(posts);
    if (batches.length > maxStatements) return false;
    const generation = accountGenerationGuard(id, expectedAccountGeneration);
    const results = await this.db.batch(
      batches.map((json) => ({
        sql: `${UPSERT_POSTS}
              WHERE EXISTS (
                SELECT 1 FROM oauth_tokens
                 WHERE id = ? AND refresh_token = ? AND state = 'ready'
              ) AND ${generation.sql}`,
        params: [json, id, observedRefreshToken, ...generation.params],
      })),
    );
    return results.every((result) => result.rowsAffected > 0);
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
    for (const json of idJsonBatches(ids)) {
      const rows = await this.db.all<PostRow>(
        `SELECT * FROM posts WHERE id IN (SELECT value FROM json_each(?))`,
        [json],
      );
      posts.push(...rows.map(rowToPost));
    }
    return posts;
  }

  async postIdsReadToday(ids: string[]): Promise<Set<string>> {
    const today = new Date().toISOString().slice(0, 10);
    const found = new Set<string>();
    for (const json of idJsonBatches(ids)) {
      const rows = await this.db.all<IdRow>(
        `SELECT id FROM posts WHERE id IN (SELECT value FROM json_each(?))
           AND substr(fetched_at, 1, 10) = ?`,
        [json, today],
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

  async oldestReplyId(conversationId: string): Promise<string | null> {
    // Numeric order out of a text column, the same way newestPostId gets it:
    // length first, then lexically. The root is the row whose id is its own
    // conversation id, and it is excluded (see the Storage docstring).
    const row = await this.db.first<IdRow>(
      `SELECT id FROM posts WHERE conversation_id = ? AND id <> conversation_id
       ORDER BY LENGTH(id) ASC, id ASC LIMIT 1`,
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
    const idBatches = idJsonBatches(postIds);
    if (read) {
      const at = new Date().toISOString();
      await this.db.batch(
        idBatches.map((ids) => ({
          sql: `INSERT OR REPLACE INTO read_state (post_id, read_at)
                SELECT value, ? FROM json_each(?)`,
          params: [at, ids],
        })),
      );
    } else {
      // One batch, so a multi-chunk unread lands whole or not at all.
      await this.db.batch(
        idBatches.map((ids) => ({
          sql: `DELETE FROM read_state WHERE post_id IN (SELECT value FROM json_each(?))`,
          params: [ids],
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

  async getBookmarkFolder(): Promise<BookmarkFolderSetting> {
    const row = await this.db.first<{ folder_id: string | null; folder_name: string | null }>(
      `SELECT
         (SELECT value FROM settings WHERE key = ?) AS folder_id,
         (SELECT value FROM settings WHERE key = ?) AS folder_name`,
      [BOOKMARK_FOLDER_KEY, BOOKMARK_FOLDER_NAME_KEY],
    );
    return { id: row?.folder_id ?? null, name: row?.folder_name ?? null };
  }

  async getBookmarkFolderForGeneration(
    expectedAccountGeneration: string,
  ): Promise<BookmarkFolderSetting | null> {
    const row = await this.db.first<{ folder_id: string | null; folder_name: string | null }>(
      `SELECT
         (SELECT value FROM settings WHERE key = ?) AS folder_id,
         (SELECT value FROM settings WHERE key = ?) AS folder_name
       FROM settings
       WHERE key = ? AND value = ?`,
      [
        BOOKMARK_FOLDER_KEY,
        BOOKMARK_FOLDER_NAME_KEY,
        accountGenerationKey("self"),
        expectedAccountGeneration,
      ],
    );
    return row ? { id: row.folder_id, name: row.folder_name } : null;
  }

  async setBookmarkFolder(folderId: string, folderName: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    // One statement keeps id/name inseparable and clears the current scan in
    // the same atomic change. A scan that returns afterward cannot reconcile
    // against a folder the user has already replaced.
    const settings = boundJson(
      [
        [BOOKMARK_FOLDER_KEY, folderId],
        [BOOKMARK_FOLDER_NAME_KEY, folderName],
        [BOOKMARK_SYNC_RUN_KEY, ""],
      ],
      "bookmark settings",
    );
    await this.db.run(
      `INSERT INTO settings (key, value, updated_at)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?
         FROM json_each(?)
        WHERE true
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`,
      [updatedAt, settings],
    );
  }

  async clearBookmarkFolder(
    disposition: BookmarkDisposition,
    expectedAccountGeneration?: string,
  ): Promise<boolean> {
    const operationKey = `bookmark_clear:${crypto.randomUUID()}`;
    const operationValue = "owned";
    const now = Date.now();
    const generation = accountGenerationGuard("self", expectedAccountGeneration);
    const owner = `EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)`;
    const savedMutation =
      disposition === "keep"
        ? `UPDATE saved_items SET source = 'manual'
             WHERE source = 'bookmark' AND ${owner}`
        : `DELETE FROM saved_items WHERE source = 'bookmark' AND ${owner}`;
    const results = await this.db.batch([
      {
        // The probe makes an otherwise empty clear observable while keeping
        // the ownership check in the same transaction as every mutation. A
        // disconnect that claimed first therefore wins; a clear that commits
        // first is a completed earlier choice that disconnect sees afterward.
        sql: `INSERT INTO settings (key, value, updated_at)
              SELECT ?, ?, ?
               WHERE NOT EXISTS (
                 SELECT 1 FROM oauth_tokens WHERE id = ? AND state = 'disconnecting'
               )
                 AND NOT EXISTS (
                   SELECT 1 FROM settings
                    WHERE key = ? AND json_valid(value)
                      AND COALESCE(CAST(json_extract(value, '$.leaseUntil') AS INTEGER), 0) > ?
               )
                 AND ${generation.sql}`,
        params: [
          operationKey,
          operationValue,
          new Date().toISOString(),
          "self",
          oauthInstallLeaseKey("self"),
          now,
          ...generation.params,
        ],
      },
      { sql: savedMutation, params: [operationKey, operationValue] },
      {
        // Recovering an expired first-login callback linearizes this clear
        // after it; deleting that owner prevents its stale completion from
        // later installing a grant against the state we just changed.
        sql: `DELETE FROM settings WHERE key IN (?, ?, ?, ?) AND ${owner}`,
        params: [
          BOOKMARK_FOLDER_KEY,
          BOOKMARK_FOLDER_NAME_KEY,
          BOOKMARK_SYNC_RUN_KEY,
          oauthInstallLeaseKey("self"),
          operationKey,
          operationValue,
        ],
      },
      {
        sql: `DELETE FROM settings WHERE key = ? AND value = ?`,
        params: [operationKey, operationValue],
      },
    ]);
    return results.at(-1)?.rowsAffected === 1;
  }

  async beginBookmarkSync(
    folderId: string,
    runId: string,
    leaseUntil: number,
    now: number,
    expectedAccountGeneration?: string,
  ): Promise<boolean> {
    const value = bookmarkSyncLeaseValue(folderId, runId, leaseUntil);
    const generation = accountGenerationGuard("self", expectedAccountGeneration);
    const result = await this.db.run(
      `INSERT INTO settings (key, value, updated_at)
       SELECT ?, ?, ?
        WHERE COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?
          AND ${generation.sql}
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at
       WHERE COALESCE(CAST(${bookmarkLeaseField("leaseUntil")} AS INTEGER), 0) <= ?
          OR ${bookmarkLeaseSource()} <> ?`,
      [
        BOOKMARK_SYNC_RUN_KEY,
        value,
        new Date().toISOString(),
        BOOKMARK_FOLDER_KEY,
        folderId,
        ...generation.params,
        now,
        folderId,
      ],
    );
    return result.rowsAffected === 1;
  }

  async renewBookmarkSync(
    folderId: string,
    runId: string,
    leaseUntil: number,
  ): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE settings
          SET value = ?, updated_at = ?
        WHERE key = ?
          AND ${bookmarkLeaseMode()} = 'sync'
          AND ${bookmarkLeaseSource()} = ?
          AND ${bookmarkLeaseField("folderId")} = ?
          AND ${bookmarkLeaseField("runId")} = ?
          AND COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?`,
      [
        bookmarkSyncLeaseValue(folderId, runId, leaseUntil),
        new Date().toISOString(),
        BOOKMARK_SYNC_RUN_KEY,
        folderId,
        folderId,
        runId,
        BOOKMARK_FOLDER_KEY,
        folderId,
      ],
    );
    return result.rowsAffected === 1;
  }

  async abortBookmarkSync(folderId: string, runId: string): Promise<boolean> {
    const result = await this.db.run(
      `DELETE FROM settings
        WHERE key = ?
          AND ${bookmarkLeaseMode()} = 'sync'
          AND ${bookmarkLeaseSource()} = ?
          AND ${bookmarkLeaseField("folderId")} = ?
          AND ${bookmarkLeaseField("runId")} = ?
          AND COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?`,
      [BOOKMARK_SYNC_RUN_KEY, folderId, folderId, runId, BOOKMARK_FOLDER_KEY, folderId],
    );
    return result.rowsAffected === 1;
  }

  async finishBookmarkSync(
    folderId: string,
    runId: string,
    posts: Post[],
    folderPostIds: string[],
    complete: boolean,
    addedAt: string,
    maxStatements = Number.POSITIVE_INFINITY,
  ): Promise<BookmarkSyncCommit> {
    const postStatements = postJsonBatches(posts).map((json) => ({
      sql: `${UPSERT_POSTS}
             WHERE (SELECT ${bookmarkLeaseField("runId")}
                      FROM settings
                     WHERE key = ? AND ${bookmarkLeaseMode()} = 'sync'
                       AND ${bookmarkLeaseSource()} = ?
                       AND ${bookmarkLeaseField("folderId")} = ?)
                   = ?
               AND COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?`,
      params: [
        json,
        BOOKMARK_SYNC_RUN_KEY,
        folderId,
        folderId,
        runId,
        BOOKMARK_FOLDER_KEY,
        folderId,
      ],
    }));
    const itemStatements = jsonBatches(
      posts,
      (post) => JSON.stringify([post.id, "bookmark", addedAt]),
      (post) => `saved item ${post.id}`,
    ).map((json) => ({
      sql: `INSERT OR IGNORE INTO saved_items (post_id, source, added_at)
            SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                   json_extract(value, '$[2]')
              FROM json_each(?)
             WHERE (SELECT ${bookmarkLeaseField("runId")}
                      FROM settings
                     WHERE key = ? AND ${bookmarkLeaseMode()} = 'sync'
                       AND ${bookmarkLeaseSource()} = ?
                       AND ${bookmarkLeaseField("folderId")} = ?)
                   = ?
               AND COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?`,
      params: [
        json,
        BOOKMARK_SYNC_RUN_KEY,
        folderId,
        folderId,
        runId,
        BOOKMARK_FOLDER_KEY,
        folderId,
      ],
    }));
    // Absence is meaningful only against the whole enumerated folder, so this
    // list cannot be split into independent NOT-EXISTS statements. The X
    // client caps it at 1,000 ids, well below the bounded JSON value ceiling.
    const folderIds = boundJson(folderPostIds, "bookmark folder ids");
    const removalStatements = complete
      ? [
          {
            sql: `DELETE FROM saved_items
                   WHERE source = 'bookmark'
                     AND NOT EXISTS (
                       SELECT 1 FROM json_each(?) AS folder
                        WHERE CAST(folder.value AS TEXT) = saved_items.post_id
                     )
                     AND (SELECT ${bookmarkLeaseField("runId")}
                            FROM settings
                           WHERE key = ? AND ${bookmarkLeaseMode()} = 'sync'
                             AND ${bookmarkLeaseSource()} = ?
                             AND ${bookmarkLeaseField("folderId")} = ?)
                         = ?
                     AND COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?`,
            params: [
              folderIds,
              BOOKMARK_SYNC_RUN_KEY,
              folderId,
              folderId,
              runId,
              BOOKMARK_FOLDER_KEY,
              folderId,
            ],
          },
        ]
      : [];
    const statements = [
      ...postStatements,
      ...itemStatements,
      ...removalStatements,
      {
        sql: `DELETE FROM settings
               WHERE key = ?
                 AND ${bookmarkLeaseMode()} = 'sync'
                 AND ${bookmarkLeaseSource()} = ?
                 AND ${bookmarkLeaseField("folderId")} = ?
                 AND ${bookmarkLeaseField("runId")} = ?
                 AND COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?`,
        params: [
          BOOKMARK_SYNC_RUN_KEY,
          folderId,
          folderId,
          runId,
          BOOKMARK_FOLDER_KEY,
          folderId,
        ],
      },
    ];
    if (statements.length > maxStatements) {
      return { applied: false, added: 0, removed: 0, budgetExceeded: true };
    }
    const results = await this.db.batch(statements);
    const itemStart = postStatements.length;
    const added = results
      .slice(itemStart, itemStart + itemStatements.length)
      .reduce((total, result) => total + result.rowsAffected, 0);
    const removalIndex = itemStart + itemStatements.length;
    const removed = complete ? (results[removalIndex]?.rowsAffected ?? 0) : 0;
    const released = results.at(-1)?.rowsAffected === 1;
    return {
      applied: released,
      added: released ? added : 0,
      removed: released ? removed : 0,
    };
  }

  async beginBookmarkFolderSwitch(
    sourceFolderId: string | null,
    targetFolderId: string,
    targetFolderName: string,
    runId: string,
    leaseUntil: number,
    now: number,
    expectedAccountGeneration?: string,
  ): Promise<boolean> {
    const source = sourceFolderId ?? "";
    const generation = accountGenerationGuard("self", expectedAccountGeneration);
    const { rowsAffected } = await this.db.run(
      `INSERT INTO settings (key, value, updated_at)
       SELECT ?, ?, ?
        WHERE COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?
          AND ${generation.sql}
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at
       WHERE COALESCE(CAST(${bookmarkLeaseField("leaseUntil")} AS INTEGER), 0) <= ?
          OR ${bookmarkLeaseSource()} <> ?`,
      [
        BOOKMARK_SYNC_RUN_KEY,
        bookmarkSwitchLeaseValue(
          sourceFolderId,
          targetFolderId,
          targetFolderName,
          runId,
          leaseUntil,
        ),
        new Date().toISOString(),
        BOOKMARK_FOLDER_KEY,
        source,
        ...generation.params,
        now,
        source,
      ],
    );
    return rowsAffected === 1;
  }

  async renewBookmarkFolderSwitch(
    sourceFolderId: string | null,
    targetFolderId: string,
    targetFolderName: string,
    runId: string,
    leaseUntil: number,
  ): Promise<boolean> {
    const source = sourceFolderId ?? "";
    const { rowsAffected } = await this.db.run(
      `UPDATE settings SET value = ?, updated_at = ?
        WHERE key = ? AND ${bookmarkLeaseMode()} = 'switch'
          AND ${bookmarkLeaseSource()} = ?
          AND ${bookmarkLeaseField("folderId")} = ?
          AND CAST(${bookmarkLeaseField("folderName")} AS TEXT) = ?
          AND ${bookmarkLeaseField("runId")} = ?
          AND COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?`,
      [
        bookmarkSwitchLeaseValue(
          sourceFolderId,
          targetFolderId,
          targetFolderName,
          runId,
          leaseUntil,
        ),
        new Date().toISOString(),
        BOOKMARK_SYNC_RUN_KEY,
        source,
        targetFolderId,
        targetFolderName,
        runId,
        BOOKMARK_FOLDER_KEY,
        source,
      ],
    );
    return rowsAffected === 1;
  }

  async abortBookmarkFolderSwitch(
    sourceFolderId: string | null,
    targetFolderId: string,
    runId: string,
  ): Promise<boolean> {
    const source = sourceFolderId ?? "";
    const { rowsAffected } = await this.db.run(
      `DELETE FROM settings
        WHERE key = ? AND ${bookmarkLeaseMode()} = 'switch'
          AND ${bookmarkLeaseSource()} = ?
          AND ${bookmarkLeaseField("folderId")} = ?
          AND ${bookmarkLeaseField("runId")} = ?
          AND COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?`,
      [
        BOOKMARK_SYNC_RUN_KEY,
        source,
        targetFolderId,
        runId,
        BOOKMARK_FOLDER_KEY,
        source,
      ],
    );
    return rowsAffected === 1;
  }

  async finishBookmarkFolderSwitch(
    sourceFolderId: string | null,
    targetFolderId: string,
    targetFolderName: string,
    runId: string,
    posts: Post[],
    folderPostIds: string[],
    addedAt: string,
    maxStatements = Number.POSITIVE_INFINITY,
  ): Promise<BookmarkSyncCommit> {
    const source = sourceFolderId ?? "";
    const guardSql = `(SELECT ${bookmarkLeaseField("runId")}
                         FROM settings
                        WHERE key = ? AND ${bookmarkLeaseMode()} = 'switch'
                          AND ${bookmarkLeaseSource()} = ?
                          AND ${bookmarkLeaseField("folderId")} = ?
                          AND CAST(${bookmarkLeaseField("folderName")} AS TEXT) = ?)
                      = ?
                    AND COALESCE((SELECT value FROM settings WHERE key = ?), '') = ?`;
    const guardParams = [
      BOOKMARK_SYNC_RUN_KEY,
      source,
      targetFolderId,
      targetFolderName,
      runId,
      BOOKMARK_FOLDER_KEY,
      source,
    ];
    const postStatements = postJsonBatches(posts).map((json) => ({
      sql: `${UPSERT_POSTS} WHERE ${guardSql}`,
      params: [json, ...guardParams],
    }));
    const itemStatements = jsonBatches(
      posts,
      (post) => JSON.stringify([post.id, "bookmark", addedAt]),
      (post) => `saved item ${post.id}`,
    ).map((json) => ({
      sql: `INSERT OR IGNORE INTO saved_items (post_id, source, added_at)
            SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                   json_extract(value, '$[2]')
              FROM json_each(?) WHERE ${guardSql}`,
      params: [json, ...guardParams],
    }));
    const removalStatement = {
      sql: `DELETE FROM saved_items
             WHERE source = 'bookmark'
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(?) AS folder
                  WHERE CAST(folder.value AS TEXT) = saved_items.post_id
               )
               AND ${guardSql}`,
      params: [boundJson(folderPostIds, "bookmark folder ids"), ...guardParams],
    };
    const activated = boundJson(
      [
        [BOOKMARK_FOLDER_KEY, targetFolderId],
        [BOOKMARK_FOLDER_NAME_KEY, targetFolderName],
        [BOOKMARK_SYNC_RUN_KEY, ""],
      ],
      "bookmark folder activation",
    );
    const activationStatement = {
      sql: `INSERT INTO settings (key, value, updated_at)
            SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?
              FROM json_each(?)
             WHERE ${guardSql}
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value, updated_at = excluded.updated_at`,
      params: [new Date().toISOString(), activated, ...guardParams],
    };
    const statements = [
      ...postStatements,
      ...itemStatements,
      removalStatement,
      activationStatement,
    ];
    if (statements.length > maxStatements) {
      return { applied: false, added: 0, removed: 0, budgetExceeded: true };
    }
    const results = await this.db.batch(statements);
    const itemStart = postStatements.length;
    const added = results
      .slice(itemStart, itemStart + itemStatements.length)
      .reduce((total, result) => total + result.rowsAffected, 0);
    const removed = results[itemStart + itemStatements.length]?.rowsAffected ?? 0;
    const applied = results.at(-1)?.rowsAffected === 3;
    return {
      applied,
      added: applied ? added : 0,
      removed: applied ? removed : 0,
    };
  }

  async listSavedItems(): Promise<SavedItem[]> {
    const rows = await this.db.all<SavedItemRow>(
      `SELECT post_id, source, added_at FROM saved_items ORDER BY added_at DESC`,
    );
    return rows.map(toSavedItem);
  }

  async hasSavedConversation(rootId: string): Promise<boolean> {
    // Through posts, not saved_items: the entry may be keyed on any reply in
    // the thread, and only the post row knows which conversation that is.
    const row = await this.db.first<{ post_id: string }>(
      `SELECT s.post_id FROM saved_items s
         JOIN posts p ON p.id = s.post_id
        WHERE p.conversation_id = ? LIMIT 1`,
      [rootId],
    );
    return row !== null;
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
      jsonBatches(
        items,
        (item) => JSON.stringify([item.postId, item.source, item.addedAt]),
        (item) => `saved item ${item.postId}`,
      ).map((json) => ({
        sql: `INSERT OR IGNORE INTO saved_items (post_id, source, added_at)
              SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                     json_extract(value, '$[2]')
                FROM json_each(?)`,
        params: [json],
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
      idJsonBatches(postIds).map((ids) => ({
        sql: `DELETE FROM saved_items WHERE post_id IN (SELECT value FROM json_each(?))`,
        params: [ids],
      })),
    );
  }

  async getOAuthTokens(id: string): Promise<StoredTokens | null> {
    const row = await this.db.first<OAuthTokenRow>(
      `SELECT ${OAUTH_COLUMNS} FROM oauth_tokens WHERE id = ?`,
      [id],
    );
    if (!row) return null;
    return storedTokens(row);
  }

  async getOAuthStatusSnapshot(
    id: string,
    generationCandidate: string,
  ): Promise<OAuthStatusSnapshot> {
    const key = accountGenerationKey(id);
    const row = await this.db.batchFirst<OAuthStatusRow>(
      [
        {
          sql: `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
          params: [key, generationCandidate, new Date().toISOString()],
        },
      ],
      {
        sql: `SELECT settings.value AS account_generation,
                     oauth_tokens.id AS oauth_id,
                     oauth_tokens.access_token AS access_token,
                     oauth_tokens.refresh_token AS refresh_token,
                     oauth_tokens.expires_at AS expires_at,
                     oauth_tokens.scope AS scope,
                     oauth_tokens.user_id AS user_id,
                     oauth_tokens.username AS username,
                     oauth_tokens.display_name AS display_name,
                     oauth_tokens.state AS state,
                     oauth_tokens.lease_id AS lease_id,
                     oauth_tokens.lease_until AS lease_until,
                     oauth_tokens.recovery_used AS recovery_used,
                     oauth_tokens.broken_reason AS broken_reason
                FROM settings
                LEFT JOIN oauth_tokens ON oauth_tokens.id = ?
               WHERE settings.key = ?`,
        params: [id, key],
      },
    );
    if (!row) throw new Error("OAuth status snapshot disappeared after initialization");
    return {
      accountGeneration: row.account_generation,
      tokens: row.oauth_id === null ? null : storedTokens(row as OAuthTokenRow),
    };
  }

  async getOAuthStatusForGeneration(
    id: string,
    expectedAccountGeneration: string,
  ): Promise<OAuthStatusSnapshot | null> {
    const row = await this.db.first<OAuthStatusRow>(
      `SELECT settings.value AS account_generation,
              oauth_tokens.id AS oauth_id,
              oauth_tokens.access_token AS access_token,
              oauth_tokens.refresh_token AS refresh_token,
              oauth_tokens.expires_at AS expires_at,
              oauth_tokens.scope AS scope,
              oauth_tokens.user_id AS user_id,
              oauth_tokens.username AS username,
              oauth_tokens.display_name AS display_name,
              oauth_tokens.state AS state,
              oauth_tokens.lease_id AS lease_id,
              oauth_tokens.lease_until AS lease_until,
              oauth_tokens.recovery_used AS recovery_used,
              oauth_tokens.broken_reason AS broken_reason
         FROM settings
         LEFT JOIN oauth_tokens ON oauth_tokens.id = ?
        WHERE settings.key = ? AND settings.value = ?`,
      [id, accountGenerationKey(id), expectedAccountGeneration],
    );
    return row
      ? {
          accountGeneration: row.account_generation,
          tokens: row.oauth_id === null ? null : storedTokens(row as OAuthTokenRow),
        }
      : null;
  }

  async getOrCreateAccountGeneration(id: string, candidate: string): Promise<string> {
    const key = accountGenerationKey(id);
    await this.db.run(
      `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [key, candidate, new Date().toISOString()],
    );
    const row = await this.db.first<{ value: string }>(
      `SELECT value FROM settings WHERE key = ?`,
      [key],
    );
    if (!row) throw new Error("account generation disappeared after initialization");
    return row.value;
  }

  async isOAuthGrantCurrent(
    id: string,
    observedRefreshToken: string,
    expectedAccountGeneration?: string,
  ): Promise<boolean> {
    const generation = accountGenerationGuard(id, expectedAccountGeneration);
    return (
      (await this.db.first<{ ok: number }>(
        `SELECT 1 AS ok FROM oauth_tokens
          WHERE id = ? AND refresh_token = ? AND state = 'ready'
            AND ${generation.sql}`,
        [id, observedRefreshToken, ...generation.params],
      )) !== null
    );
  }

  async putOAuthTokens(id: string, tokens: OAuthTokens): Promise<void> {
    // Every lease column is named rather than left to REPLACE's defaults, so
    // the reset is a statement of intent instead of a side effect. A fresh
    // grant can identify a different X account. Treat any bookmark-owned row
    // left without a grant as an orphan: preserve it as a manual local save,
    // clear the account-bound folder/leases, and install the token in one
    // transaction. Same-account reauthorization uses its narrower CAS method.
    const updatedAt = new Date().toISOString();
    await this.db.batch([
      {
        sql: `INSERT OR REPLACE INTO oauth_tokens
                (id, access_token, refresh_token, expires_at, scope, user_id, username,
                 display_name, state, lease_id, lease_until, recovery_used, broken_reason, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, NULL, 0, NULL, ?)`,
        params: [id, ...rotationParams(tokens)],
      },
      {
        sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET
                value = excluded.value, updated_at = excluded.updated_at`,
        params: [accountGenerationKey(id), crypto.randomUUID(), updatedAt],
      },
      {
        sql: `UPDATE saved_items SET source = 'manual' WHERE source = 'bookmark'`,
        params: [],
      },
      {
        sql: `DELETE FROM settings WHERE key IN (?, ?, ?, ?, ?)`,
        params: [
          BOOKMARK_FOLDER_KEY,
          BOOKMARK_FOLDER_NAME_KEY,
          BOOKMARK_SYNC_RUN_KEY,
          userProfileLeaseKey(id),
          oauthInstallLeaseKey(id),
        ],
      },
    ]);
  }

  async claimFreshOAuthInstall(
    id: string,
    leaseId: string,
    leaseUntil: number,
    now: number,
    expectedAccountGeneration?: string,
  ): Promise<boolean> {
    const value = JSON.stringify({ leaseId, leaseUntil });
    const generation = accountGenerationGuard(id, expectedAccountGeneration);
    const { rowsAffected } = await this.db.run(
      `INSERT INTO settings (key, value, updated_at)
       SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens WHERE id = ?)
         AND ${generation.sql}
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at
       WHERE COALESCE(
               CASE WHEN json_valid(settings.value)
                    THEN CAST(json_extract(settings.value, '$.leaseUntil') AS INTEGER) END,
               0
             ) <= ?
         AND NOT EXISTS (SELECT 1 FROM oauth_tokens WHERE id = ?)
         AND ${generation.sql}`,
      [
        oauthInstallLeaseKey(id),
        value,
        new Date().toISOString(),
        id,
        ...generation.params,
        now,
        id,
        ...generation.params,
      ],
    );
    return rowsAffected === 1;
  }

  async finishFreshOAuthInstall(
    id: string,
    leaseId: string,
    tokens: OAuthTokens,
  ): Promise<boolean> {
    const lease = `EXISTS (
      SELECT 1 FROM settings
       WHERE key = ? AND json_valid(value)
         AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
    )`;
    const current = `EXISTS (
      SELECT 1 FROM oauth_tokens WHERE id = ? AND refresh_token = ?
    )`;
    const accountGeneration = crypto.randomUUID();
    const results = await this.db.batch([
      {
        sql: `INSERT INTO oauth_tokens
                (id, access_token, refresh_token, expires_at, scope, user_id, username,
                 display_name, state, lease_id, lease_until, recovery_used, broken_reason, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, NULL, 0, NULL, ?
               WHERE ${lease}
              ON CONFLICT(id) DO NOTHING`,
        params: [id, ...rotationParams(tokens), oauthInstallLeaseKey(id), leaseId],
      },
      {
        sql: `INSERT INTO settings (key, value, updated_at)
              SELECT ?, ?, ? WHERE ${current} AND ${lease}
              ON CONFLICT(key) DO UPDATE SET
                value = excluded.value, updated_at = excluded.updated_at`,
        params: [
          accountGenerationKey(id),
          accountGeneration,
          new Date().toISOString(),
          id,
          tokens.refreshToken,
          oauthInstallLeaseKey(id),
          leaseId,
        ],
      },
      {
        sql: `UPDATE saved_items SET source = 'manual'
               WHERE source = 'bookmark' AND ${current} AND ${lease}`,
        params: [id, tokens.refreshToken, oauthInstallLeaseKey(id), leaseId],
      },
      {
        sql: `DELETE FROM settings
               WHERE key IN (?, ?, ?, ?) AND ${current} AND ${lease}`,
        params: [
          BOOKMARK_FOLDER_KEY,
          BOOKMARK_FOLDER_NAME_KEY,
          BOOKMARK_SYNC_RUN_KEY,
          userProfileLeaseKey(id),
          id,
          tokens.refreshToken,
          oauthInstallLeaseKey(id),
          leaseId,
        ],
      },
      {
        sql: `DELETE FROM settings
               WHERE key = ? AND json_valid(value)
                 AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?`,
        params: [oauthInstallLeaseKey(id), leaseId],
      },
    ]);
    return results[0]?.rowsAffected === 1;
  }

  async claimOAuthReauthorization(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
    leaseUntil: number,
    now: number,
    expectedAccountGeneration?: string,
  ): Promise<boolean> {
    const grant = await grantFingerprint(observedRefreshToken);
    const key = oauthInstallLeaseKey(id);
    const updatedAt = new Date().toISOString();
    const generation = accountGenerationGuard(id, expectedAccountGeneration);
    const claimable = `(state IN ('ready', 'broken')
      OR (state = 'reauthorizing' AND COALESCE(lease_until, 0) <= ?))`;
    const results = await this.db.batch([
      {
        // Store the displaced state in the owner record. A callback recovering
        // a pending callback therefore restores to pending on refusal, never
        // promotes an old pair whose validity is no longer known.
        sql: `INSERT INTO settings (key, value, updated_at)
              SELECT ?, json_object(
                           'leaseId', ?, 'leaseUntil', ?, 'grant', ?,
                           'priorState', state, 'priorReason', broken_reason
                         ), ?
               FROM oauth_tokens
               WHERE id = ? AND refresh_token = ? AND user_id IS NOT NULL
                 AND ${generation.sql}
                 AND ${claimable}
              ON CONFLICT(key) DO UPDATE SET
                value = excluded.value, updated_at = excluded.updated_at
              WHERE COALESCE(
                      CASE WHEN json_valid(settings.value)
                           THEN CAST(json_extract(settings.value, '$.leaseUntil') AS INTEGER) END,
                      0
                    ) <= ?`,
        params: [
          key,
          leaseId,
          leaseUntil,
          grant,
          updatedAt,
          id,
          observedRefreshToken,
          ...generation.params,
          now,
          now,
        ],
      },
      {
        // The row transition is the durable safety boundary. From this point
        // onward no account route may present the old pair, even if the Worker
        // dies after X consumes the authorization code.
        sql: `UPDATE oauth_tokens
                 SET state = 'reauthorizing', lease_id = ?, lease_until = ?,
                     broken_reason = COALESCE(
                       broken_reason,
                       'reauthorization outcome pending; retry Reconnect or disconnect X'
                     ),
                     updated_at = ?
               WHERE id = ? AND refresh_token = ? AND user_id IS NOT NULL
                 AND ${generation.sql}
                 AND ${claimable}
                 AND EXISTS (
                   SELECT 1 FROM settings
                    WHERE key = ? AND json_valid(value)
                      AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
                      AND CAST(json_extract(value, '$.grant') AS TEXT) = ?
                 )`,
        params: [
          leaseId,
          leaseUntil,
          updatedAt,
          id,
          observedRefreshToken,
          ...generation.params,
          now,
          key,
          leaseId,
          grant,
        ],
      },
    ]);
    return results[1]?.rowsAffected === 1;
  }

  async releaseOAuthCallbackLease(id: string, leaseId: string): Promise<boolean> {
    const { rowsAffected } = await this.db.run(
      `DELETE FROM settings
        WHERE key = ? AND json_valid(value)
          AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?`,
      [oauthInstallLeaseKey(id), leaseId],
    );
    return rowsAffected === 1;
  }

  async restoreOAuthReauthorization(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
  ): Promise<boolean> {
    const grant = await grantFingerprint(observedRefreshToken);
    const key = oauthInstallLeaseKey(id);
    const owner = `EXISTS (
      SELECT 1 FROM settings
       WHERE key = ? AND json_valid(value)
         AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
         AND CAST(json_extract(value, '$.grant') AS TEXT) = ?
    )`;
    const results = await this.db.batch([
      {
        sql: `UPDATE oauth_tokens
                 SET state = CASE
                       CAST(json_extract(
                         (SELECT value FROM settings WHERE key = ?), '$.priorState'
                       ) AS TEXT)
                       WHEN 'broken' THEN 'broken'
                       WHEN 'reauthorizing' THEN 'reauthorizing'
                       ELSE 'ready'
                     END,
                     lease_id = NULL, lease_until = NULL,
                     broken_reason = CASE
                       CAST(json_extract(
                         (SELECT value FROM settings WHERE key = ?), '$.priorState'
                       ) AS TEXT)
                       WHEN 'ready' THEN NULL
                       ELSE CAST(json_extract(
                         (SELECT value FROM settings WHERE key = ?), '$.priorReason'
                       ) AS TEXT)
                     END,
                     updated_at = ?
               WHERE id = ? AND refresh_token = ? AND state = 'reauthorizing'
                 AND lease_id = ? AND ${owner}`,
        params: [
          key,
          key,
          key,
          new Date().toISOString(),
          id,
          observedRefreshToken,
          leaseId,
          key,
          leaseId,
          grant,
        ],
      },
      {
        sql: `DELETE FROM settings
               WHERE key = ? AND json_valid(value)
                 AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
                 AND CAST(json_extract(value, '$.grant') AS TEXT) = ?`,
        params: [key, leaseId, grant],
      },
    ]);
    return results[0]?.rowsAffected === 1;
  }

  async settleOAuthReauthorizationPending(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
    reason: string,
  ): Promise<boolean> {
    const grant = await grantFingerprint(observedRefreshToken);
    const key = oauthInstallLeaseKey(id);
    const results = await this.db.batch([
      {
        sql: `UPDATE oauth_tokens
                 SET state = 'reauthorizing', lease_id = NULL, lease_until = NULL,
                     broken_reason = ?, updated_at = ?
               WHERE id = ? AND refresh_token = ? AND state = 'reauthorizing'
                 AND lease_id = ?
                 AND EXISTS (
                   SELECT 1 FROM settings
                    WHERE key = ? AND json_valid(value)
                      AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
                      AND CAST(json_extract(value, '$.grant') AS TEXT) = ?
                 )`,
        params: [
          reason,
          new Date().toISOString(),
          id,
          observedRefreshToken,
          leaseId,
          key,
          leaseId,
          grant,
        ],
      },
      {
        sql: `DELETE FROM settings
               WHERE key = ? AND json_valid(value)
                 AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
                 AND CAST(json_extract(value, '$.grant') AS TEXT) = ?`,
        params: [key, leaseId, grant],
      },
    ]);
    return results[0]?.rowsAffected === 1;
  }

  async probeOAuthReauthorizationPromotion(
    id: string,
    observedRefreshToken: string,
    replacementRefreshToken: string,
    leaseId: string,
  ): Promise<OAuthReauthorizationPromotion> {
    const row = await this.db.first<{ outcome: OAuthReauthorizationPromotion }>(
      `SELECT CASE
         WHEN refresh_token = ? THEN 'promoted'
         WHEN refresh_token = ? AND state = 'reauthorizing' AND lease_id = ?
           THEN 'owned-pending'
         ELSE 'superseded'
       END AS outcome
       FROM oauth_tokens WHERE id = ?`,
      [replacementRefreshToken, observedRefreshToken, leaseId, id],
    );
    return row?.outcome ?? "superseded";
  }

  async replaceOAuthTokensIfCurrent(
    id: string,
    observedRefreshToken: string,
    tokens: OAuthTokens,
    callbackLeaseId?: string,
  ): Promise<boolean> {
    if (callbackLeaseId) {
      const grant = await grantFingerprint(observedRefreshToken);
      const key = oauthInstallLeaseKey(id);
      const results = await this.db.batch([
        {
          sql: `UPDATE oauth_tokens
                  SET access_token = ?, refresh_token = ?, expires_at = ?, scope = ?,
                      user_id = ?, username = ?, display_name = ?, state = 'ready',
                      lease_id = NULL, lease_until = NULL, recovery_used = 0,
                      broken_reason = NULL, updated_at = ?
                WHERE id = ? AND refresh_token = ? AND state = 'reauthorizing'
                  AND lease_id = ?
                  AND EXISTS (
                    SELECT 1 FROM settings
                     WHERE key = ? AND json_valid(value)
                       AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
                       AND CAST(json_extract(value, '$.grant') AS TEXT) = ?
                  )`,
          params: [
            tokens.accessToken,
            tokens.refreshToken,
            tokens.expiresAt,
            tokens.scope,
            tokens.userId ?? null,
            tokens.username ?? null,
            tokens.displayName ?? null,
            new Date().toISOString(),
            id,
            observedRefreshToken,
            callbackLeaseId,
            key,
            callbackLeaseId,
            grant,
          ],
        },
        {
          sql: `DELETE FROM settings
                 WHERE key = ? AND json_valid(value)
                   AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
                   AND CAST(json_extract(value, '$.grant') AS TEXT) = ?`,
          params: [key, callbackLeaseId, grant],
        },
      ]);
      return results[0]?.rowsAffected === 1;
    }
    const { rowsAffected } = await this.db.run(
      `UPDATE oauth_tokens
          SET access_token = ?, refresh_token = ?, expires_at = ?, scope = ?,
              user_id = ?, username = ?, display_name = ?, state = 'ready',
              lease_id = NULL, lease_until = NULL, recovery_used = 0,
              broken_reason = NULL, updated_at = ?
        WHERE id = ? AND refresh_token = ? AND state IN ('ready', 'broken')`,
      [
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresAt,
        tokens.scope,
        tokens.userId ?? null,
        tokens.username ?? null,
        tokens.displayName ?? null,
        new Date().toISOString(),
        id,
        observedRefreshToken,
      ],
    );
    return rowsAffected === 1;
  }

  async claimOAuthDisconnect(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
    leaseUntil: number,
    now: number,
    expectedAccountGeneration?: string,
  ): Promise<boolean> {
    // The same transaction that elects the remote-revocation owner fences
    // every paid bookmark/profile operation it can. Each cleanup statement
    // repeats the winning lease predicate: D1 batches are transactions, but a
    // zero-row conditional first statement does not skip later statements.
    const owner = `EXISTS (
      SELECT 1 FROM oauth_tokens
       WHERE id = ? AND refresh_token = ? AND state = 'disconnecting' AND lease_id = ?
    )`;
    const generation = accountGenerationGuard(id, expectedAccountGeneration);
    const results = await this.db.batch([
      {
        sql: `UPDATE oauth_tokens
                 SET state = 'disconnecting', lease_id = ?, lease_until = ?, updated_at = ?
               WHERE id = ? AND refresh_token = ?
                 AND (state IN ('ready', 'broken', 'reauthorizing')
                      OR (state = 'disconnecting' AND COALESCE(lease_until, 0) <= ?))
                 AND NOT EXISTS (
                   SELECT 1 FROM settings
                    WHERE key = ? AND json_valid(value)
                      AND COALESCE(CAST(json_extract(value, '$.leaseUntil') AS INTEGER), 0) > ?
                 )
                 AND ${generation.sql}`,
        params: [
          leaseId,
          leaseUntil,
          new Date().toISOString(),
          id,
          observedRefreshToken,
          now,
          oauthInstallLeaseKey(id),
          now,
          ...generation.params,
        ],
      },
      {
        sql: `DELETE FROM settings WHERE key = ? AND ${owner}`,
        params: [BOOKMARK_SYNC_RUN_KEY, id, observedRefreshToken, leaseId],
      },
      {
        sql: `DELETE FROM settings WHERE key = ? AND ${owner}`,
        params: [userProfileLeaseKey(id), id, observedRefreshToken, leaseId],
      },
      {
        sql: `DELETE FROM settings WHERE key = ? AND ${owner}`,
        params: [oauthInstallLeaseKey(id), id, observedRefreshToken, leaseId],
      },
    ]);
    return results[0]?.rowsAffected === 1;
  }

  async finishOAuthDisconnect(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
    disposition: BookmarkDisposition,
  ): Promise<string | null> {
    const owner = `EXISTS (
      SELECT 1 FROM oauth_tokens
       WHERE id = ? AND refresh_token = ? AND state = 'disconnecting' AND lease_id = ?
    )`;
    const savedMutation =
      disposition === "keep"
        ? `UPDATE saved_items SET source = 'manual'
             WHERE source = 'bookmark' AND ${owner}`
        : `DELETE FROM saved_items WHERE source = 'bookmark' AND ${owner}`;
    const ownerParams = [id, observedRefreshToken, leaseId];
    const accountGeneration = crypto.randomUUID();
    const results = await this.db.batch([
      { sql: savedMutation, params: ownerParams },
      {
        sql: `INSERT INTO settings (key, value, updated_at)
              SELECT ?, ?, ? WHERE ${owner}
              ON CONFLICT(key) DO UPDATE SET
                value = excluded.value, updated_at = excluded.updated_at`,
        params: [
          accountGenerationKey(id),
          accountGeneration,
          new Date().toISOString(),
          ...ownerParams,
        ],
      },
      {
        sql: `DELETE FROM settings
               WHERE key IN (?, ?, ?, ?, ?) AND ${owner}`,
        params: [
          BOOKMARK_FOLDER_KEY,
          BOOKMARK_FOLDER_NAME_KEY,
          BOOKMARK_SYNC_RUN_KEY,
          userProfileLeaseKey(id),
          oauthInstallLeaseKey(id),
          ...ownerParams,
        ],
      },
      {
        sql: `DELETE FROM oauth_tokens
               WHERE id = ? AND refresh_token = ?
                 AND state = 'disconnecting' AND lease_id = ?`,
        params: ownerParams,
      },
    ]);
    return results.at(-1)?.rowsAffected === 1 ? accountGeneration : null;
  }

  async finishOAuthDisconnectWithoutGrant(
    disposition: BookmarkDisposition,
    expectedAccountGeneration?: string,
  ): Promise<string | null> {
    const operationKey = `oauth_disconnect_empty:${crypto.randomUUID()}`;
    const operationValue = "owned";
    const accountGeneration = crypto.randomUUID();
    const now = Date.now();
    const generation = accountGenerationGuard("self", expectedAccountGeneration);
    const owner = `EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)`;
    const savedMutation =
      disposition === "keep"
        ? `UPDATE saved_items SET source = 'manual'
             WHERE source = 'bookmark' AND ${owner}`
        : `DELETE FROM saved_items WHERE source = 'bookmark' AND ${owner}`;
    const results = await this.db.batch([
      {
        sql: `INSERT INTO settings (key, value, updated_at)
              SELECT ?, ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens WHERE id = ?)
                 AND NOT EXISTS (
                   SELECT 1 FROM settings
                    WHERE key = ? AND json_valid(value)
                      AND COALESCE(CAST(json_extract(value, '$.leaseUntil') AS INTEGER), 0) > ?
                 )
                 AND ${generation.sql}`,
        params: [
          operationKey,
          operationValue,
          new Date().toISOString(),
          "self",
          oauthInstallLeaseKey("self"),
          now,
          ...generation.params,
        ],
      },
      { sql: savedMutation, params: [operationKey, operationValue] },
      {
        // This is terminal even when it recovered an expired callback lease:
        // invalidate that exact owner before reporting Disconnect complete.
        sql: `DELETE FROM settings WHERE key IN (?, ?, ?, ?) AND ${owner}`,
        params: [
          BOOKMARK_FOLDER_KEY,
          BOOKMARK_FOLDER_NAME_KEY,
          BOOKMARK_SYNC_RUN_KEY,
          oauthInstallLeaseKey("self"),
          operationKey,
          operationValue,
        ],
      },
      {
        sql: `INSERT INTO settings (key, value, updated_at)
              SELECT ?, ?, ? WHERE ${owner}
              ON CONFLICT(key) DO UPDATE SET
                value = excluded.value, updated_at = excluded.updated_at`,
        params: [
          accountGenerationKey("self"),
          accountGeneration,
          new Date().toISOString(),
          operationKey,
          operationValue,
        ],
      },
      {
        sql: `DELETE FROM settings WHERE key = ? AND value = ?`,
        params: [operationKey, operationValue],
      },
    ]);
    return results.at(-1)?.rowsAffected === 1 ? accountGeneration : null;
  }

  async releaseOAuthDisconnect(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
  ): Promise<boolean> {
    const { rowsAffected } = await this.db.run(
      `UPDATE oauth_tokens
          SET state = CASE WHEN broken_reason IS NULL THEN 'ready' ELSE 'broken' END,
              lease_id = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND refresh_token = ? AND state = 'disconnecting' AND lease_id = ?`,
      [new Date().toISOString(), id, observedRefreshToken, leaseId],
    );
    return rowsAffected === 1;
  }

  async putUserProfile(
    id: string,
    observedRefreshToken: string,
    profile: UserProfile,
  ): Promise<boolean> {
    // Bound to the grant it identifies: a fresh login can replace the row
    // while the getMe that produced this profile was in flight, and writing
    // account A's identity onto account B's grant would silently operate on
    // the wrong account from then on (Stage 3 adversarial review, finding 3).
    const { rowsAffected } = await this.db.run(
      `UPDATE oauth_tokens SET user_id = ?, username = ?, display_name = ?, updated_at = ?
       WHERE id = ? AND refresh_token = ? AND state <> 'disconnecting'`,
      [
        profile.userId,
        profile.username,
        profile.displayName,
        new Date().toISOString(),
        id,
        observedRefreshToken,
      ],
    );
    return rowsAffected === 1;
  }

  async claimUserProfileLease(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
    leaseUntil: number,
    now: number,
    expectedAccountGeneration?: string,
  ): Promise<boolean> {
    const grant = await grantFingerprint(observedRefreshToken);
    const value = userProfileLeaseValue(leaseId, leaseUntil, grant);
    const generation = accountGenerationGuard(id, expectedAccountGeneration);
    const { rowsAffected } = await this.db.run(
      `INSERT INTO settings (key, value, updated_at)
       SELECT ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM oauth_tokens
           WHERE id = ? AND refresh_token = ? AND user_id IS NULL
             AND state IN ('ready', 'refreshing')
        )
          AND ${generation.sql}
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at
       WHERE COALESCE(
               CASE WHEN json_valid(settings.value)
                    THEN CAST(json_extract(settings.value, '$.leaseUntil') AS INTEGER) END,
               0
             ) <= ?
          OR COALESCE(
               CASE WHEN json_valid(settings.value)
                    THEN CAST(json_extract(settings.value, '$.grant') AS TEXT) END,
               ''
             ) <> ?`,
      [
        userProfileLeaseKey(id),
        value,
        new Date().toISOString(),
        id,
        observedRefreshToken,
        ...generation.params,
        now,
        grant,
      ],
    );
    return rowsAffected === 1;
  }

  async finishUserProfileLease(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
    profile: UserProfile,
  ): Promise<boolean> {
    const key = userProfileLeaseKey(id);
    const grant = await grantFingerprint(observedRefreshToken);
    // D1 batch and bun:sqlite's transaction make the identity write and lease
    // release one commit. The release still runs when the grant CAS loses, so
    // an obsolete holder does not strand its own lease; its predicates cannot
    // delete a newer grant's replacement lease.
    const results = await this.db.batch([
      {
        sql: `UPDATE oauth_tokens
                 SET user_id = ?, username = ?, display_name = ?, updated_at = ?
               WHERE id = ? AND refresh_token = ? AND user_id IS NULL
                 AND state IN ('ready', 'refreshing')
                 AND EXISTS (
                   SELECT 1 FROM settings
                    WHERE key = ?
                      AND json_valid(value)
                      AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
                      AND CAST(json_extract(value, '$.grant') AS TEXT) = ?
                 )`,
        params: [
          profile.userId,
          profile.username,
          profile.displayName,
          new Date().toISOString(),
          id,
          observedRefreshToken,
          key,
          leaseId,
          grant,
        ],
      },
      {
        sql: `DELETE FROM settings
               WHERE key = ?
                 AND json_valid(value)
                 AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
                 AND CAST(json_extract(value, '$.grant') AS TEXT) = ?`,
        params: [key, leaseId, grant],
      },
    ]);
    return results[0]?.rowsAffected === 1;
  }

  async releaseUserProfileLease(
    id: string,
    observedRefreshToken: string,
    leaseId: string,
  ): Promise<boolean> {
    const grant = await grantFingerprint(observedRefreshToken);
    const { rowsAffected } = await this.db.run(
      `DELETE FROM settings
        WHERE key = ?
          AND json_valid(value)
          AND CAST(json_extract(value, '$.leaseId') AS TEXT) = ?
          AND CAST(json_extract(value, '$.grant') AS TEXT) = ?`,
      [userProfileLeaseKey(id), leaseId, grant],
    );
    return rowsAffected === 1;
  }

  async claimTokenLease(
    id: string,
    observed: string,
    leaseId: string,
    leaseUntil: number,
    now = Date.now(),
  ): Promise<boolean> {
    const { rowsAffected } = await this.db.run(
      `UPDATE oauth_tokens
          SET state = 'refreshing', lease_id = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND state = 'ready' AND refresh_token = ?
          AND NOT EXISTS (
            SELECT 1 FROM settings
             WHERE key = ? AND json_valid(value)
               AND CAST(json_extract(value, '$.leaseUntil') AS INTEGER) > ?
          )`,
      [
        leaseId,
        leaseUntil,
        new Date().toISOString(),
        id,
        observed,
        oauthInstallLeaseKey(id),
        now,
      ],
    );
    return rowsAffected === 1;
  }

  async claimRecoveryLease(
    id: string,
    observed: string,
    leaseId: string,
    leaseUntil: number,
    expiredBefore: number,
  ): Promise<boolean> {
    const { rowsAffected } = await this.db.run(
      `UPDATE oauth_tokens
          SET lease_id = ?, lease_until = ?, recovery_used = 1, updated_at = ?
        WHERE id = ? AND state = 'refreshing' AND lease_until < ?
          AND recovery_used = 0 AND refresh_token = ?`,
      [leaseId, leaseUntil, new Date().toISOString(), id, expiredBefore, observed],
    );
    return rowsAffected === 1;
  }

  async finalizeTokenLease(
    id: string,
    leaseId: string,
    observed: string,
    next: OAuthTokens,
  ): Promise<boolean> {
    const { rowsAffected } = await this.db.run(
      `UPDATE oauth_tokens SET ${ROTATION_SET}
        WHERE id = ? AND lease_id = ? AND refresh_token = ?`,
      [...rotationParams(next), id, leaseId, observed],
    );
    return rowsAffected === 1;
  }

  async releaseTokenLease(id: string, leaseId: string, observed: string): Promise<boolean> {
    const { rowsAffected } = await this.db.run(
      `UPDATE oauth_tokens
          SET state = 'ready', lease_id = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND lease_id = ? AND refresh_token = ?`,
      [new Date().toISOString(), id, leaseId, observed],
    );
    return rowsAffected === 1;
  }

  async markTokenBroken(id: string, observed: string, reason: string): Promise<boolean> {
    const { rowsAffected } = await this.db.run(
      `UPDATE oauth_tokens
          SET state = 'broken', broken_reason = ?, lease_id = NULL, lease_until = NULL,
              updated_at = ?
        WHERE id = ? AND refresh_token = ?`,
      [reason, new Date().toISOString(), id, observed],
    );
    return rowsAffected === 1;
  }
}

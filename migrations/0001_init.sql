-- The schema, whole.
--
-- This file was six migrations (0001-0006) until 2026-08-15, when every
-- database that existed was already at 0006 and they were folded into one
-- baseline. The name is deliberately unchanged: wrangler and
-- src/server/db/migrations.ts both identify a migration by file name, so an
-- existing database has this name in its d1_migrations ledger, skips it, and
-- keeps the schema it already has. Only an empty database runs this.
--
-- Later schema changes go in new numbered files alongside this one, exactly as
-- before — the fold gave up the ability to migrate a database sitting at some
-- intermediate 2026-07 state, and nothing else.

-- A conversation is resumable state, not a yes/no cache entry: a fetch the
-- budget capped and a fetch that died mid-pagination both have history still
-- owed to them, and `status` is how a later read can tell (2026-07-30 review,
-- H2/H3).
CREATE TABLE IF NOT EXISTS conversations (
  root_id TEXT PRIMARY KEY,
  root_author_handle TEXT NOT NULL,
  root_text TEXT NOT NULL,
  root_created_at TEXT NOT NULL,
  -- When we last went to X about this conversation at all.
  fetched_at TEXT NOT NULL,
  -- 'partial' | 'complete'. A fetch opens the row as partial and only a run
  -- that exhausted the search closes it, so an interrupted fetch leaves a
  -- conversation that says what it is.
  status TEXT NOT NULL DEFAULT 'complete',
  -- When the last *complete full* read finished, which is what decides whether
  -- another one is free under X's same-UTC-calendar-day dedup. Distinct from
  -- fetched_at: a since_id refresh or a resume touches that one, and must not
  -- make the next refresh think a full re-read has already been paid for today.
  full_read_at TEXT
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

CREATE TABLE IF NOT EXISTS read_state (
  post_id TEXT PRIMARY KEY,
  read_at TEXT NOT NULL
);

-- OAuth 2.0 user-context tokens. Single row (id = 'self') for the personal
-- deployment; the id column leaves room for per-user rows if the app ever
-- serves more than its owner. Refresh tokens are single-use and rotate on
-- every refresh, so they can't live in a static secret — they live here.
--
-- The lease columns are durable coordination for exactly that: presenting one
-- refresh token twice can revoke the whole grant, so the refreshers have to
-- agree on a winner *before* anyone calls X (2026-07-30 review, C4).
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  -- Unix ms when the access token expires.
  expires_at INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  -- Cached from /2/users/me, which is a billable user read: resolve once, keep.
  -- Every user-context endpoint is addressed by user ID.
  user_id TEXT,
  state TEXT NOT NULL DEFAULT 'ready',
  -- Who holds the in-flight refresh: random per attempt, so a finalize can
  -- prove the lease it is closing is still the one it opened.
  lease_id TEXT,
  -- Unix ms. Past this the holder is presumed gone — but not presumed
  -- harmless: it may have exchanged the token before dying, so reclaiming is
  -- bounded.
  lease_until INTEGER,
  -- One recovery per grant, ever, until a fresh /auth/login. Persistent
  -- because the point is to survive the crash that made recovery necessary.
  recovery_used INTEGER NOT NULL DEFAULT 0,
  -- Why the grant died, for /api/auth/status to show next to the login link.
  broken_reason TEXT,
  -- The signed-in user's handle and display name, cached beside their ID so
  -- the inbox can name the account without a billable /2/users/me.
  username TEXT,
  display_name TEXT
);

-- App settings as key/value (currently just the bookmark folder to sync).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Posts queued for reading, one row per post: pulled from the chosen bookmark
-- folder ("bookmark") or added by hand in the app ("manual").
--
-- Shape only. The two sources are owned by different code, and neither one
-- touches the other's rows (all in src/server/app.ts):
--   "bookmark" — POST /api/bookmarks/sync adds and removes them, reconciling
--                against the folder on X; the route's comment, not this one,
--                describes that reconciliation.
--   "manual"   — saveUnlessRepresented() adds them while a conversation
--                loads, and DELETE /api/saved/:postId removes them (it
--                refuses on a "bookmark" row, which sync would only restore).
CREATE TABLE IF NOT EXISTS saved_items (
  post_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  added_at TEXT NOT NULL
);

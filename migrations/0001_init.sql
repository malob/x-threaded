-- Initial schema.
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

CREATE TABLE IF NOT EXISTS read_state (
  post_id TEXT PRIMARY KEY,
  read_at TEXT NOT NULL
);

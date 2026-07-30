-- OAuth 2.0 user-context tokens. Single row (id = 'self') for the personal
-- deployment; the id column leaves room for per-user rows if the app ever
-- serves more than its owner. Refresh tokens are single-use and rotate on
-- every refresh, so they can't live in a static secret — they live here.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  -- Unix ms when the access token expires.
  expires_at INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

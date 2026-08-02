-- App settings as key/value (currently just the bookmark folder to sync).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Posts queued for reading, one row per post: pulled from the chosen bookmark
-- folder ("bookmark") or added by hand in the app ("manual").
--
-- Shape only. What adds and removes rows is POST /api/bookmarks/sync in
-- src/server/app.ts, and it is the route's comment — not this one — that
-- describes the reconciliation.
CREATE TABLE IF NOT EXISTS saved_items (
  post_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  added_at TEXT NOT NULL
);

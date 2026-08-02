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

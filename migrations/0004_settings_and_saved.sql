-- App settings as key/value (currently just the bookmark folder to sync).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Posts queued for reading: pulled from the chosen bookmark folder, or added
-- by hand in the app. Additive by design — removing a bookmark on X does not
-- delete the row, the cached conversation, or its read state.
CREATE TABLE IF NOT EXISTS saved_items (
  post_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  added_at TEXT NOT NULL
);

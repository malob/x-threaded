-- Durable ownership for a conversation fetch. A Worker claims the row before
-- it calls X, and every lifecycle close/restore is conditional on run_id.
-- The previous values live beside the lease because D1 cannot atomically
-- return the pre-update row; they let a write-less failure restore exactly the
-- state its own claim changed, without carrying an unversioned snapshot in
-- process memory.
ALTER TABLE conversations ADD COLUMN run_id TEXT;
ALTER TABLE conversations ADD COLUMN run_lease_until INTEGER;
ALTER TABLE conversations ADD COLUMN run_wrote_posts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN run_previous_status TEXT;
ALTER TABLE conversations ADD COLUMN run_previous_fetched_at TEXT;
ALTER TABLE conversations ADD COLUMN run_previous_full_read_at TEXT;

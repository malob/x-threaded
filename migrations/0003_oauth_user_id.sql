-- Cache the authenticated user's ID alongside their tokens. Every
-- user-context endpoint is addressed by user ID, and /2/users/me is a
-- billable user read, so resolve it once and keep it.
ALTER TABLE oauth_tokens ADD COLUMN user_id TEXT;

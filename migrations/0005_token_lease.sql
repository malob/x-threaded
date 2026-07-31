-- Durable coordination for X's single-use refresh tokens.
--
-- Presenting one refresh token twice can revoke the whole grant, so the
-- refreshers have to agree on a winner *before* anyone calls X. These columns
-- are that agreement: a lease claimed by one conditional UPDATE, finalized by
-- another (2026-07-30 review, C4).
--
-- Bare ALTERs are safe here: this migration is post-ledger, so it runs exactly
-- once per database and needs no entry in RECORD_WITHOUT_RUN. The defaults are
-- what make an existing row legible to the new protocol — a grant written
-- before this migration reads back as ready, unleased, with recovery unused.
ALTER TABLE oauth_tokens ADD COLUMN state TEXT NOT NULL DEFAULT 'ready';
-- Who holds the in-flight refresh: random per attempt, so a finalize can prove
-- the lease it is closing is still the one it opened.
ALTER TABLE oauth_tokens ADD COLUMN lease_id TEXT;
-- Unix ms. Past this, the holder is presumed gone — but not presumed harmless:
-- it may have exchanged the token before dying, so reclaiming is bounded.
ALTER TABLE oauth_tokens ADD COLUMN lease_until INTEGER;
-- One recovery per grant, ever, until a fresh /auth/login. Persistent because
-- the point is to survive the crash that made recovery necessary.
ALTER TABLE oauth_tokens ADD COLUMN recovery_used INTEGER NOT NULL DEFAULT 0;
-- Why the grant died, for /api/auth/status to show next to the login link.
ALTER TABLE oauth_tokens ADD COLUMN broken_reason TEXT;
-- The signed-in user's handle and display name, cached beside their ID so the
-- inbox can name the account without a billable /2/users/me.
ALTER TABLE oauth_tokens ADD COLUMN username TEXT;
ALTER TABLE oauth_tokens ADD COLUMN display_name TEXT;

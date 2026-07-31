-- A conversation is resumable state, not a yes/no cache entry.
--
-- Before this, a fetch the budget capped and a fetch that died mid-pagination
-- were both indistinguishable from a whole conversation the moment the request
-- ended: `truncated` lived on the response and nowhere else, so every later
-- read called the cache complete and the skipped history could never be asked
-- for (2026-07-30 review, H2/H3).
--
-- Bare ALTERs are safe here: this migration is post-ledger, so it runs exactly
-- once per database and needs no entry in RECORD_WITHOUT_RUN.

-- 'partial' | 'complete'. A fetch opens the row as partial and only a run that
-- exhausted the search closes it, so an interrupted fetch leaves a conversation
-- that says what it is. 'complete' is the honest default for the rows that
-- already exist: the old ordering wrote them only after a full, successful
-- fetch.
ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';

-- When the last *complete full* read of this conversation finished, which is
-- what decides whether another one is free under X's 24h dedup. Distinct from
-- fetched_at ("when we last went to X about this at all"): a since_id refresh
-- or a resume touches fetched_at and must not make the next refresh think a
-- full re-read has already been paid for today.
ALTER TABLE conversations ADD COLUMN full_read_at TEXT;

-- Existing rows were written by exactly one thing — a full read that finished —
-- so their fetched_at is the full-read timestamp this column wants.
UPDATE conversations SET full_read_at = fetched_at WHERE full_read_at IS NULL;

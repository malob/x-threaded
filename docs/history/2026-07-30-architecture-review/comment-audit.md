# Comment Audit — x-threaded (full codebase at HEAD)

## 1. Top-line assessment

This is a healthy codebase, comment-wise — well above typical. The house style is almost entirely why-comments: ordering dependencies, billing semantics, API quirks with measured evidence, heuristics with unwind instructions. Redundant restatement is nearly absent. The rot that exists is concentrated exactly where the code pivoted fastest: the bookmark sync (add-only → mirror), the thread count (own-posts → spine), and the growth of `POST /api/conversations` into a shared entry point. The systemic risk is **duplication**: the refresh-token-rotation rule is stated in five places, the folder-source-of-truth rule in three, the portal-scope gotcha in two. Duplicated knowledge is what rots — three of the findings below are second copies that didn't get updated when the first copy did.

Roughly: 6 inaccurate, ~10 misleading/incomplete, ~2 redundant, 9 missing, and a long list of genuinely excellent comments.

## 2. Findings by category

### (a) Inaccurate / rotted — ordered by damage potential

**A1. `migrations/0004_settings_and_saved.sql:8-10` — inverts current deletion behavior.**
"Additive by design — removing a bookmark on X does not delete the row..." Since `eb75402`, un-bookmarking on X **does** delete the saved_items row on next sync (app.ts:213-214). Only the cached-conversation/read-state part survives. Worst item in the audit: a data-deletion question answered wrong with the words "by design." Fix: wrangler tracks migrations by filename, so editing the comment is safe; rewrite to describe mirroring and point at the sync route.

**A2. `src/shared/types.ts:117` — `OwnThread.ownPostCount` doc describes the pre-`38ce59c` semantics.**
"How many posts in this thread are the user's own (1 = a lone post)." Since the spine change it's `spineLength()`: root plus chain of self-replies; replies to other participants deliberately excluded (the exclusion was the point of the commit). The field name has rotted too. Fix: re-document; renaming to `spineLength` better still.

**A3. `src/shared/types.ts:72-75` — `fromCache` and `cost` docs overstate the billing story.**
`POST /api/conversations` calls `xapi.getPost(postId)` unconditionally (app.ts:437) *before* the cache check, so a `fromCache: true` response cost a $0.005 lookup — it did hit the X API — and carries no `cost` field. Both docstrings would misdirect a billing investigation. Fix: re-word both.

**A4. `src/server/worker.ts:21-25` — wrong route list.**
"only /api/* reaches this handler (run_worker_first)" — wrangler.jsonc sets `["/api/*", "/auth/*"]`, and /auth/* must reach the Worker or OAuth breaks. Fix: mention both.

**A5. `README.md:26-27` — ".env.example is the single reference for all of them" is false.**
Absent: `X_OAUTH_ACCESS_TOKEN`/`X_OAUTH_REFRESH_TOKEN` (seed tokens, worker.ts:17-18, oauth.ts:169-179) and `WORKER_PORT` (dev-worker.sh). push-secrets.sh NAMES omits the seeds too. Document or delete the seed pathway (may be vestigial; note portal-minted seeds lack bookmark.read per oauth.ts:5-10).

**A6. `src/server/oauth.ts:120-121` — `SELF_ID` "exported for callers that reset it."**
Zero callers (verified). `getGrantedScopes` (oauth.ts:190-194) unused; `OWNED_READ_USD` (pricing.ts:6) unused. Comment asserts code that doesn't exist. Fix: delete all three exports.

### (b) Misleading / incomplete

**B1. `xapi.ts:255-256` (getBookmarksByFolder) — names an invariant the code then breaks.** "Page through the whole folder: callers reconcile against this list, so a partial one would look like the user had un-bookmarked things" — but `maxPages = 10` caps at ~1,000 bookmarks, past which exactly that disaster happens silently (mass-removal of legit bookmarks). Fix: comment should own the tradeoff, or code should skip removal when truncated.

**B2. `app.ts:465-466` — "Pasting a URL is a manual add…" no longer describes when this fires.** Since `ed8ea1a`, the route also serves inbox-card clicks and deep-link consent fetches; all add the *root* as `source: "manual"`. Concretely: opening a bookmarked mid-thread post adds a second, root-keyed manual entry beside the bookmark entry — a duplicate in the Saved tab the comment says can't happen. Fix: re-word, or gate the add to pasted URLs if that's the intent.

**B3. `app.ts:253-261` — stranded docblock.** First of two consecutive blocks documents the /api/me/posts pipeline, not spineLength. Move to the route handler (:326) or groupOwnThreads.

**B4. Dedup phrasing inconsistent.** README:14-15 and xapi.ts:311-312 say "24-hour UTC window" (reads rolling); storage.ts:33-36 and app.ts:489-491 say UTC *day*. Code implements calendar-day. Standardize on "same UTC calendar day."

**B5. `oauth.ts:157-159` — "callers fall back to app-only auth."** No caller does; userContext throws 401. Delete the clause.

**B6. `types.ts:91` — metricsUpdated: "a free same-day full re-read."** Not guaranteed free: new posts bill. Drop "free."

**B7. `types.ts:127` — hasMore: "The scan filled its quota…"** Also true when MAX_SCAN aborted below quota. Re-word.

**B8. `App.tsx:41-42` — right comment, wrong host.** The inbox-reloads-itself note sits above autoRefresh. Move to the Inbox render site or Inbox.tsx.

**B9. `tree.ts:21` — snowflakeMs "(snowflake: ms since the X epoch)."** Returns *Unix* epoch ms (adds 1288834974657). Say: "Creation time (Unix ms) decoded from a snowflake post ID."

**B10. `README.md:19-22` Stack section** predates Workers target (describes only Bun+SQLite). Also `.env.example:36-38`: Access verified "on every /api request" — actually every request reaching the Worker incl. /auth/*.

**B11. `app.ts:228`** — "'loaded' when we've cached its whole tree" — hasConversation only checks row existence; truncated fetch still counts. "Whole tree" overpromises.

### (c) Redundant

- `oauth.ts:13-14` vs `:120-121` — SELF/SELF_ID documented twice; resolves with A6.
- `app.ts:111-116` vs `oauth.ts:5-10` — portal-tokens-lack-bookmark.read stated in full twice. Keep the SCOPES copy; make the route copy a pointer.

### (d) Missing — genuinely tricky code with no WHY

**D1. store-d1.ts — D1 limits, nowhere mentioned.** Unbounded IN() lists vs D1's bound-parameter cap; postIdsReadToday receives up to 500 ids from ingest(). Probable production bug, not just a missing comment (task chip filed). Also unstated: db.batch is atomic on D1 while bun store uses explicit transactions — the parity intent is real but unstated.

**D2. `xapi.ts:11` — PAGE_DELAY_MS = 1100.** No why (full-archive search ~1 req/s on this tier). One line prevents someone "optimizing" it away into 429s.

**D3. `xapi.ts:164-175` — retry policy.** Why exactly one retry, wait capped 60s — undocumented.

**D4. Two spine definitions.** app.ts:268 spineLength (parentId-chain over own posts; last-writer-wins on forked self-replies via byParent) vs tree.ts:212 threadSpine (earliest self-reply child). They can disagree on forked self-replies or deleted intermediates, so the inbox "thread of N" can mismatch the rendered spine. Neither mentions the other. Cross-reference both.

**D5. Grant revocation on re-auth.** Nowhere in the repo. .env.example tells you to register both callbacks on the same X app but not that /auth/login on one deployment can revoke the other's grant with a shared client ID — the failure future-you will actually hit.

**D6. conversation_id search being app-only.** xapi.ts:150-153 documents the inverse but never states /tweets/search/all works only with the app bearer — a maintainer might "simplify" to one token and break fetching.

**D7. The exclude=replies flip-flop.** Current comment (xapi.ts:196-201) is excellent, but 38ce59c shows the repo previously asserted the opposite with equal confidence, and the current claim contradicts X's docs. Record "we believed A, measured B on <date>, docs still say A" or a third flip is likely.

**D8. wrangler.jsonc d1_databases** — the *absence* of database_id is what makes deploy auto-provision (README relies on it); nothing says the omission is deliberate.

**D9. Soft dedup.** All billing math rests on X's same-day dedup, treated as fact everywhere; nowhere states it's observed/soft rather than contractual — the one sentence that tells a maintainer whether a billing discrepancy is app bug or upstream policy change.

### (e) Good — exemplars to preserve

- app.ts:92 — "Check before upserting: writing the posts overwrites fetched_at."
- app.ts:190-196 — sync-mirror docstring ("only entries this sync owns").
- xapi.ts:194-201 — exclude=replies with measured numbers (49/23/22).
- xapi.ts:240-247 — folder endpoint rejects field params, hence stub-hydration.
- pricing.ts:8-15 — estimate multiplier with measured range and rejected alternative.
- oauth.ts:123-127 — rotation contract.
- tree.ts:261-275 — placeholder heuristic with unwind instructions.
- Thread.tsx:292-297 — scrollRequestRef rationale.
- access.ts:25-36 — defense-in-depth rationale.
- dev-worker.sh and .env.example — .dev.vars-suppresses-.env and named-pipe gotchas.

## 3. Missing-documentation list

| Where | What it should say |
|---|---|
| store-d1.ts module doc | D1 bound-parameter cap; batch-is-atomic; parity contract with store-sqlite; SCHEMA-vs-migrations sync rule |
| xapi.ts:11 | Why 1100ms: full-archive search rate limit |
| xapi.ts get() | Why exactly one retry |
| spineLength / threadSpine | Cross-reference; when the two spine definitions diverge |
| .env.example OAuth section | Same-app re-auth revokes prior grant; seed-token vars (or remove pathway); WORKER_PORT |
| xapi.ts fetchConversation | conversation_id: search requires the app-only bearer |
| storage.ts postIdsReadToday | Dedup is observed, not contractual |
| wrangler.jsonc | Omitted database_id is deliberate (auto-provision) |

## 4. "From scratch": the documentation architecture

**Inline comments (keep, this repo's strength):** point-of-use why-comments only. Rule: if the knowledge is about *this exact line*, it's a comment; if it's about *X the platform*, it isn't.

**`docs/x-api-notes.md` (the big missing piece):** one ADR-style page holding the hard-won X API knowledge, each entry dated: per-post billing + soft same-UTC-day dedup; conversation_id full-archive search app-only, ~1 req/s; exclude=replies measured behavior *and flip-flop history*; folder endpoints accept no field params; portal tokens lack bookmark.read; refresh rotation single-use + grant revocation on re-auth; reply_count undercount factor (1.2–1.9×); note_tweet; HTML-escaped &<>. Today this is smeared across nine files — why the five copies of the rotation rule are one refactor from contradicting each other. Comments shrink to pointers.

**README:** operation only — deploy, config, run, two-target architecture (fix Stack). The milestone checklist has done its job; it's the stalest part (stops before the bookmark/OAuth era).

**Types as documentation:** A2/A3 exist because field names (ownPostCount, fromCache) stopped meaning what they say. Rename to spineLength / servedFromCache and the comment burden disappears.

**Migrations:** schema-shape comments only; never behavioral claims ("additive by design" — the A1 rot). Behavior belongs on the route that implements it.

**Out-of-scope confirmations for parent triage:** D1 IN-list cap; dead exports SELF_ID/getGrantedScopes/OWNED_READ_USD; listConversations client-dead; duplicate-saved-entry quirk (B2); RefreshResponse redeclares inherited cost.

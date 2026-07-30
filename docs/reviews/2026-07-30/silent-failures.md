# Silent-Failure Audit: x-threaded @ HEAD

## 1. Top-line assessment

Macro posture better than most hobby codebases: centralized Hono onError, XApiError carries status+body, most client calls funnel into a visible banner, truncation/missing posts honestly disclosed, Access fails closed, no empty catch blocks on the server.

But the three subsystems where failure costs real money or strands the user — **OAuth token rotation, paginated billable fetches, and the D1 storage backend** — all have correctness gaps that fail silently or destructively. Worst class: the D1 store violates a documented Cloudflare limit (100 bound parameters/query, verified against the D1 limits docs) in exactly the code path that runs *after* the X API has been paid — the Worker deployment pays for large conversations then deterministically fails to save them. The client blind-parses every response as JSON and has catches that convert errors into misleading empty states. Essentially no logging: two console.error calls in the whole server.

## 2. Findings

### CRITICAL

**C1. D1's 100-bound-parameter limit breaks ingest for ~100+ post conversations — money spent, nothing persisted, deterministic re-failure**
- store-d1.ts:140-151 (postIdsReadToday), :130-138 (getPostsByIds), :209-214 (setReadState delete path)
- On the Worker, any conversation needing a second search page (PAGE_SIZE 100, maxPosts 500): ingest() (app.ts:93) calls postIdsReadToday with N+1 placeholders → D1_ERROR at ≥100 ids — **after** fetchConversation performed hundreds of $0.005 reads, **before** upsertPosts. 500 to the user, nothing cached, retry hits the same wall forever.
- Related: /api/saved >100 items 500s the tab; getQuotedFor >100 distinct quoted ids makes a *cached* conversation permanently unviewable (500 on every GET); mark-unread (R) on >100-post scope fails.
- Surfaces as a generic 500 banner. Never reproduces on bun:sqlite (32k variables) — textbook prod-only drift between the two Storage implementations.
- Fix: chunk every IN() builder to ≤99 (or JSON-array + json_each). Shared chunked() helper so the stores can't drift.

**C2. Concurrent token refresh races the single-use refresh token; the loser can strand the whole grant**
- oauth.ts:161-188
- Two requests inside the 5-min refresh margin (two tabs; status+folders; different Worker isolates) both read the same refreshToken, both POST. X rotates on first use; second fails invalid_grant — and OAuth reuse-detection commonly revokes the entire token family, killing the winner's tokens too. No single-flight; **the failure path never re-reads the store** — even when fresh tokens were just persisted by the other request, the loser throws.
- Impact: intermittent 500s escalating to a stranded account requiring /auth/login, with no message saying that's the remedy.
- Fix: (a) in-process single-flight for Bun; (b) on Workers, optimistic concurrency — UPDATE ... WHERE refresh_token = :old; on zero rows or invalid_grant, re-read the store and adopt the winner's tokens before declaring failure; (c) on confirmed dead chains, persist an "auth broken" marker so /api/auth/status reports authorized:false with the login link.

**C3. The rotated refresh token lives only in memory between refresh() and putOAuthTokens()**
- oauth.ts:185-186
- Refresh succeeds (old token dead), then Worker evicted / process dies / putOAuthTokens throws → only copy of the new refresh token gone; every later call retries the dead token forever. Seed-token path (:169-179) same shape, nastier: DB reset → the long-consumed env seed silently retried forever with no "seed is stale" message.
- Window can't fully close (X returns the new token in the response), but nothing minimizes or diagnoses it: no logging of refresh attempts/results, no invalid_grant differentiation, dead tokens never cleared.
- Fix: keep persist-immediately adjacent forever (comment as load-bearing); log every refresh attempt/outcome; translate invalid_grant into a user-facing "X session lost — reconnect at /auth/login."

### MAJOR

**M1. request() blind-parses every response as JSON — Access expiry becomes "Unexpected token '<'"**
- api.ts:15 and :66-68 (getAuthStatus)
- CF_Authorization expires → fetch follows the Access 302 to an HTML login page → 200 → response.json() throws SyntaxError. Cryptic error instead of "session expired — reload." Worse: getAuthStatus failure caught in Inbox with `.catch(() => setAuth(null))` (Inbox.tsx:176-178) — auth === null renders *nothing*; the Your-posts tab silently blank.
- Fix: content-type check; build message from status; detect the Access redirect and show "reload to re-authenticate." Never map fetch failure to setAuth(null) — keep an explicit error state.

**M2. fetchConversation throws away every already-billed page on mid-pagination failure**
- xapi.ts:326-358; consumed at app.ts:446,496,502
- Page 4 of 5 fails (429 surviving the single retry, transient 500, network): X already returned — and billed — 300 posts. Whole function throws; ingest never runs; nothing persisted. Retry is free only same UTC day; failure at 23:58 retried at 00:05 bills the full conversation again.
- Fix: return accumulated partial with truncated:true + incomplete reason when a page fails after ≥1 success (UI for truncation already exists), or persist page-by-page. Never discard paid data.

**M3. Bookmark sync silently truncates and then deletes — two paths remove live bookmarks**
- xapi.ts:256-269 (maxPages=10 cap) and :289-307 (getPostsByIds ignores the response `errors` array — not even in the SearchPage type); consumed at app.ts:204-216
- A: folder >1000 bookmarks stops at 10 pages with next_token set and no signal → everything beyond page 10 removeSavedItem'd — exactly the disaster the comment at xapi.ts:255-256 warns about.
- B: bookmarked post's author goes private (or post deleted) → hydration returns it under `errors`, not `data` → vanishes from posts → not in inFolder → saved entry removed while the bookmark still exists on X. Sync result even reports it "un-bookmarked."
- Fix: treat still-set next_token after maxPages as an error (or raise cap and surface progress); parse `errors` and exclude errored ids from removal (only remove items affirmatively absent from a *complete* listing).

**M4. Reported cost is wrong: quoted-post fetches and other billable reads never counted**
- app.ts:84-98 (ingest), :55-77 (resolveQuotedPosts)
- ingest computes free/billable from `all`; then resolveQuotedPosts fetches up to two levels of quotes at $0.005 each — never in cost. A quote-heavy 50-post conversation with 30 external quotes reports ~50 posts' cost while billing ~80. Also uncounted: xapi.getPost at app.ts:437 when the conversation turns out cached (response has no cost at all); root recovery in groupOwnThreads (:300-302); every /api/me/posts owned read; bookmark sync hydration — a 1000-bookmark sync can bill ~$5 while returning only {synced, added, removed}.
- Fix: thread a cost accumulator through every xapi call in a request; report the sum, rather than computing cost at one point mid-flow.

**M5. Non-atomic first-fetch ingest: a late failure leaves a half-cached conversation served as fully cached**
- app.ts:452-469
- upsertConversation succeeds, ingest writes posts, then resolveQuotedPosts throws (one flaky call). Client gets an error — but hasConversation is now true, so the retry takes the cached branch (:442-444): quotes unresolved, markConversationRead never ran (everything unread), no saved item, no cost ever displayed for money already spent.
- Fix: write the conversation row *last* (it's the "complete" marker), or an explicit complete flag; make hasConversation mean "fully ingested."

**M6. Number() on config and query params: NaN silently disables the spending caps**
- index.ts:8, worker.ts:43, app.ts:328-346
- A: MAX_POSTS_PER_FETCH=5OO (typo) → NaN → `posts.length >= maxPosts` never true → truncation cap gone; a 100k-reply mega-thread is a ~$500 fetch, silently uncapped. The one config error that should fail loudest fails silently.
- B: /api/me/posts?threads=abc → target=NaN → MAX_SCAN=NaN → both loop guards permanently false → pages until the timeline is exhausted (up to 3200 owned reads + root lookups) on one malformed request.
- Fix: validate at the edges — refuse to boot on NaN/non-positive (as with missing bearer token today); clamp/400 the query param.

**M7. X API retry logic: silent 60s stalls, single retry, NaN on malformed headers, uncontextualized JSON parse failures**
- xapi.ts:165-175; oauth.ts:91,141
- On 429, silently sleeps up to 60s (search window is 15 min, so the capped single retry often fails anyway) — browser shows "Loading…", nothing logged. Number(resetHeader) on malformed header → NaN → setTimeout(NaN) → immediate retry, silently defeating backoff. In oauth, await response.json() runs *before* the status check: an HTML error page throws SyntaxError, destroying the status and the constructed OAuthError.
- Fix: log every retry with status+wait; guard Number(); in oauth read text() first, parse with status preserved.

**M8. getFolders failure rendered as "no bookmark folders found — create one on x.com"**
- Inbox.tsx:78-80 (`.catch(() => setFolders([]))`) rendered at :88-90
- Token refresh failure / missing bookmark.read scope / network error → mapped to empty list → UI affirmatively tells the user to go create a folder — actively wrong guidance masking an auth problem. Same at :173-175 (getSettings → null renders as "no folder chosen").
- Fix: distinct error state; never conflate "empty" with "failed."

### MINOR

**m1.** Optimistic read-state updates never roll back, and mutations fire inside state updaters (App.tsx:169-188). React may double-invoke updaters → duplicate POSTs; on failure local state keeps the optimistic value, silently reverting on next load. Move outside; restore prior unreadIds on rejection.

**m2.** Stale autoRefresh resurrects a conversation the user left (App.tsx:43-55): `setCurrent((prev) => ({...fresh}))` returns fresh even when prev is null. Open thread → Back immediately → refresh resolves seconds later → UI navigates itself back. Guard on `prev?.rootId === fresh.rootId`.

**m3.** Fire-and-forget clipboard writes (Thread.tsx:414, 532-535): rejection = user pastes old clipboard, no feedback. Add .catch + "copied" affirmation.

**m4.** access.ts conflates "couldn't fetch JWKS" with "bad token," logs nothing (access.ts:51-56). Failing closed is right, but infrastructure failure deserves 503 + console.error; today a JWKS outage is indistinguishable from a revoked user, no trace in logs.

**m5.** OAuth callback dead-ends render raw JSON mid-redirect (app.ts:130-147): denial, state mismatch, exchange failures (incl. double-fired callback) leave `{"error": ...}` with no link back. Redirect to / with an error query.

**m6.** Half-configured OAuth on the Worker is silently "unconfigured" (worker.ts:44-52): client ID set, secret missing → oauth:null → UI says no credentials. Bun entry warns; Worker doesn't log. Emit log; surface "partially configured."

**m7.** Error-code mapping muddles auth vs upstream; malformed request JSON becomes 500 (app.ts:102-109): XApiError 401 from userContext maps to 502 so the client can't distinguish "connect your account" from "X is down"; body-parse failures 500 instead of 400. Preserve 401/403/429; catch parse errors as 400.

**m8.** Unguarded JSON.parse in rowToPost (storage.ts:189-191): one corrupt entities_json row poisons every endpoint touching that conversation (and listConversations → whole inbox) with a cryptic 500. Per-row fallback-to-null + log. Client: no error boundary (main.tsx) — any render throw is a permanent blank page.

**m9.** "loaded · free" cards can bill on open (Inbox.tsx:27-34 + App.tsx:91): opening a cached conversation fires autoRefresh; on a new UTC day that's a billable since_id fetch. Cost is shown after the fact, but the card promised "free" before the click. Label "loaded · refresh may cost" or defer new-day refresh behind the refresh button.

**Done well:** XApiError preserving status+body; postIdsReadToday same-day dedup design; placeholders and hidden-reply counts disclosing missing data; dev-worker.sh refusing ambiguous config; the DELETE /api/saved 409 explaining why and what to do — exactly what a good error message looks like.

## 3. From scratch: the error-handling architecture this app deserves

Given the defining constraint — **every upstream read is money, and the refresh token is a single-use consumable** — treat spend and auth state as first-class persisted data:

- **Errors as values at module boundaries; exceptions only for bugs.** xapi returns `{ok:true, data, spend} | {ok:false, kind: "rate_limited"|"auth"|"not_found"|"upstream"|"network", status, detail, retryAfter?}`. Handlers match exhaustively; Hono onError remains a bug-catcher. Mid-pagination failure becomes a normal value carrying partial data, not a throw discarding it.
- **A spend ledger, not point-in-time arithmetic.** Every xapi call inserts a row (endpoint, post_count, est_usd, request_id, created_at) before returning. Client-reported cost = sum over request id — quote resolution, root recovery, getMe, sync hydration counted automatically because counting is structural. Also enables a daily spend meter and an audit trail.
- **Fetches as resumable jobs with incremental persistence.** fetch_sessions row (root_id, next_token, posts_so_far, state: running|complete|failed); each page upserts posts and advances next_token transactionally. Crash/rate-limit resumes from the token instead of re-buying pages; hasConversation becomes state='complete', killing half-cached-looks-cached by construction. Big threads: return a job id, client polls — no 60s stalls in one HTTP request; UI shows "page 3/5, waiting 40s."
- **Retry policy keyed to billing semantics.** Reads retry at most once, only network errors and 429-with-honored-Retry-After (never blind 5xx), jitter, per-request retry budget, every retry logged. Same-UTC-day dedup makes same-day retries cheap — surface "resume today is free, tomorrow costs" near day boundaries.
- **Token rotation as a tiny state machine in storage.** valid | refreshing | broken(reason). Single-flighted (in-process promise on Bun; UPDATE...WHERE refresh_token=:old CAS on D1, loser re-reads and adopts winner's tokens). invalid_grant → broken → /api/auth/status reports it with the login URL; endpoints stop hammering a dead token; UI shows one clear "reconnect" CTA.
- **One fetch wrapper on the client with typed failures.** Content-type-checked parsing; auth failures → dedicated re-auth banner; network/HTML → "server unreachable / session expired," never SyntaxError text. Empty and error states are distinct types. Optimistic mutations roll back. Top-level error boundary.
- **Fail fast on configuration.** Zod-parse env at startup (both entries): non-numeric MAX_POSTS_PER_FETCH refuses to boot like a missing bearer token does today.

# Test Coverage Assessment: x-threaded @ HEAD (zero tests)

## 1. Top-line risk posture — the three scariest untested behaviors

1. **The "is this cached?" guard on `POST /api/conversations`** (`src/server/app.ts:440-446`). One inverted boolean on `firstFetch`/`body.force` and every paste of an already-cached URL silently re-fetches the whole conversation: up to `maxPosts` (default 500) × $0.005 = **$2.50 per click, with no visible failure**. Same class of risk in `resolveQuotedPosts` (app.ts:55-77), which must only call `xapi.getPostsByIds` for posts not already stored. Nothing verifies API call counts today.

2. **Ingest cost accounting's ordering invariant** (`app.ts:92-94`). `postIdsReadToday` must be read *before* `upsertPosts` because the upsert overwrites `fetched_at`. Swap those two lines (an entirely plausible refactor) and every fetch reports "free (already read today)" while X still bills — the app's whole spend-transparency premise fails silently. The refresh route's UTC-day fork (`app.ts:491`) sits on the same knife edge: `sameUtcDay` wrongly true → full refetch believed free; wrongly false → `since_id` fetch that skips the free metrics refresh. Also noticed while reading: the cross-day branch (app.ts:500-504) never updates `fetchedAt`, so `sameUtcDay` can never become true again after day 1 — a characterization test should pin down whether that's intended.

3. **`tree.ts` structure + the keyboard state machine that consumes it**. `documentOrder`/`scopeIds`/`threadSpine` (`src/web/tree.ts:103-158, 212-222`) feed both rendering and *read-state mutation*: a wrong `scopeIds` result means `r`/`R` marks the wrong subtree read — data corruption from the user's perspective, and unread posts stuck invisible behind folds forever. The 165-line keydown closure in `Thread.tsx:396-561` is, per history, the buggiest area and is currently only checkable by hand via the `__xdbg` window hook (Thread.tsx:333).

Bonus finding a contract test would surface: `D1Store.getPostsByIds`/`postIdsReadToday`/`setReadState` (`src/server/store-d1.ts:130-151, 200-215`) build unbounded `IN (?)` lists. D1's documented limit is ~100 bound parameters per statement; `ingest()` passes every post in a conversation (up to 500). **Fetching or refreshing any conversation over ~100 posts on the Worker deployment likely throws today.** bun:sqlite's limit is 999, so local dev never sees it. Worth verifying and fixing with a chunking helper regardless.

## 2. Prioritized test plan (risk × intricacy)

### P1 — Route-level money tests (criticality 10)
Harness: `buildApp({ store: new SqliteStore(":memory:"), xapi: fakeXApi, maxPosts })` + Hono's built-in `app.request()`. No server, no network, real store. The fake records call counts — **cost regressions become assertion failures on call counts**, which is the only way to make "never double-fetch" enforceable.

Cases (code under test in `src/server/app.ts`):
- `POST /api/conversations` for a cached root, no `force` → `fromCache: true`, `fetchConversation` called **zero** times (app.ts:442-444)
- Same with `force: true` → exactly one `fetchConversation`; `markConversationRead` only when `firstFetch` (app.ts:463) — a forced refetch must not nuke unread state
- Unparseable body → 400; `XApiError(404)` → 404, other XApiError → 502, generic → 500 (app.ts:102-109)
- **Ingest billing** (app.ts:84-98): all-new posts → `billable === posts`; second ingest same day → `billable === 0`; posts stored with yesterday's `fetched_at` → billable again; post present in both `fetched.posts` and `fetched.referenced` → counted once (byId dedup, app.ts:88-91); the `requested`/`root` extras deduped
- **The ordering invariant**: seed a post with yesterday's `fetched_at`, ingest it, assert `billable = 1` — this test fails if anyone moves `postIdsReadToday` below `upsertPosts`
- **Refresh forks** (app.ts:480-514) using bun:test's `setSystemTime`: `fetchedAt` today → full fetch with no `sinceId`, `metricsUpdated: true`, meta timestamp advanced; `fetchedAt` yesterday → `sinceId === newestPostId`, `metricsUpdated: false`; `newCount` equals the id-set delta; boundary pair 23:59:59Z / 00:00:01Z; uncached root → 404
- Quoted-post resolution (app.ts:55-77): cached quote → no API call; missing → one `getPostsByIds`; quote-of-quote resolved; depth 3 not fetched
- Bookmark sync reconciliation (app.ts:197-217): fresh added as `source: "bookmark"`; gone bookmarks removed; `manual` items untouched; re-sync preserves `addedAt`; `DELETE /api/saved/:id` → 409 for bookmark-sourced, deletes manual (app.ts:241-251)
- `/api/me/posts` (app.ts:326-359): pagination stops at `target`/`MAX_SCAN`/exhaustion; `hasMore` logic; missing roots fetched in one batch (app.ts:294-302)

### P2 — `tree.ts` pure suite (criticality 9)
All in `src/web/tree.ts`. **Fixture requirement**: post IDs must be real snowflake-format consistent with `createdAt`, because `attachPlaceholders` compares `snowflakeMs(id)` against `Date.parse(createdAt)` (tree.ts:290-291). Write a `snowflakeId(iso)` inverse of `snowflakeMs` (tree.ts:22) for the builder, or placeholder tests will silently exercise the wrong branch.

- `buildTree` (224): missing root → null; child attachment; chronological sort incl. same-timestamp ties; parentless non-root posts attach to root (245)
- `threadSpine` (212): plain self-reply chain; **forked self-reply → earliest wins** (relies on sorted children); other-author interloper ends spine; author matched by `authorId`, not handle; length-1 = no thread
- `attachPlaceholders` (276): exactly one deficit candidate predating the missing post → nested, `placementInferred: true`, deficit decremented; two candidates → root, not inferred; zero candidates → root; one candidate with deficit 2 hosting two missing posts (295-298); candidate that postdates the missing post excluded (290); missing ids processed in snowflake order (287); synthetic `createdAt` derived from the id (306)
- `documentOrder` (128): branch mode — run emitted head-first, closed head hides both continuation and the fork block (137-138), open head + closed tail hides children; spine mode — every segment always emitted, segment replies gated on `open(segment)`, next spine segment excluded from replies (149)
- `scopeIds` (103): non-spine node → full subtree; spine segment → self + reply blocks, **excluding** the rest of the spine; last segment
- `foldOwnerIds` (164), `collectRun` (112), `parentIds` (194), `hiddenReplyCounts` (321: placeholders skipped as owners but counted as present children)
- Display text (56-76): leading context mentions stripped, mid-text kept, non-context leading mention kept, all-mention text falls back to full, context accumulates down generations

### P3 — Storage contract suite, run against both implementations (criticality 8)
One `describeStorageContract(makeStore)` executed with `SqliteStore(":memory:")` (always) and the D1 twin (see architecture). Key cases beyond round-trips:
- `postIdsReadToday` today/yesterday split (store-sqlite.ts:166-176)
- `newestPostId` length-then-lex ordering: `"99"` vs `"100"` (store-sqlite.ts:195-196)
- `upsertConversation` conflict updates only `fetched_at`, never clobbers root text (store-sqlite.ts:74)
- `listConversations` counts; **zero-post conversation → `unread_count` is SQL `NULL`**, which `rowToSummary` passes through as `null` despite the `number` type (storage.ts:98, 196-203) — pin the actual behavior
- `addSavedItems` INSERT OR IGNORE preserves original `addedAt`; newest-first ordering
- `markConversationRead` / `setReadState` idempotence; unread reappears for newly ingested posts
- **Batches of 150 and 1000 ids** through `getPostsByIds`, `postIdsReadToday`, `setReadState` — catches the D1 parameter limit and bun:sqlite's 999-variable ceiling
- OAuth token round-trip with `userId` null/set

### P4 — Keyboard navigation (criticality 8, blocked on refactor R2 below)
After extracting the reducer: `j`/`k` at list boundaries; cursor inside a just-closed fold (`visIdx === -1` → `j` lands on `visible[0]`, Thread.tsx:404, 472); `h` to parent; `l` opens ancestors when the child is folded (488); `{`/`}` sibling search bubbling to ancestors (493-509); `n`/`N` wrap-around, marks read, opens ancestry, no-op with zero unread (380-394); pending-key sequences `gg`/`gx`/`yy`/`z?` incl. pending cleared on any non-match (406-408); `za`/`zo`/`zc` resolve the *owning* fold via `ownedBy` when cursor is a non-owner (417); `zc` moves cursor to owner; `zO`/`zC` scoped via `scopeIds`; `zR`/`zM` global, `zM` re-homes cursor to root; `r` on a closed owner marks the whole scope, on an open post marks one (520-525); `R` unmarks subtree; Enter toggles; input-focus and modifier guards (398); shift-letter uppercasing (402).

### P5 — Quick pure wins (criticality 6, ~30 minutes)
- `parsePostUrl` (`src/server/urls.ts:7`): bare id, min 5 digits, scheme-less, `www.`/`mobile.`, query strings, `/photo/1`, `statuses`, wrong host, >15-char handle, garbage
- `pricing.ts`: `estimatePostCount` min-1 clamp; `formatUsd` boundaries — note `formatUsd(0.999)` renders `"~100¢"` (pricing.ts:29), a display quirk a test will force a decision on
- `parseRoute` in `App.tsx:20` (duplicate of urls logic, client side)

### P6 — OAuth token lifecycle (criticality 7)
`src/server/oauth.ts`, with a stubbed `globalThis.fetch` and the in-memory store: `getUserAccessToken` — no config → null; no tokens, no seed → null; seed pair treated as expired → immediate refresh + rotation persisted (169-179); within `REFRESH_MARGIN_MS` → cached, zero fetches; **rotated refresh token persisted before the access token is returned** (185-187 — losing this ordering bricks the grant chain, since old refresh tokens die instantly); refresh response missing `refresh_token` keeps the old one (150); `createPkce` S256 verifier/challenge relationship and base64url alphabet; `exchangeCode` error surfaces `error_description`.

### P7 — `xapi.ts` parsing and pagination (criticality 6)
With captured raw JSON fixtures + stubbed fetch (`src/server/xapi.ts`): `note_tweet` full-text override (101); HTML unescape (87-90); parent/quoted extraction; unknown-author fallback; media key resolution; `fetchConversation` multi-page loop, truncation at `maxPosts` (353-356), `since_id` pass-through, referenced-media re-fetch excluding main-result ids (362-368); `getPostsByIds` 100-chunking; 429 retry honoring `x-rate-limit-reset` (165-175). `PostText.tsx` linkification (hidden t.co for quotes/media) tests cleanly via `renderToStaticMarkup` — no DOM needed.

## 3. Recommended architecture and tooling

- **bun:test, full stop.** Zero setup, already installed, jest-compatible (`describe/it/expect`, `mock`, `setSystemTime`), and `bun:sqlite` in-memory stores construct in microseconds. Add `"test": "bun test"` to package.json scripts.
- **Skip vitest and component testing.** The only thing that would justify happy-dom/jsdom is `Thread.tsx`, and the right move there is extracting the state machine into a pure module (below), after which nothing intricate remains in JSX. `PostText` is coverable via `renderToStaticMarkup` under bun:test with no DOM. Revisit only if Thread wiring bugs recur post-extraction — then one thin happy-dom smoke test, not a component suite.
- **Fake X API as a typed test double with throwing defaults**: every method not explicitly canned throws `"unexpected X API call"`, and the double records call counts. This turns cost regressions into loud failures.
- **Hard network tripwire**: `bunfig.toml` with `[test] preload = ["./test/setup.ts"]` that replaces `globalThis.fetch` with a stub throwing on any `api.x.com`/`x.com` URL (with a per-test override hook for oauth/xapi tests). This is the structural guarantee that no test can ever cost a cent, regardless of future mistakes.
- **D1 store**: contract-test the SQLite twin always (shared `SCHEMA`, shared SQL dialect — catches ~90%); add an optional second leg via wrangler's `getPlatformProxy()` (spawns local workerd, returns a real `env.DB`) as a separate `test:d1` script, not in the default `bun test` run. This is cheaper than adopting `@cloudflare/vitest-pool-workers` (which would drag in vitest) and specifically catches the D1-only failure modes: the ~100 bound-parameter limit, `first()` null-vs-undefined shape, `batch` semantics.
- **Fixtures, two layers**: (1) a `makePost(overrides)` builder emitting snowflake-consistent ids (the primary fixture mechanism — keeps tree/route tests DAMP and legible); (2) a handful of captured, sanitized raw X API JSON payloads in `test/fixtures/` (one search page pair, one tweet lookup with `note_tweet` + media, one bookmarks page) replayed only in xapi.ts parsing tests. Capture once with a one-off script; never refresh from CI.

## 4. Design-for-testability refactors, ordered by test surface unlocked

1. **`AppDeps.xapi`: concrete class → interface** (`src/server/app.ts:25`). `XApi` has private members (`bearerToken`, `get` — xapi.ts:148, 154), so TypeScript treats it nominally: a plain-object fake is not assignable without `as unknown as XApi`, and subclassing is worse (a newly added method silently inherits the real network implementation — exactly the double-fetch hazard). Fix is one line: `xapi: Pick<XApi, "getPost" | "getPostsByIds" | "fetchConversation" | "getMe" | "getOwnPosts" | "getBookmarkFolders" | "getBookmarksByFolder">` (or a named `XApiClient` interface that the class implements). Unlocks the entire P1 suite cleanly.

2. **Extract the keyboard state machine from `Thread.tsx` into a pure reducer** (`src/web/thread-keys.ts`): `applyKey(key, state, model) → { state, commands }` where `state = {cursorId, folds, pending, helpOpen}`, `model = {visible, allOrder, parents, byId, owners, spine, unread}` (all already computed as memos in Thread.tsx:276-348), and `commands` covers scroll requests, `setRead` batches, clipboard, and `window.open`. Thread.tsx keeps a ~20-line effect that feeds `KeyboardEvent`s in and executes commands. Unlocks all of P4 — the historically buggiest surface — in plain bun:test, and retires the `__xdbg` ad-hoc scripts.

3. **Chunked-`IN` helper in the stores** (fixes the suspected D1 parameter-limit bug at `store-d1.ts:130-151, 200-215`; also future-proofs bun:sqlite's 999 cap at `store-sqlite.ts:157-176, 234`). Not strictly a testability refactor, but the P3 batch cases can't pass on D1 without it.

4. **Hoist `spineLength`/`groupOwnThreads` out of the `buildApp` closure** (`app.ts:268-324`) to module scope with `store`/`xapi` as parameters (`spineLength` is already fully pure). Unlocks direct unit tests of own-thread grouping — including the documented 21-vs-2 spine-counting bug class — instead of reaching it only through `/api/me/posts` route tests.

5. **Clock injection — skip it.** `setSystemTime` from bun:test mocks `Date` globally and covers the UTC-boundary cases in `app.ts:491` and `postIdsReadToday` without touching production code. Only revisit if the D1 leg ever runs inside workerd (where the store's `new Date()` would be out of reach — it isn't with `getPlatformProxy`, since only the DB lives in workerd).

6. **Minor: make `PAGE_DELAY_MS`/`sleep` injectable in `XApi`** (xapi.ts:11-13) so multi-page pagination tests don't spend 1.1 real seconds per page; a constructor option with the current values as defaults suffices.

**Suggested order of implementation**: refactor 1 (minutes) → P1 + tripwire preload → P2 → refactor 3 + P3 → refactor 2 → P4 → P5-P7 as time allows. P1 through P3 alone would cover all three of the scariest behaviors.

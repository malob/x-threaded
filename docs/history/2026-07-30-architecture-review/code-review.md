# Full-repo code review (idiomatic TS + quality)

## 1. Top-line assessment

This is unusually well-crafted code for a personal project: the comments are excellent (they explain *why*, and several encode real measured findings), the domain modelling in `tree.ts` is genuinely thoughtful, `tsc --noEmit` passes clean with `strict` + `noUncheckedIndexedAccess`, and the dependency list is admirably short. The problems are not sloppiness — they're **structural**: (a) the dual-runtime `Storage` abstraction is a copy-paste twin rather than a real abstraction, and because local SQLite is more permissive than D1 it *hides* two production-only failure modes rather than surfacing them; (b) there is no validation or type-checking at any API boundary, so `shared/types.ts` is aspirational rather than enforced — and it has already drifted; (c) `app.ts` is a 535-line closure holding routes, ingest, threading, and cost accounting, none of which can be tested in isolation despite the dependency injection being right there; and (d) the React layer threads a hand-rolled pseudo-context through every node and does side effects in render and in state updaters.

The two findings I'd act on first are both cost/availability issues in production, and both are invisible in local dev.

## 2. Findings

### Critical

**C1 — D1's 100-bound-parameter limit is exceeded by the app's primary code path** · store-d1.ts:130-151, :200-215; callers app.ts:93, :222, storage.ts:216

`getPostsByIds`, `postIdsReadToday`, and `setReadState(ids, false)` build `IN (?)` with unbounded id lists. D1's documented limit is 100 bound parameters per query. Worst: `ingest` passes every post in a fetched conversation (cap 500) at app.ts:93. So *any conversation with 100+ posts fails in production* — precisely the class of conversation this app exists to read. `/api/saved` breaks past 100 saved items; `getQuotedFor` breaks with 100+ distinct quoted posts; `R` (mark-unread-subtree) breaks on a 100+ node subtree. bun:sqlite's limit is 32766, so **local dev never sees this**. (Verified from docs; not exercised against a real D1 binding — confirm with one 150-post fetch on the deployed Worker.) Fix: `chunked()` helper at the three sites — or push it into the driver layer so it can't be forgotten.

**C2 — `?threads=` unvalidated; `NaN` disables both spend guards** · app.ts:328-346

`?threads=abc` → `target = NaN` → `MAX_SCAN = NaN`; both loop guards compare against NaN and are permanently false → loop stops only when the timeline is exhausted (~64 pages × 50 Owned Reads + $0.005 root lookups), then `slice(0, NaN)` returns `[]`. Empty result for the money. `?threads=` → target 0, pays for a page, returns nothing; `?threads=-1` silently drops the last item. Fix: clamp + integer-check that rejects NaN explicitly.

### Major

**M1 — N+1 sequential awaits collide with Workers subrequest limits** · app.ts:63, :225-237, :295-321, :404-413, :214

One D1 round trip per item, sequentially: /api/saved ≈ 54 queries at 50 items; groupOwnThreads is O(pages × conversations) since it's called inside the pagination loop; resolveQuotedPosts one hasPost per id; sync one DELETE per removed item. D1 queries count as subrequests; Workers Free allows **50 per invocation** (1000 paid), shared with the X API fetches. README pitches free-tier deployment; ~40 bookmarks would hit "Too many subrequests" on the inbox. Fix: set-returning Storage methods (`hasConversations(ids)`, `removeSavedItems(ids)`); never await in a loop over user-sized collections.

**M2 — Whole Hono app reconstructed per Worker request** · worker.ts:40-54

`buildApp()` runs inside `fetch` — re-registers ~15 routes, recreates D1Store/XApi and all closures per request. Idiomatic: module-scoped `const app = new Hono<{Bindings: Env}>()` with deps from `c.env` middleware. Minimal fix: memoize in module-level `let cached`.

**M3 — Network side effects inside React state updaters** · App.tsx:169-188

`setRead`/`markAllRead` fire POSTs from inside `setCurrent` updaters. Updaters must be pure; React may invoke twice. Only safe today because main.tsx omits StrictMode — a latent double-POST. Fix: fire request outside, then pure update.

**M4 — Side effect during render** · Thread.tsx:333-341

`window.__xdbg` assignment + `localStorage.getItem` in the render body of a 500-post tree. Move into useEffect; hoist the localStorage read.

**M5 — Global keydown listener re-registered every render** · Thread.tsx:354-565

Effect has **no dependency array**; 200-line handler re-created and add/removeEventListener per render, including per keystroke. Idiomatic: latestRef + `[]`-deps effect, or useEffectEvent. Separately: keymap wants to be a `useKeyboardNav` hook over a declarative command table; HELP array generated from it.

**M6 — No validation or response typing at any API boundary** · app.ts:179, :431, :526; api.ts:13-21

`c.req.json<T>()` is a cast, not a parse. `{"url": 123}` → `input.trim is not a function` → 500 instead of 400. Only /api/read-state hand-validates (and not element types). Response side has drifted: only ~4 of 15 routes annotate; /api/auth/status returns `loginUrl` absent from AuthStatus; /api/saved builds untyped `const entries = []`. Contract asserted twice (server implicitly, client casts), verified zero times.

**M7 — Two stores: 640 lines of the same SQL, already drifting** · both stores

All divergences accidental: `(results ?? [])` in 2 of 6 sites; addSavedItems re-prepares inside .map; store-sqlite upsertPosts lacks the empty-array guard its twin has. The interface abstracts the runtime but not the SQL — which is the duplicated part. Why C1 needed fixing twice and got fixed nowhere.

**M8 — Three competing schema-evolution mechanisms** · storage.ts:77-136, migrations/*.sql, store-sqlite.ts:39-51

SCHEMA (comment-synced copy of migrations), the migrations themselves, and addMissingColumns (0003 re-implemented in TS). Pick one source of truth.

**M9 — Displayed cost omits real reads** · app.ts:84-98

`billable` computed from `all`, but resolveQuotedPosts fetches quoted posts at $0.005 *after* the snapshot (never in `cost`); conversely `all` includes `fetched.referenced` (free via includes) — inflated the other way. /api/me/posts reports no cost; OWNED_READ_USD never used. Fix: XApi returns/accumulates `{billedPosts, billedOwnedReads}` per request instead of inferring cost from what landed in a variable.

**M10 — app.ts is routes + domain logic in one closure** · app.ts:36-535

conversationResponse, resolveQuotedPosts, ingest, spineLength, groupOwnThreads all trapped in buildApp. spineLength is pure and untestable. DI is already in place (AppDeps) — the missing seam is extraction: `src/server/ingest.ts`, `src/server/threads.ts`.

**M11 — Layout thrash proportional to post count, per keystroke** · PostView.tsx:20-23, Thread.tsx:569-578

ClampedText effect depends on `[children]` (fresh element per render) so it always runs and reads scrollHeight/clientHeight (forced layout). No React.memo anywhere; ctx is a fresh object literal per Thread render so memo couldn't help. Every `j` re-renders all posts + forces layout reads. Fix: real context or useMemo'd ctx, React.memo PostCard, gate clamp measurement on text/ResizeObserver.

**M12 — Silent failure renders a misleading message** · Inbox.tsx:78-81

`getFolders().catch(() => setFolders([]))` — a missing bookmark.read scope renders "no bookmark folders found — create one on x.com", pointing the user at a non-fix. getSettings/getAuthStatus also swallow to null; failed auth probe indistinguishable from healthy unconfigured. Distinguish loading | ok | error.

**M13 — Dead feature spanning five files** · app.ts:401-420, api.ts:23-25, types.ts:48-59, storage.ts:11-16,27,196-203, both stores

`GET /api/conversations` has no caller (old inbox replaced by tabs). Transitively dead: ConversationListResponse/Item, ConversationRowSummary, rowToSummary, ConversationRow count fields, both listConversations impls (~80 lines incl. the route's own N+1).

### Minor

- **m1** — Four `eslint-disable-next-line` comments, zero ESLint installed (App.tsx:137, Inbox.tsx:196, Thread.tsx:313, :345). Decorative; install eslint + react-hooks (would flag M3/M4/M5) or replace with prose.
- **m2** — URL parsing/construction duplicated across boundary: identical regex in urls.ts:22 and App.tsx:21; `i/status/` built at App.tsx:227, Thread.tsx:64, PostView.tsx:161, Inbox.tsx:276; postPath duplicated at Thread.tsx:533. `postUrl` exported from a component module. → `src/shared/urls.ts`.
- **m3** — Stringly-typed: `source: string` (types.ts:101, storage.ts:61), media `type: string` (types.ts:22); branched on literals in six places. → unions.
- **m4** — `UrlEntity` snake_case in the shared domain model (types.ts:10-14); xapi.ts imports it from shared to describe an API response — one type as external DTO and internal model. → ApiUrlEntity in xapi, camelCase domain type.
- **m5** — Orphaned doc comment at app.ts:253-267 (first block documents /api/me/posts, stranded above spineLength).
- **m6** — Stale migration comment: 0004:9-11 "Additive by design" — commit eb75402 made sync two-way; app.ts:213-214 removes rows.
- **m7** — Dead exports: getGrantedScopes, SELF_ID, OWNED_READ_USD, metaSuffix. Also the OAuth seed branch (oauth.ts:169-179) reachable only from env vars index.ts never passes, .env.example never documents, push-secrets.sh never pushes.
- **m8** — Two hand-rolled cookie parsers (app.ts:137, access.ts:48) + string-concat Set-Cookie (app.ts:122,145); Hono ships hono/cookie.
- **m9** — One tsconfig for three environments: server type-checks against DOM, web against Bun, no boundary stopping web→server imports; hand-rolled D1 types (store-d1.ts:19-29) and the `ctx as` cast (worker.ts:54) are the cost of dodging @cloudflare/workers-types. → project references.
- **m10** — 28 non-null assertions (17 in tree.ts, 10 Thread.tsx), mostly run[0]/run[len-1] under noUncheckedIndexedAccess. `collectRun` returning `{head, rest, tail}` deletes most at the source.
- **m11** — Full table scan to read one row: app.ts:243 `listSavedItems().find(...)` in DELETE handler → `getSavedItem(postId)`.
- **m12** — `""` and `null` both mean "no folder selected" (app.ts:181-182 writes ""; SettingsResponse declares string | null). Works only via falsiness.
- **m13** — `request<T>` throws opaque parse error on non-JSON (api.ts:15): Access HTML interstitial → "Unexpected token '<'". Check content-type first.
- **m14** — No tests despite seams in place: tree.ts pure + highest-risk; buildApp takes injected deps; bun test needs zero new deps.

### Nit

- **n1** — tree.ts:254 `root.children.sort(byDate)` redundant (loop at :251-253 covers root).
- **n2** — `interface Ctx` named for a context it isn't.
- **n3** — pending-key prefix (g/y/z) never times out; stray `g` swallows the next keystroke minutes later (Thread.tsx:291,405).
- **n4** — SegmentReplies duplicates rail+children markup from CollapsibleChildren.
- **n5** — app.ts:108 returns raw internal error messages (incl. X API bodies) to the client; use instanceof narrowing.

## 3. From scratch

Same platform, restructured around: *the two stores must not be two stores*, *the wire contract must be checked*, *domain logic must not live in route handlers*.

```
src/
  domain/        pure, zero I/O, 100% testable — the crown jewels
    tree.ts          buildTree, threadSpine, collectRun, documentOrder, folds
    text.ts          stripContextMentions, unescape, entity segmentation
    threads.ts       spineLength, groupOwnThreads (pure: posts in, threads out)
    pricing.ts
  contract/      single source of truth for the wire
    schemas.ts       zod schemas; types are z.infer, never hand-written
  server/
    db/
      driver.ts      SqlDriver interface + chunked() + tx()
      bun.ts         ~40 lines
      d1.ts          ~40 lines
      queries.ts     ALL SQL, once
    x/               XApi client + its own Api* DTOs (never shared)
    routes/          conversations.ts, saved.ts, me.ts, auth.ts, settings.ts
    ingest.ts        impure orchestration: fetch → cost → persist
    app.ts           ~60 lines
  web/               imports contract/ + domain/, never server/
```

- `domain/tree.ts` moves out of web/ — pure logic both server and tests want.
- **Store**: one SqlStore over a `SqlDriver` (first/all/run/batch + `maxParams`); chunking lives in the driver so C1 is structurally impossible. Deletes ~300 lines, kills M7 drift. Alternative: Drizzle (first-class bun-sqlite + d1 drivers, generated migrations kills M8); for ~20 simple queries lean hand-rolled, but Drizzle defensible. Set-returning methods from day one (M1 is a hard platform ceiling).
- **Contract**: zod + `zValidator` on json/query (kills C2, M6-request); `hc<AppType>` Hono RPC client so response types flow from handlers (kills the 15 hand-written wrappers, makes loginUrl drift a compile error). shared/types.ts shrinks to genuine domain entities with discriminated unions; snake_case DTOs quarantined in server/x/.
- **Worker entry**: module-scope app, deps middleware from c.env (kills M2). Cost accumulated by the XApi client per request (kills M9 structurally).
- **Frontend**: `<Thread key={rootId}>` (deletes the reset effect + disable); routing via useSyncExternalStore or TanStack Router; folds/cursor in a store so PostCard can be React.memo'd (M11: cursor move re-renders 2 nodes, not 500); keyboard as declarative command table with HELP generated; server state via TanStack Query or tiny useAsync (M12's real fix: represent "failed"); StrictMode from day one (M3 fails loudly in dev).
- **Tooling**: three tsconfigs via project references (fixes m9, deletes hand-rolled D1 types); ESLint with react-hooks actually installed; bun test over domain/.

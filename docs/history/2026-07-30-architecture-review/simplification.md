# x-threaded simplification survey

Scope: all of `src/` at HEAD (~4,340 lines). Nothing was modified.

## 1. Top-line: the three highest-leverage simplifications

**A. Collapse `store-sqlite.ts` + `store-d1.ts` into one `Storage` implementation over a 4-method SQL executor.** The two files are the same 20 methods with different binding syntax. ~640 lines become ~290, and every future storage change stops being a two-file edit that can silently diverge. It also gives one place to chunk `IN (...)` parameter lists, which the D1 path likely needs and the Bun path does not.

**B. Replace the five separate tree traversals in `tree.ts` with one `layoutThread()` pass.** `documentOrder`, `foldOwnerIds`, `scopeIds`, and `Thread.tsx`'s render all independently re-derive "a spine segment's replies are its children minus the next segment" and independently re-walk the run/fork structure. One layout object computed once removes four copies of the trickiest invariant in the app and deletes five `root ? … : fallback` ternaries in `Thread.tsx` that exist only to keep hook order stable.

**C. Split `app.ts` into thin routers plus a domain module.** `ingest`, `resolveQuotedPosts`, `spineLength`, and `groupOwnThreads` are closures inside `buildApp`, so they are unreachable from a test. There are no tests in this repo; making these free functions over `(store, xapi, …)` is the change that makes tests possible at all, and it drops `app.ts` from 535 lines to roughly 180.

---

## 2. Full list, ordered by leverage

### 1. One `Storage` implementation over a SQL executor

**Files:** store-sqlite.ts (330), store-d1.ts (312)

Two classes implementing the same 20-method interface. Compare `store-sqlite.ts:140` with `store-d1.ts:140` — `postIdsReadToday` is character-identical except `$id`/`?` binding and `.all()` vs `.all<T>()`. The SQL text of `listConversations` (`store-sqlite.ts:97-104`, `store-d1.ts:74-81`) is duplicated verbatim.

Proposed: a narrow executor, one store, two ~45-line adapters:

```ts
// src/server/sql.ts
export interface SqlExecutor {
  get<T>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** One transaction / one batch. */
  writeAll(statements: { sql: string; params: unknown[] }[]): Promise<void>;
  /** Max bound parameters per statement; callers chunk IN-lists by it. */
  readonly maxParams: number;
}
```

One `SqlStore implements Storage` with a private `chunked()` helper for IN-lists. store-sqlite.ts keeps only Database construction, WAL pragma, SCHEMA, addMissingColumns, and a BunExecutor; store-d1.ts keeps the D1 interface declarations and a D1Executor.

**Deletes:** ~350 lines net, and the entire "fix it in one store, forget the other" failure mode.

**Behavior risk:** Low. (a) bun:sqlite must switch from `$named` to positional `?`; (b) `db.transaction()` must wrap `writeAll`; (c) store-d1.ts:150/:248 do `(results ?? [])` while siblings don't — pick one (the `?? []` should be shared).

**Adjacent finding:** `ingest` calls `store.postIdsReadToday(all.map(p => p.id))` (app.ts:93) with up to 500 posts → 500+ bound params in one `IN` at store-d1.ts:146. D1 documents a per-statement cap (~100) — check the limits page. `getPostsByIds` and `setReadState(ids, false)` have the same shape. The unified `chunked()` makes it moot in one place.

### 2. One `layoutThread()` pass replacing five traversals

**Files:** tree.ts:103-222, Thread.tsx:272-348, 614-628

The rule "a spine segment's own replies are `children.filter(c => c !== spine[i+1])`" is written four times: tree.ts:107 (scopeIds), tree.ts:149 (documentOrder), tree.ts:183 (foldOwnerIds), Thread.tsx:618 (render). The run/fork walk is written twice (documentOrder:131-144, foldOwnerIds:170-179). Thread.tsx:272-286 calls five of these in five `useMemo`s, each with its own `root ? … : empty` guard, because the `if (!root) return` can't happen until after the hooks (Thread.tsx:567).

Proposed:

```ts
export interface ThreadLayout {
  root: TreeNode;
  spine: TreeNode[];                       // length 1 ⇒ no thread
  segmentReplies: Map<string, TreeNode[]>; // segment id → non-continuation replies
  branchFolds: Set<string>;                // open by default
  segmentFolds: Set<string>;               // closed by default
  parents: Map<string, string | null>;
  byId: Map<string, TreeNode>;
  order: TreeNode[];                       // every node, document order
}
export function layoutThread(rootId: string, posts: Post[]): ThreadLayout | null;
export function visibleOrder(layout: ThreadLayout, isOpen: IsOpen): TreeNode[];
```

With state hooks moved into a `useThreadState(layout, conversation)` hook so the early return is legal.

**Deletes:** ~60 lines from tree.ts, ~25 lines and two eslint-disables from Thread.tsx.

**Behavior risk:** Moderate — load-bearing logic. `documentOrder`'s early returns (tree.ts:137, :141) mean a closed chain head hides its fork block too; `visibleOrder` must reproduce exactly. Write the first tests here.

### 3. Split `app.ts` into routers + a domain module

**File:** app.ts (535)

`buildApp` is a 500-line closure holding domain functions (conversationResponse:37, resolveQuotedPosts:55, ingest:84, spineLength:268, groupOwnThreads:284) interleaved with twelve routes, plus userContext:155. Nothing is exported → nothing testable.

Proposed layout:

```
src/server/
  conversations.ts   ingest, resolveQuotedPosts, conversationResponse, loadConversation, refreshConversation
  threads.ts         spineLength, groupOwnThreads, scanOwnThreads (pagination loop at app.ts:334-346)
  bookmarks.ts       syncBookmarkFolder (app.ts:197-217), settings accessors
  auth.ts            userContext, /auth/* routes, /api/auth/status
  app.ts             ~180 lines: deps, onError, app.route() mounts, request parsing only
```

Domain functions take deps explicitly: `ingest(store, xapi, fetched, extra?)`, `groupOwnThreads(store, xapi, posts, userId)`.

**Deletes:** no net lines (~355 move), but precondition for items 9/13 and for any test. Also removes the doubled doc-comment at app.ts:253-267 (first block describes the /api/me/posts route, stranded above spineLength).

**Behavior risk:** none if mechanical. Keep `buildApp` signature so index.ts:31 / worker.ts:40 untouched.

### 4. Keyboard layer: command table instead of nested dispatch

**File:** Thread.tsx:354-565 (211 lines) + HELP at :238-253

One `useEffect` **with no dependency array** (:565), so the window listener is removed/re-added every render. Inside: pendingRef prefix handling as three if/else branches (`g`/`y`/`z`), each with its own switch, plus a fourth switch for unprefixed keys; `handled` tracked manually. HELP is a hand-maintained array that must stay in sync with the switches — same 14 bindings described twice.

Proposed: flat `Command[]` table keyed by sequence (`{ keys: "z a", help: "toggle fold", run: (t) => t.toggleFold() }`) with a ~35-line dispatcher accumulating prefixes; help overlay derived from `COMMANDS.filter(c => c.help)`. Moves to `useThreadKeys(commands)` in its own file, registered once with a ref to latest commands.

**Deletes:** ~90 lines net, manual `handled` bookkeeping, per-render listener churn, HELP/keymap drift.

**Behavior risk:** low; preserve shift normalization (:400-402) and the form-field/modifier guard (:398) in the dispatcher.

### 5. `Ctx` → React context; `SegmentReplies` → shared `ReplyBlock`

**File:** Thread.tsx:19-29, 47, 112, 170, 205, 569-578

(a) `Ctx` is a hand-rolled context threaded as a prop through 8 signatures — exactly what `createContext` is for. (b) SegmentReplies:217-233 renders markup identical to CollapsibleChildren:188-202 except the `.segment-replies` wrapper and stub visibility. Extract `ReplyBlock` + `CollapseStub` (covers three copies of the `n === 1 ? "reply" : "replies"` pluralization at :132-137, :181-186, :209-216).

**Deletes:** ~45 lines and 12 `ctx={ctx}` occurrences. **Risk:** none.

### 6. Delete dead code

All verified unreferenced:

| What | Where | Note |
|---|---|---|
| `GET /api/conversations` route | app.ts:401-420 | Its client `listConversations()` (api.ts:23) imported by nothing |
| `Storage.listConversations` + both impls | storage.ts:27, store-sqlite.ts:94-107, store-d1.ts:71-84 | duplicated SUM(CASE…) join |
| `ConversationListResponse`, `ConversationListItem`, `ConversationRowSummary`, `rowToSummary` | types.ts:48-59, storage.ts:11-16, 196-203 | only reachable from above |
| `getGrantedScopes` | oauth.ts:190-194 | status route inlines the split |
| `SELF_ID` | oauth.ts:121 | second alias for SELF; nothing imports |
| `OWNED_READ_USD` | pricing.ts:6 | never read |
| `metaSuffix` prop | PostView.tsx:206, 218, 227 | no caller passes it |
| `metricsUpdated` | app.ts:510, types.ts:90 | server sets; client never reads |

**Deletes:** ~85 lines across seven files. **Risk:** none, except `GET /api/conversations` is a public endpoint — decide if the JSON API is product surface.

### 7. App.tsx: merge the two load paths; network calls out of state updaters

**File:** App.tsx:98-115, 150-167, 169-188

(a) `fetchConversation` and `submitUrl` are near-duplicates (differ: push-vs-replace, fromCache autoRefresh). Merge into `loadAndShow(input, {push, refreshIfCached})`. (b) `setRead`:169 and `markAllRead`:182 issue fetches **inside** `setCurrent` updaters — updaters must be pure; StrictMode double-invokes → double-POST. Move the request outside the updater.

**Deletes:** ~25 lines; the shownId/postPath block appears three times (:87-89, :105-108, :158-160).

**Risk:** `setRead` would fire even when `current` is null — unreachable in practice, but a semantic change.

### 8. A `useAsync` hook for loading/error/data triads

**Files:** Inbox.tsx:154-232, App.tsx:36-39

Inbox holds ten useStates; four hand-rolled fetch machines in four styles (.then/.catch :165; .then/.catch/.finally :181; async/try/catch/finally :199; async/try/catch :216). App repeats the setLoading/try/catch/finally sandwich three times. A ~25-line local `useAsync` + `useAction` hook collapses them.

**Deletes:** ~45 lines + the eslint-disable at Inbox.tsx:196.

**Risk:** low. Preserve: getSettings/getAuthStatus swallow errors to null (:175, :178); Your posts stays lazy (costs money, comment at :193).

### 9. Nested-ternary tab body → two components; shared inbox card

**File:** Inbox.tsx:248-339

90-line nested ternary; both arms render the same ul.conversations → li → PostView → meta → FetchCost structure (:260-290, :308-324). Extract `SavedTab`/`YourPostsTab` + shared `InboxCard`. Also: the click guard `closest("a, button")` exists in four places (Inbox.tsx:264, :312, Thread.tsx:81, and a `closest("a")` variant at Thread.tsx:60) → one `onlyOnNonInteractive(handler, selector)` helper; keep the Thread.tsx:60 `a`-only variant explicit via the parameter.

**Deletes:** ~50 lines. **Risk:** none.

### 10. N+1 store round-trips → batched queries

**File:** app.ts

| Location | Loop | Fix |
|---|---|---|
| app.ts:225-237 (/api/saved) | hasConversation per saved item | one `IN (…)` → Set |
| app.ts:294-320 (groupOwnThreads) | hasPost/getPost/hasConversation per conversation, **inside** the pagination loop (:338-346) | `hasConversations(ids): Promise<Set<string>>` + batched getPostsByIds |
| app.ts:62-74 (resolveQuotedPosts) | hasPost then getPost per quoted id | getPostsByIds once per level |

**Deletes:** ~20 lines; adds one Storage method. Big latency win on Workers (a 10-thread scan issues ~30 sequential D1 queries per page today). **Risk:** none. Do after item 1.

### 11. xapi.ts: one field-params constant, one page→posts helper, no nested ternary

**File:** xapi.ts:154-181, 203-307, 326-343

The four-line tweet.fields/expansions/user.fields/media.fields block appears four times (:210-214, :275-278, :294-297, :330-333). `new Map((page.includes?.users ?? []).map(...))` appears four times (:218, :284, :299, :339). Retry delay at :167-172 is a nested ternary → extract `FIELD_PARAMS`, `postsFrom(page, fetchedAt)`, `retryDelayMs(response)`.

**Deletes:** ~35 lines. **Risk:** none; fetchConversation:341-350 needs users/media separately for the includes.tweets pass.

### 12. A shared URL module

**Files:** App.tsx:20-27, urls.ts:7-24, PostView.tsx:42-44, Thread.tsx:64/533, Inbox.tsx:276, PostView.tsx:161

The status-path regex is written twice (client App.tsx:21, server urls.ts:22) and must agree. x.com URLs built ad hoc in five places. Move to `src/shared/urls.ts`: `STATUS_PATH`, `parsePostUrl`, `parsePostPath`, `appPath`, `xPostUrl`.

**Deletes:** ~20 lines, one duplicated regex, five ad-hoc literals. **Risk:** none.

### 13. PostView.tsx: metric counts as data, shared post header

**File:** PostView.tsx:62-101, 147-192

(a) MetaCounts builds items via five separate if-blocks with two near-identical anchor JSX blobs → data-driven `{key, glyph, n, href?}[]`. (b) QuoteCard:170-184 re-implements PostView's header (:222-228) → extract `<PostHeader post small? leading? trailing?/>`. Do NOT merge QuoteCard into PostView behind a variant prop — differences (clamp lines, avatar size, metric visibility, depth guard) would cost more than ~15 lines saved.

**Deletes:** ~35 lines. **Risk:** none.

### 14. refresh: two branches that are one

**File:** app.ts:480-514

The sameUtcDay if/else (:495-504) duplicates fetchConversation + ingest in both arms, differing only in since_id, an upsertConversation call, and truncated propagation. Collapse to one path with `sinceId = sameUtcDay ? undefined : newestPostId`.

**Deletes:** ~10 lines. **Risk:** none as written — but note today's behavior looks unintentional: an incremental since_id fetch that hits the cap reports `truncated: false` (:500-504 never assigns), so the client's truncation notice (Thread.tsx:590) and hiddenReplies suppression (Thread.tsx:328-331) are wrong in that case. Flagging, not fixing — behavior change, separate decision.

### 15. One source of truth for the schema

**Files:** storage.ts:77-136, migrations/*.sql

SCHEMA must be manually kept in sync with four migration files (0001_init.sql:1 says so). Already diverged in structure: SCHEMA includes user_id inline; migrations add via ALTER (0003); addMissingColumns (store-sqlite.ts:30-36) is a third mechanism. Make migrations the only schema text; Bun store applies them in order (text imports or startup directory read + applied-migrations table, as wrangler does).

**Deletes:** ~70 lines (SCHEMA 60 + addMissingColumns 13).

**Behavior risk:** real — sequence last. addMissingColumns repairs pre-existing local DBs; deleting it breaks any local sqlite file that predates those columns. Confirm the only such file is current first, else keep addMissingColumns and dedupe only SCHEMA-vs-0001.

### 16. Small, mechanical

- Settings response built twice (app.ts:171-176, :184-187) → `readSettings(store)`. Two keys always read/written together → one JSON-valued `bookmark_folder` setting.
- Debug side effect during render: Thread.tsx:333-341 assigns `window.__xdbg` in the component body → move to useEffect.
- `getQuotedFor` (storage.ts:210-227) vs `resolveQuotedPosts` (app.ts:55-77): same two-level walk; abstraction may not pay at ~35 lines — leave with a cross-reference comment.
- SELF/SELF_ID: oauth.ts:14 and :121 are two names for "self"; app.ts hardcodes "self" at :158, :161. One exported constant, three usages.

---

## 3. From scratch: the structure that makes these the default

```
src/
  shared/          types.ts   pricing.ts   urls.ts        # both halves import these
  server/
    sql.ts         SqlExecutor + bun/D1 adapters (~110 lines, the only platform split)
    store.ts       SqlStore: the one Storage implementation
    xapi.ts        HTTP + toPost mapping only
    oauth.ts
    domain/
      conversations.ts   ingest, refresh, quote resolution  — pure over (store, xapi)
      threads.ts         spine detection, own-thread grouping
      bookmarks.ts       folder sync reconciliation
    routes/        one small router per resource; parse → call domain → c.json
    app.ts         ~60 lines: deps, error handler, mounts
    index.ts / worker.ts   unchanged entry points
  web/
    api.ts         typed client (as today — this file is already right)
    hooks/         useAsync, useThreadKeys, useFolds, useScrollTo
    thread/        layout.ts (layoutThread), Thread.tsx, Branch.tsx, ReplyBlock.tsx, keymap.ts
    inbox/         Inbox.tsx, SavedTab.tsx, YourPostsTab.tsx, InboxCard.tsx, FolderBar.tsx
    post/          PostView.tsx, PostHeader.tsx, PostText.tsx, MediaGrid.tsx, QuoteCard.tsx
    App.tsx        routing + the single loadAndShow path
```

Four structural commitments:
1. **The platform difference is an executor, not a store.** ~110-line seam for binding + transactions; every SQL string, row mapping, IN-chunking rule exists once.
2. **Routes never contain domain logic.** Parse → one exported domain function → serialize. Domain functions over (store, xapi, …) are unit-testable without Hono/network/file.
3. **The tree is computed once into a layout object.** Rendering, keyboard nav, fold ownership, scoped read/unread all read the same ThreadLayout.
4. **Keyboard bindings and their documentation are one data structure.**

Estimated net effect across items 1–16: roughly **900–1,000 lines deleted** from ~4,340. Suggested order: 6 (dead code) → 1 (stores) → 10 (batching) → 3 (server split) → 2 (layout) → 4/5 (Thread) → 7/8/9 (web state) → 11/12/13/14 → 15 last.

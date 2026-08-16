# x-threaded architecture review — 2026-07-30

> **Historical.** This reviews commit `ed8ea1a`. The roadmap below shipped in
> full (stages 0–7), so the code it describes no longer exists in this shape
> and its `file:line` references are stale by design — several of the files are
> gone entirely. Kept for the reasoning, not the conclusions; see
> [`../README.md`](../README.md).

A full top-to-bottom review of the codebase at HEAD (`ed8ea1a`), framed as: *if a strong
senior TypeScript developer built this exact feature set from scratch today, how would
they architect it — and where does the current code diverge?* Constraint: the platform
is fixed (Cloudflare Workers + D1 in prod, Bun + bun:sqlite locally); everything else
was open to challenge. Visual design was out of scope; frontend code structure was in.

## How this was produced

Seven independent reviewers, each covering the whole repo from its specialty, report-only:

| Reviewer               | Model             | Raw report              |
|------------------------|-------------------|-------------------------|
| code-reviewer          | Opus 5            | [code-review.md](code-review.md)         |
| code-simplifier        | Opus 5            | [simplification.md](simplification.md)   |
| type-design-analyzer   | Fable 5           | [type-design.md](type-design.md)         |
| silent-failure-hunter  | Fable 5           | [silent-failures.md](silent-failures.md) |
| comment-analyzer       | Fable 5           | [comment-audit.md](comment-audit.md)     |
| pr-test-analyzer       | Fable 5           | [test-strategy.md](test-strategy.md)     |
| Codex                  | GPT-5.6 (xhigh)   | [codex.md](codex.md)                     |

Every finding below was then re-verified against the source by the session lead before
inclusion — file:line references checked, dead-code claims re-grepped, the two
Codex-unique discoveries confirmed in code. The D1 bound-parameter limit was
additionally confirmed *empirically against the deployed Worker* (see C1): exactly
100 parameters, bisected live on 2026-07-30.

After synthesis, the plan was stress-tested in a four-round adversarial dialogue
between Claude and Codex (Part 5); the findings and roadmap below incorporate its
corrections and are the converged, final version.

## Verdict

The reviewers agree to a striking degree, including across model families. The code is
**well-crafted at the line level** — every reviewer independently praised the comments
(“they explain why, and several encode real measured findings”), the tree-domain
modelling, the strict-TS cleanliness, and the tiny dependency list. The divergence from
a senior greenfield design is **structural**, and it clusters into four root causes
(Part 2). None of them is “rewrite the stack”: Bun, Hono, React/Vite, and the
Workers+D1 target all survived review. What didn’t survive:

1. The dual-runtime `Storage` abstraction is at the wrong seam — two hand-maintained
   copies of the same SQL, and the *permissive* local runtime hides production-only
   failures instead of surfacing them.
2. There is no trust boundary anywhere — X responses, request bodies, query params, env
   config, and DB JSON are all unchecked casts, and two of the resulting bugs disable
   the app’s spending caps.
3. Domain logic lives inside closures (a 500-line `buildApp`, a 200-line keydown
   handler), which is why the test count is zero despite the DI seams already existing.
4. Cost — the app’s entire premise — is inferred at individual call sites rather than
   accounted structurally, so the meter provably reads low on several paths.

---

# Part 1 — Verified findings

## Critical: spend and availability (all invisible in local dev)

### C1. D1’s 100-bound-parameter limit breaks large conversations in production
`store-d1.ts:130-151, 209-214` · found by 5 of 7 reviewers

`getPostsByIds`, `postIdsReadToday`, and `setReadState(ids, false)` build unbounded
`IN (?,…)` lists. D1 documents a max of 100 bound parameters per query; `ingest()`
passes every post in a fetch (up to `maxPosts` = 500) at `app.ts:93`. Sequence on the
Worker *(corrected in dialogue round 1 — the original “nothing cached, retry fails
again” was wrong)*: `upsertConversation` commits **before** `ingest`, so X bills for
hundreds of reads → `postIdsReadToday` throws `D1_ERROR` → the conversation row exists
with no posts → the retry pays one `getPost`, sees `hasConversation`, and **“succeeds”
by serving the poisoned empty cache** — the UI dead-ends at “Root post missing from
data.” Also breaks: `/api/saved` past 100 items, quoted-post hydration past 100
distinct quotes (making a *cached* conversation unviewable), and `R` on a 100+ post
subtree. bun:sqlite allows 32k parameters, so local dev can never reproduce it — and
(established in round 2 via miniflare source) **local workerd doesn’t either**: the
limit is a D1 *service policy* not enforced by any local simulation, so the honest
gate is unit tests against a limit-enforcing fake plus a one-time deployed probe.

**Probe executed 2026-07-30 against the live Worker** (fake 9×10¹⁸-range IDs through
`read-state` with `read: false`, matching zero rows): 100 bound params → 200 OK;
101 → 500 `D1_ERROR: too many SQL variables`. The limit is exactly 100, confirmed in
production. Chunk sizes of 99 (queries with one fixed extra binding) and 100 stand.

**Fix:** chunking in `SqlStore`, sized by the driver’s declared `maxParams` (a raw
driver can’t parse SQL, so the store owns it) and counting fixed extra bindings like
`postIdsReadToday`’s date param. Contract tests at 0/1/99/100/101/500 ids.

### C2. `NaN` disables both spending caps
`app.ts:328-346`, `worker.ts:43`, `index.ts:8` · 4 reviewers

`Number(c.req.query("threads") ?? 10)` — `?threads=abc` yields `NaN`, both loop guards
compare false forever, and the scan pages until the user’s timeline is exhausted
(~3,200 owned reads plus root lookups), then `slice(0, NaN)` returns `[]`. Money spent,
empty response. Identically, a malformed `MAX_POSTS_PER_FETCH` env value removes the
per-conversation cap (`posts.length >= NaN` never trips) — the one config error that
should fail loudest fails silently. Codex adds: even when valid, the cap is soft — the
loop checks it *after* requesting a full 100-post page, so a cap of 150 can fetch 200.

**Fix:** bounded-integer parsers at both edges; refuse to boot on invalid env (a missing
bearer token already does this); clamp or 400 the query param.

### C3. “Full archive” fetches actually cover only X’s default 30-day window
`xapi.ts:326-338` · Codex only; verified in code

`fetchConversation` sends `query`, `max_results`, fields, and pagination — but never
`start_time`. X’s `/tweets/search/all` defaults to the last 30 days, so fetching any
conversation whose activity predates that silently drops the older replies — no error,
no truncation flag. For an app whose Saved tab exists to read bookmarked threads later,
this is a core correctness bug. (Not yet reproduced against the live API; the code and
X’s documented default are unambiguous.)

**Fix:** derive `start_time` from the root post’s snowflake timestamp minus a margin,
on every non-`since_id` fetch. Test with a conversation older than 30 days.

### C4. OAuth rotation: race, durability window, and metadata wipe
`oauth.ts:161-188`, `store-*.ts putOAuthTokens` · 3 reviewers + Codex

Three related defects around X’s single-use refresh tokens *(race analysis corrected
in dialogue rounds 1–3)*:
- **Race:** two concurrent requests past the expiry margin both call `refresh()` with
  the same token — two isolates *presenting the same single-use token to X* is itself
  the hazard (the loser 500s; reuse detection may revoke the token family). The
  original “loser clobbers winner” claim was wrong — the loser throws before writing —
  but the fix must still move *before* the X call: CAS-after-refresh can’t stop the
  double-presentation.
- **Durability:** between a successful refresh and persistence, the only copy of the
  new refresh token is in memory; an eviction or a failed write strands the grant, and
  nothing afterward distinguishes `invalid_grant` from a transient error or tells the
  user the remedy is `/auth/login`.
- **Metadata wipe (verified):** `refresh()` returns tokens without `userId`, and
  `putOAuthTokens` writes `user_id = tokens.userId ?? null` via `INSERT OR REPLACE` —
  every rotation erases the cached user ID, so the next `userContext()` pays a billable
  `getMe()` to re-resolve it. Scope is similarly replaced with `""` when X omits it.

**Fix (the jointly-derived lease protocol):** a small token manager. Atomic one-statement
claim *before* calling X — `state='ready' AND refresh_token=:observed`, setting
`state='refreshing'`, a random `lease_id`, and `lease_until`; finalize conditioned on
both `lease_id` and the observed token; losers wait briefly and re-read (a changed
token means the winner succeeded). Expired `refreshing` lease: after a grace period,
**one** bounded recovery attempt with the unchanged observed token (guarded by a
persistent `recovery_used` flag; a crashed-before-exchange holder is silently healed,
a crashed-after-exchange grant was unrecoverable anyway); `invalid_grant` or any
ambiguity → persisted `broken(reason)`, surfaced by `/api/auth/status` with the login
link. Preserve `userId`/`scope` across rotation. No Durable Object. *Recorded
reservation: X doesn’t document its replay/revocation scope — the one-recovery rule is
a deliberate availability tradeoff; log state transitions (never tokens) and let
observed production behavior adjudicate.*

## Major: cost honesty

### H1. The displayed cost provably under- and over-counts
`app.ts:84-98, 437` · 4 reviewers

- Quoted-post resolution (`resolveQuotedPosts`, $0.005/post) runs *after* the billable
  snapshot is taken and is never counted.
- `POST /api/conversations` calls `xapi.getPost(postId)` unconditionally *before* the
  cache check (app.ts:437), so a “fromCache: true” response actually cost $0.005 and
  carries no `cost` field at all — the `fromCache` docstring is wrong.
- `/api/me/posts` owned reads, root recovery in `groupOwnThreads`, `getMe`, and
  bookmark-sync hydration report no cost anywhere (a large folder sync can bill
  dollars while returning `{synced, added, removed}`).
- **`/api/auth/status` pays a billable user read on every call** — `xapi.getMe(token)`
  at app.ts:373 runs on every inbox mount despite the user ID being cached (found by
  Codex in dialogue round 1, verified). Hotfix: serve status from the store with no
  refresh and no `getMe`; the `user` field returns with the Stage 3 token model.
- `OWNED_READ_USD` is exported and never used.
- Language: `FetchCost` claims to report what a call “actually cost”; receipts are
  **estimates** (X documents dedup as soft), reconcilable against the free
  `/2/usage/tweets`, and must survive partial failure so failed requests still
  disclose estimated spend.
- Open question: whether posts arriving via `includes` (referenced) bill; `ingest`
  counts them, which inflates the number if they don’t. The free `/2/usage/tweets`
  endpoint can reconcile our ledger against X’s actual meter.

**Fix:** cost as a structural property of the X client — every call emits a receipt;
per-request accumulation; optionally a persisted ledger (see Part 3). Do not compute
cost from “what happened to be in a variable at one point mid-flow.”

### H2. Truncation is transient; incomplete caches lie and can’t be repaired
`app.ts:37-52, 480-514`, `types.ts:70` · 4 reviewers

`truncated` exists only on the immediate response; nothing persists it. Every later
cached GET reports the conversation complete, and Thread.tsx then renders wrong
“N replies not available” annotations — the exact misinformation that gate was built
to prevent. Worse, a later-day refresh uses `since_id` from the newest cached post, so
the older pages a capped fetch skipped can *never* be recovered. Related: the cross-day
refresh branch never updates `fetchedAt`, so after day 1 the same-day-free branch is
unreachable — accidentally cost-safer, but metrics permanently rot, and `metricsUpdated`
(which no client code reads) misleads.

**Fix:** persist `completeness` (+ a backfill cursor) on the conversation row; derive
the response flag from the cache; separate “resume older replies” from “refresh newer.”

### H3. Non-atomic first fetch: a half-cached conversation is then served as cached
`app.ts:452-469` · silent-failure-hunter, Codex

`upsertConversation` (the row whose existence means “cached”) is written *first*, then
posts, then quote resolution, then read-marking. One flaky X call in
`resolveQuotedPosts` → the retry sees `hasConversation` true and serves the cache:
quotes unresolved, everything unread, the cost of the money already spent never shown.
This is the general form of C1’s poisoned-cache sequence.

**Fix (two-phase, from the dialogue):** hotfix now — move `upsertConversation` after a
successful `ingest` (row-last closes the poisoning generally); final form in Stage 5b —
an `incomplete → complete` status column written early and finalized last, which
row-last conflicts with once page persistence becomes incremental. `hasConversation`
then means `status = 'complete'`; a root with zero replies is a valid complete state.

### H4. Bookmark sync can delete live bookmarks two ways
`xapi.ts:256-307`, `app.ts:197-217` · silent-failure-hunter, Codex

The folder scan stops at `maxPages = 10` (~1,000 bookmarks) with no truncation signal —
everything beyond page 10 gets reconciled as “un-bookmarked” and removed. Independently,
hydration via `getPostsByIds` ignores the response’s `errors` array (it isn’t in the
type), so a bookmarked post whose author went private vanishes from the hydrated list
and its saved entry is removed while the bookmark still exists on X. The comment at
xapi.ts:255 names this exact invariant; the code then breaks it.

**Fix:** return `{ids, complete}` from the scan; reconcile identity from folder IDs, not
hydrated posts; never remove on an incomplete enumeration.

### H5. Every explicit fetch adds the root to Saved as “manual”
`app.ts:465-469` · comment-analyzer (behavior change from `ed8ea1a`)

The “pasting a URL is a manual add” comment predates inbox-click-to-fetch. Now clicking
a *Your posts* card adds your own thread to Saved, and opening a bookmarked mid-thread
post adds a second, root-keyed manual entry beside the bookmark entry. Decide the
intent: gate the add to pasted URLs, or embrace “everything fetched is saved.”

## Major: silent failures in the client

`api.ts:15`, `Inbox.tsx:78-90, 173-178`, `App.tsx:43-55` · all reviewers touched these

- `request()` blind-parses every response as JSON: an expired Cloudflare Access session
  returns the HTML login page → the user sees `Unexpected token '<'` instead of
  “session expired — reload.”
- `getFolders().catch(() => setFolders([]))` renders “no bookmark folders found —
  create one on x.com” on *any* error (auth, scope, network) — actively wrong guidance.
  `getAuthStatus().catch(() => setAuth(null))` renders the Your-posts tab silently
  blank. Empty and failed are conflated everywhere state is `T[] | null`.
- Stale-response race: `autoRefresh`’s `setCurrent((prev) => ({...fresh}))` restores a
  conversation the user already navigated away from (press Back quickly, the refresh
  resolves, the view comes back). No route/rootId guard, no cancellation.
- Optimistic read-state updates never roll back on failure; the POSTs are fired from
  *inside* React state updaters (double-POST the day StrictMode or any concurrent
  feature arrives). No error boundary in main.tsx — a render throw is a blank page.
- Inbox cards say “loaded · free,” but opening one on a new UTC day triggers a billable
  `since_id` auto-refresh — the label promises what the click doesn’t keep.

## Major: structure

### S1. Two stores are 640 lines of the same SQL, already drifting
`store-sqlite.ts` (330) vs `store-d1.ts` (312) · 5 reviewers

`postIdsReadToday` is character-identical modulo binding syntax; `listConversations`
SQL is duplicated verbatim. Observed drift is all accidental: `(results ?? [])` in 2 of
6 D1 read sites, an empty-array guard in one store but not the other, per-row `prepare`
in one method. The interface abstracts the runtime but not the SQL — the SQL is the
duplicated part, and it’s why C1 would need fixing in two places.

### S2. `app.ts` is a 535-line closure of routes + domain logic
`ingest`, `resolveQuotedPosts`, `conversationResponse`, `spineLength`,
`groupOwnThreads`, `userContext` are all trapped inside `buildApp` — unexported,
untestable, re-allocated per call. `spineLength` is a pure function of its arguments.
The DI (`AppDeps`) needed for testing already exists, which makes the missing seam more
frustrating, not less. Also: the whole Hono app (routes, stores, closures) is
**rebuilt on every Worker request** (`worker.ts:40-54`) instead of once at module scope.

### S3. N+1 sequential D1 round-trips vs the Workers subrequest ceiling
`app.ts:63, 225-237, 295-321, 404-413, 214` · 3 reviewers

One query per saved item / per conversation / per quoted id, sequentially — and
`groupOwnThreads` runs its per-conversation queries *inside* the pagination loop. The
N+1 latency cost is verified; the originally claimed hard ceiling (“50 subrequests
shared with X fetches”) is **downgraded to a hypothesis** — current Workers docs
distinguish 50 external subrequests from 1,000 internal-service calls while the D1
page still says 50 queries on Free, and the two conflict (dialogue round 1). Bulk
set-returning methods are the right fix regardless.

### S4. The web layer re-derives everything, everywhere, every render
`Thread.tsx`, `tree.ts` · 4 reviewers

- The spine-replies rule (`children.filter(c => c !== spine[i+1])`) is written four
  times across `scopeIds`/`documentOrder`/`foldOwnerIds`/render; the run/fork walk
  twice. Seven interdependent `useMemo`s must pairwise agree.
- The 200-line keydown `useEffect` has **no dependency array** — the window listener is
  torn down and re-registered on every render, including per keystroke. The `HELP`
  overlay is a second hand-maintained copy of the keymap.
- `window.__xdbg` is assigned in the render body (plus a `localStorage` read per render).
- `ctx` is a fresh object literal each render and threaded as a prop through every
  node (a hand-rolled context), so nothing can be `React.memo`d; `ClampedText`’s
  effect depends on `[children]` (fresh element each time) and forces synchronous
  layout — a `j` press re-renders and re-measures all ~500 posts.
- `<StrictMode>` is absent, which is the only reason the updater-side-effect bugs are
  latent instead of live.

### S5. Types describe shapes, not invariants; the contract is asserted twice, checked never
`shared/types.ts`, `api.ts` · type-design-analyzer (full analysis in raw report)

- `AuthStatus` is a flag-soup blob; the server already returns `loginUrl`, a field the
  type doesn’t declare — drift the compiler would have caught with a discriminated
  union + `satisfies`.
- Placeholder posts are fake `Post`s (`authorId: ""`, `parentId: null` on non-roots)
  distinguished by a boolean; a `PostNode | GapNode` union deletes the sentinel
  construction outright — the highest leverage-per-line type change available.
- `""` and `null` both mean “no folder selected”; `SavedItem.source` and media `type`
  are strings branched on as literals in six places; `unreadIds ⊆ posts` and
  `conversationId`-is-root-id are load-bearing invariants stated nowhere.
- Recommended and sufficient: parse-don’t-validate at exactly one boundary (X API
  ingestion, since its output is *persisted*); `satisfies` on every handler return;
  skip client-side runtime validation. On branded IDs the dialogue landed on a
  refinement: the real hazard was three duplicated parse sites (server regex, client
  regex, `snowflakeMs` throwing on garbage) — one shared `parsePostId` plus a total
  `snowflakeMs(): number | null` closes it; the brand itself is deferred unless an
  actual mixup ever bites.

## Hygiene (compressed; full lists in raw reports)

- **Dead code (grep-verified):** the entire `GET /api/conversations` feature spanning
  five files (~80 lines incl. both `listConversations` impls), `SELF_ID`,
  `getGrantedScopes`, `OWNED_READ_USD`, `metaSuffix`, `metricsUpdated` (server sets,
  no client reads), the OAuth seed-token pathway (reachable only via env vars nothing
  documents or pushes).
- **Comment rot (worst 3 of ~16):** migration 0004 says bookmark sync is “additive by
  design” — inverted by `eb75402`, and it’s a data-deletion question; `ownPostCount`’s
  doc describes the semantics commit `38ce59c` explicitly rejected; `fromCache`/`cost`
  docs contradict the `getPost`-before-cache-check reality. Plus: the knowledge that
  actually rots is *duplicated* knowledge — the rotation rule is stated in 5 places,
  the folder-source-of-truth rule in 3. The fix is one dated `docs/x-api-notes.md`
  ADR page for platform knowledge, comments shrink to pointers.
- **Duplication:** the status-path regex exists in client and server and must agree;
  x.com URLs are hand-built in 5 places; the settings response is built twice; four
  fetch-state machines in four styles in Inbox; `retryDelayMs` is a nested ternary;
  three copies of the reply-pluralization stub; the click-guard in four places.
- **Tooling:** four `eslint-disable` comments with no ESLint installed; one tsconfig
  serving three environments (server type-checks against DOM, web against Bun, nothing
  prevents web→server imports; hand-rolled D1 types exist to dodge the global
  collision that project references solve properly).
- **Retry policy:** single blind retry incl. 5xx, silent up-to-60s sleep on 429,
  `Number(resetHeader)` NaN → immediate retry, `response.json()` before status check
  in oauth.ts destroys error context. ~2 `console.error` calls in the entire server.
- **Tests:** zero. The scariest untested behaviors are the cache guard on
  `POST /api/conversations` (one inverted boolean = $2.50/click, silently), the
  check-before-upsert billing order in `ingest` (swap two lines and everything reports
  free while X bills), and `scopeIds`/keyboard read-state mutation (wrong subtree
  marked read = user-visible data corruption).

---

# Part 2 — Root-cause diagnosis

Four structural decisions explain nearly every finding above:

1. **The platform seam is in the wrong place.** `Storage` abstracts “which runtime,”
   but the runtimes differ only in driver API; the SQL is identical. Consequence: 640
   duplicated lines, accidental drift, and — because bun:sqlite is the permissive twin
   — production-only failures (C1) that local dev structurally cannot see.
2. **No parse boundaries.** Everything entering the system (X responses, bodies, query
   params, env, DB JSON) is a trusted cast. Consequence: C2’s NaN money bugs, the
   `loginUrl` contract drift, 500s where 400s belong, and a shared-types file that is
   aspiration rather than contract.
3. **Logic trapped in closures.** `buildApp` and the keydown handler hold the app’s
   real domain logic where no test can reach it. Consequence: zero tests — not because
   testing is hard (the DI seams exist; `tree.ts` is pure) but because the units aren’t
   addressable.
4. **Cost is incidental, not structural.** Billing is inferred from variables in scope
   at particular moments. Consequence: H1’s systematic undercount, and no mechanism to
   reconcile against X’s actual meter.

---

# Part 3 — Target architecture

Where reviewers disagreed, the resolution below is the session lead’s call, noted inline.

## Layout

```
src/
  domain/                 # pure, zero I/O — the crown jewels
    ids.ts                #   branded PostId/UserId, parsePostId, snowflake
    tree.ts               #   buildThread → ThreadModel (one pass: spine, order,
    text.ts               #   folds, parents, gaps-as-GapNode)   [moves out of web/]
    threads.ts            #   spineLength, groupOwnThreads (pure: posts in, threads out)
    pricing.ts
  contract/
    schemas.ts            # valibot/zod schemas for bodies, queries, env; response
                          # types bound to handlers via `satisfies`
  server/
    db/
      driver.ts           # SqlDriver: first/all/run/batch + maxParams; chunked() here
      bun.ts, d1.ts       # ~40-line adapters — the ONLY platform-specific code
      store.ts            # one SqlStore: every query exactly once, set-returning
                          # methods (hasConversations(ids), removeSavedItems(ids)…)
    x/
      client.ts           # fetch + retry + validated envelopes (the one parse boundary)
      gateway.ts          # cost receipts per call, per-request accumulation, budget
    oauth.ts              # token manager: single-flight + CAS rotation, states
    routes/               # parse → one domain/service call → satisfies-checked json
    app.ts                # ~60 lines: mounts + onError; module-scope on Workers
    index.ts, worker.ts
  web/
    queries/              # TanStack Query hooks (server state)
    thread/               # Thread.tsx + keymap.ts (command table) + keys.ts (pure
                          # reducer: applyKey(state, model) → {state, commands})
    inbox/, post/         # split components; real React context; memoized cards
    App.tsx               # routing + single loadAndShow path
docs/x-api-notes.md       # dated ADR page: all hard-won X platform knowledge
migrations/               # the single schema source (Bun store applies them too)
test/                     # bun:test; fake XApi with throwing defaults + call counts;
                          # network tripwire preload; storage contract suite ×2 drivers
```

## Decisions on the contested points

- **Hand-rolled `SqlDriver`, not Drizzle** (2 reviewers each way; Codex conceded in
  dialogue). ~20 simple queries don’t justify an ORM dependency; the driver seam
  delivers the same “write SQL once” guarantee in ~110 lines. Two corrections from the
  dialogue: chunking lives in `SqlStore` keyed off the driver’s declared `maxParams`
  (a raw driver can’t safely parse SQL), and `run` returns affected-row counts —
  required for the OAuth lease claim to be testable. Drizzle remains the fallback if
  the schema starts evolving quickly.
- **Validation: schemas at the X boundary and request edges only** (type-design’s
  argument won over blanket zod-ification). Server→client stays compile-time:
  `satisfies` per handler. Hono’s RPC client (`hc<AppType>`) is attractive but deferred —
  it would delete `web/api.ts`, at the cost of coupling the client build to server types;
  revisit after the refactor settles.
- **TanStack Query over hand-rolled `useAsync`** (Codex + code-reviewer vs simplifier).
  The verified bug list — stale-refresh resurrection, no rollback, conflated
  empty/error states, no cancellation — is precisely the feature list of a query
  library. One dependency buys the fixes for all of them.
- **bun:test, not vitest** (test-analyzer’s case; Codex retracted its vitest/RTL/
  Playwright stack). Zero setup, `setSystemTime` covers the UTC-boundary cases without
  clock injection; component testing is skipped in favor of extracting the keyboard
  reducer. The `test:d1` leg via wrangler’s `getPlatformProxy()` is **required** before
  Stage 2 ships — but scoped honestly: it verifies D1 API shapes, batch/transaction
  semantics, and migrations, and explicitly does NOT prove the 100-parameter limit
  (miniflare passes params straight through to workerd’s SQLite, `MAX_VARIABLE_NUMBER
  = 32766` — verified in the installed miniflare source during the dialogue). The
  param limit is gated by limit-enforcing fakes in unit tests plus the one-time
  deployed `read:false` probe.
- **Fetches as resumable state** (Codex’s strongest architectural idea, adopted in
  reduced form): persist a `status` column (`incomplete → complete | failed`) + a
  backfill boundary on conversations, and persist pages incrementally so a
  mid-pagination failure keeps what was paid for. Layering corrected in dialogue: the
  **gateway** does X I/O, envelope validation, and receipts only; an **application
  service** owns transactional page persistence and checkpointing. Use a stable
  oldest-time/ID boundary rather than assuming X’s `next_token` is durable. The full
  `fetch_runs`/job-polling machinery is deferred until a real >60s fetch shows up.
  Budget edge: full-archive `max_results` has a floor of 10 — when fewer than 10
  budgeted reads remain, stop under budget and mark incomplete rather than overspend.
- **Cost ledger — adopt the receipt, defer the table.** Per-request accumulation via
  the gateway fixes H1 now; a persisted `api_read_ledger` (+ reconciliation against the
  free `/2/usage/tweets`) is a natural later stage and pairs with the cycle-total
  footer idea already on the shelf. All cost figures are labeled as estimates.
- **Official X TypeScript SDK (`@xdevplatform/xdk`) — nothing now** (evaluated at the
  owner’s request, dialogue round 4; both sides converged on rejection). The runtime
  client solves none of the six hard problems (rotation lease, runtime validation,
  receipts, budget pagination, `start_time`, reconciliation completeness) and carries
  concrete v0.6.6 defects verified in the tarball: `Client.isTokenExpired()` is a stub
  returning `false`, `Client.refreshToken()` is an empty body, `retry`/`maxRetries`
  config is dead code that could silently come alive, and the auth selector prefers
  the app bearer on endpoints advertising both schemes — which would silently convert
  our $0.001 user-context Owned Reads into $0.005 reads. Even types-only adoption
  fails structurally: the SDK camelCases responses post-parse, so its generated types
  describe SDK output, not the wire our valibot schemas guard. Reconsider only when it
  offers injectable transport, explicit credential selection, trustworthy retry
  disabling, and raw wire types or runtime schemas.

# Part 4 — Staged roadmap (final, post-dialogue)

Same discipline as the build so far: one layer per stage, each independently shippable,
tested before the next. Comments are updated with each behavior change, not batched at
the end. This version supersedes the pre-dialogue draft: Stage 0 was restructured so
fixes land red→green, the token manager moved up, and stages were sliced narrower.

**Stage 0A — the minimal harness first (hours, not days).** `XApiClient` interface
(`Pick<XApi, …>` — one line, unlocks fakes); network tripwire preload (any test
touching `api.x.com` throws); `buildApp` + `:memory:` store + throwing-fake X client;
a driver-level fake that enforces `maxParams` so the D1 limit is testable locally.

**Stage 0B — eight hotfixes, each red→green (~two days total).**
1. Chunk the three D1 `IN` builders; deployed one-time probe (150 fake IDs via
   `read-state`, `read: false` only) as the C1 gate.
2. Bounded-int parsing for `threads` + `MAX_POSTS_PER_FETCH`, plus a strict page
   budget — never request a page beyond the remaining cap; stop under budget when
   fewer than the API’s 10-result floor remains.
3. `start_time` derived from the root snowflake on every non-`since_id` fetch (C3).
4. Cache-first resolution in `POST /api/conversations` — no paid `getPost` when the
   post is already stored.
5. Fail-closed bookmark reconciliation: skip the removal phase whenever the folder
   scan is incomplete (page cap hit with `next_token` still set).
6. Preserve `userId`/`scope` across token rotation + in-isolate single-flight.
7. Store-only `/api/auth/status` — no refresh, no `getMe`; omit the optional `user`
   field until Stage 3 (the UI already guards it).
8. Temporary conversation-row-after-ingest ordering, closing the poisoned-cache path
   until Stage 5b’s lifecycle replaces it.

Deliberately demoted from Stage 0: the client content-type guard (→ 4a; UX, not
money) and the stale-`autoRefresh` guard (→ 6a; TanStack Query fixes it properly).

**Stage 1 — extraction + the full money suite.** Hoist `ingest`/`spineLength`/
`groupOwnThreads`/`resolveQuotedPosts` out of `buildApp`; delete the dead
`GET /api/conversations` feature + dead exports; shared `urls.ts` with the one
`parsePostId` and a total `snowflakeMs` (branding deferred); then the complete P1
route-level suite from [test-strategy.md](test-strategy.md) — cache-guard,
billing-order, refresh-fork, and reconciliation cases.

**Stage 2a — one store.** `SqlDriver` (`first/all/run/batch` + `maxParams`, `run`
returning affected rows) + two ~40-line adapters; single `SqlStore` with chunking and
set-returning batch methods (kills S3’s N+1s); storage contract suite against both
drivers incl. 0/1/99/100/101/500-id cases; the **required** `test:d1` workerd leg for
API shapes, batch semantics, and migrations (explicitly not a param-limit proof).

**Stage 2b — one schema source.** Migration ledger + baselining for the local Bun
store (matching wrangler’s D1 tracking); then retire `SCHEMA` and `addMissingColumns`.

**Stage 3 — durable OAuth token manager.** The lease protocol from C4 (claim → refresh
→ conditional finalize; grace period + single bounded recovery; `broken` surfaced with
the login link); discriminated `AuthStatus` union lands here as part of the
`ready | refreshing | broken` contract; user profile persisted, restoring the status
`user` field; refresh logging (state transitions, never tokens).

**Stage 4a — trust boundaries + error contracts.** Valibot schemas as the sole X
wire-contract source (application types derive from them); request body/query/env
parsers; `satisfies` on every handler; error mapping (401/403/429 preserved, parse
errors → 400, no raw internals in 500s); client content-type guard; module-scope
Worker app (S2’s per-request rebuild).

**Stage 5a — the cost-aware gateway.** Receipts (as estimates) on every X call,
per-request accumulation surviving partial failure (fixes H1); the Saved-tab
manual-add decision (H5).

**Stage 5b — conversation lifecycle.** `incomplete → complete | failed` status +
backfill boundary (H2); incremental page persistence owned by an application service;
“resume older” separated from “refresh newer”; retry policy with logging.

**Stage 5c — bookmark reconciliation.** Scan returns `{ids, complete}`; identity from
folder IDs, not hydrated posts; `errors` array parsed; removal only after a complete
enumeration (H4’s full fix, replacing 0B-5’s guard).

**Stage 6a — server state.** Enable ESLint + react-hooks *first*; TanStack Query with
`rootId` keys, cancellation, rollback, distinct empty/error states; `<Thread
key={rootId}>`; kills the stale-refresh and misleading-empty-state bugs properly.

**Stage 6b — the thread engine.** `buildThread`/ThreadModel single pass (with
`PostNode | GapNode`); keyboard reducer + command table (HELP generated from it).

**Stage 6c — render hygiene.** Real context + memoized `PostCard`; StrictMode; error
boundary; `__xdbg` into an effect; clamp measurement off the render path.

**Stage 7 — polish.** Remaining comment-rot fixes from
[comment-audit.md](comment-audit.md); `docs/x-api-notes.md` (dated ADR page for X
platform knowledge); README rewrite; tsconfig project references.

# Part 5 — The adversarial dialogue

After the synthesis, Claude and Codex ran a four-round truth-seeking dialogue at the
owner’s direction (transcripts: [r1](codex-dialogue-r1.md), [r2](codex-dialogue-r2.md),
[r3](codex-dialogue-r3.md), [r4](codex-dialogue-r4.md)). Ground rule: converge on what
is true, not on a diplomatic middle. Both sides moved:

**Codex retracted** Drizzle, React Router, the vitest/RTL/Playwright/fast-check stack,
immediate job-polling machinery, the ledger-as-prerequisite, and (r3) softened its
never-reclaim lease rule into the bounded one-recovery protocol.

**Claude conceded** the C1 failure narrative (poisoned cache, not “nothing cached”),
the OAuth clobber claim (impossible on that path) and CAS-after-refresh insufficiency,
the subrequest-ceiling certainty, hotfixes-before-tests (→ 0A/0B), stage granularity
and the migration-ledger requirement, the token manager’s priority, and the types-only
XDK middle (r4: the SDK’s types are post-transform, not wire types).

**Jointly derived, better than either starting position:** the lease protocol with
grace period + single flagged recovery attempt; the honest D1 test posture (Codex read
the installed miniflare source and proved no local harness enforces the param limit);
the store-only auth-status hotfix; the strict page-budget floor rule.

**New findings surfaced in dialogue, verified:** the billable `getMe` on every
`/api/auth/status` call; `Client.isTokenExpired()`/`refreshToken()` being stubs in the
XDK; the SDK auth selector silently preferring the app bearer on dual-scheme endpoints.

**Residual reservation (non-blocking, recorded):** X does not document its
refresh-token replay/revocation scope; the one-recovery policy is a deliberate
availability tradeoff to be adjudicated by observed production behavior.

## Reviewer convergence

| Finding                         | code-rev | simplifier | types | silent-fail | comments | tests | Codex |
|---------------------------------|----------|------------|-------|-------------|----------|-------|-------|
| C1 D1 param limit               | ✓        | ✓          |       | ✓           | ✓        | ✓     | ✓     |
| C2 NaN spend caps               | ✓        |            | ✓     | ✓           |          |       | ✓     |
| C3 30-day window                |          |            |       |             |          |       | ✓     |
| C4 OAuth rotation               |          |            | ✓     | ✓           |          | ✓     | ✓     |
| H1 cost undercount              | ✓        |            |       | ✓           | ✓        |       | ✓     |
| H2 truncation transient         |          | ✓          | ✓     | ✓           |          | ✓     | ✓     |
| H4 sync deletes live bookmarks  |          |            |       | ✓           | ✓        |       | ✓     |
| S1 two-store duplication        | ✓        | ✓          | ✓     | ✓           | ✓        | ✓     | ✓     |
| S2 app.ts closure               | ✓        | ✓          | ✓     |             |          | ✓     | ✓     |
| S4 Thread.tsx re-derivation     | ✓        | ✓          | ✓     |             |          | ✓     | ✓     |
| Zero tests as top risk          | ✓        | ✓          |       |             |          | ✓     | ✓     |

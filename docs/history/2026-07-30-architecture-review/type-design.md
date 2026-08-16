# Type Design Review: x-threaded (full codebase at HEAD)

## 1. Top-line assessment

This codebase's *behavioral* documentation is exceptional — nearly every non-obvious invariant is written down in a comment. Its *type-level* enforcement is close to zero. The style is "plain interfaces + prose", and the divergence from what a strong senior TypeScript design would look like falls into four clusters:

1. **State blobs instead of discriminated unions.** `AuthStatus`, `TreeNode`'s placeholder flags, and the OAuth seed-token path all represent mutually exclusive states as optional/boolean field combinations, so illegal states are representable and the compiler can't help callers.
2. **No parse boundary anywhere.** X API responses, client request bodies, query params, env config, and DB JSON columns are all trusted casts. Two of these gaps are not stylistic — they can spend real money (Finding 1) and corrupt the UI's honesty about data completeness (Finding 2).
3. **Sentinel values instead of absent-by-type.** Placeholder posts are fake `Post`s with `authorId: ""`, `fetchedAt: ""`; a cleared bookmark folder is `""` pretending to be `null`; the seed token is `expiresAt: 0, scope: ""`.
4. **The `Storage` interface is a route-shaped grab-bag** implemented twice with ~600 lines of pairwise-duplicated SQL, and two of its most important invariants (billing dedup ordering, refresh-token rotation) live in comments at call sites rather than in the abstraction.

For a single-user personal tool this is a reasonable simplicity trade-off overall, and I would *not* recommend a wholesale zod-ification. But a handful of targeted changes (Findings 1–5) are cheap and guard against real bugs, one of which (unvalidated numeric params) is a genuine money hazard.

---

## 2. Per-type analysis

### Type: `Post` (src/shared/types.ts:29–46)

**Invariants identified**
- `parentId === null` ⟺ conversation root (doc comment, types.ts:32) — **violated** by `placeholderPost` (src/web/tree.ts:27–44), which builds non-root posts with `parentId: null`, plus sentinel `authorId: ""`, `text: ""`, `fetchedAt: ""`, `authorHandle: "i"`.
- `conversationId` is itself the root's post ID — load-bearing everywhere (`rootId = post.conversationId`, app.ts:438; resolve route, app.ts:392–399) but expressed nowhere.
- `media`/`entities` normalized: empty means `null`, never `[]` (xapi.ts:103–105, 138). Good construction-time normalization, but `PostEntities { urls?: UrlEntity[] }` (types.ts:16–18) still allows `{}`, `{ urls: [] }`, and `null` — three spellings of "none".
- `createdAt`/`fetchedAt` are ISO-8601 UTC strings compared lexicographically (`localeCompare` in tree.ts:259, `slice(0, 10)` day-matching in store-sqlite.ts:168, app.ts:491) — format invariant carried entirely by convention.
- `fetchedAt` doubles as the **billing-dedup marker**: `postIdsReadToday` compares its date part, and `ingest` must query it *before* `upsertPosts` overwrites it (comment at app.ts:93). A load-bearing ordering invariant enforced only by a comment.
- `id` must be a numeric snowflake — `snowflakeMs` (tree.ts:22–24) throws on anything else (`BigInt("")`).

**Ratings**
- **Encapsulation**: 3/10 — Open DTO constructible anywhere; `placeholderPost` proves arbitrary construction happens and violates the documented invariant.
- **Invariant Expression**: 6/10 — Doc comments are excellent; nullability is mostly meaningful; `metrics` non-optional is right. But author identity is four flattened fields, `parentId`'s meaning is prose-only, and the nested optionality in `PostEntities` is noise.
- **Invariant Usefulness**: 8/10 — The fields map exactly to what the reader needs; the `conversationId`-is-root convention removes a whole class of joins.
- **Invariant Enforcement**: 2/10 — Nothing validates at any boundary: X API (`as T`, xapi.ts:180), DB roundtrip (`JSON.parse(...) as PostEntities`, storage.ts:189–191), client (`as T`, api.ts:15).

### Type: `TreeNode` + tree module (src/web/tree.ts:3–19, whole file)

**Invariants identified**
- `placeholder: true` ⟺ post is a sentinel; `placementInferred` meaningful only when `placeholder` — but `{ placeholder: false, placementInferred: true }` typechecks.
- `displayText` is two-phase initialized: constructed as `post.text` (tree.ts:228) then mutated by `computeDisplayText` (tree.ts:67). Consumers between the phases would see wrong data.
- `spine` invariants: `spine[0] === root`, `spine[i+1] ∈ spine[i].children`, uniform author (tree.ts:212–222). Every function taking `(root, spine)` (`documentOrder`, `foldOwnerIds`, `scopeIds`) trusts the pair matches; a spine from a different tree typechecks fine. Membership tests use **object identity** (`c !== spine[i + 1]`, tree.ts:149, Thread.tsx:618) — an unstated aliasing invariant.
- `children` sorted chronologically (needed for `threadSpine`'s earliest-fork rule) — established by `buildTree`, invisible in the type.
- `scopeIds` on a placeholder returns the placeholder's (real, missing) post ID, which then flows into `setReadState` — read-state rows for posts absent from `posts` (benign today because `getUnreadIds` joins on `posts`, but unmodeled).

**Ratings**
- **Encapsulation**: 4/10 — Mutable nodes, two-phase init, identity-based coupling between spine and tree.
- **Invariant Expression**: 4/10 — Boolean+optional instead of a union; run/spine/scope semantics live in (admittedly excellent) comments.
- **Invariant Usefulness**: 9/10 — These invariants *are* the product: document order, fold ownership, scope semantics, the reply-count-deficit placement heuristic. They're well-chosen and the functions are small and composable.
- **Invariant Enforcement**: 3/10 — `buildTree` genuinely normalizes (orphan grouping, sorting, placeholder attachment) — a real single-constructor pattern. But nothing prevents mismatched `(root, spine)` pairs, and Thread.tsx re-derives 7 interdependent memos (root, spine, owners, parents, byId, visible, allOrder — Thread.tsx:272–348) whose pairwise consistency is unchecked.

### Type: `Storage` (src/server/storage.ts:23–57) + `SavedItem`, `ConversationMeta`

**Invariants identified**
- Six concerns in one interface: conversations, posts, read-state, OAuth tokens, settings, saved items — the union of what route handlers need, not a domain boundary.
- `upsertConversation` (storage.ts:25) is dishonest: both implementations `ON CONFLICT ... DO UPDATE SET fetched_at` only (store-sqlite.ts:74, store-d1.ts:57), so the signature says "write this meta" and the implementation says "insert or touch timestamp". The refresh path then round-trips stale meta back through it (app.ts:498).
- Two unrelated meanings of "read" share vocabulary: `setReadState`/`getUnreadIds` (user read state) vs `postIdsReadToday` (X billing dedup). The doc comment rescues it, the names don't.
- `SavedItem.source: string` (storage.ts:61) with the union in a comment; compared as a literal at app.ts:244.
- `OAuthTokens.userId?: string | null` (storage.ts:73) — absent *and* null both representable with no semantic difference (stores return `null`, oauth.ts constructs absent).
- No cross-method atomicity: a conversation fetch writes conversation meta, posts, read-state, and saved items in four separate calls (app.ts:452–469); a crash mid-way leaves torn state (e.g., conversation row without `markConversationRead`).
- `getPostsByIds` silently returns the found subset — callers know (app.ts:227 `if (!post) continue`) but the signature doesn't say.
- ~600 lines of near-identical SQL duplicated between store-sqlite.ts and store-d1.ts — every query maintained twice for one shared SQLite dialect (`SCHEMA` is explicitly shared, storage.ts:76).

**Ratings**
- **Encapsulation**: 5/10 — SQL is hidden from routes (good), but the module also exports `PostRow`/`ConversationRow`/`SCHEMA`, and the interface shape leaks route structure.
- **Invariant Expression**: 4/10 — Dishonest upsert, stringly `source`, double-optional `userId`, colliding "read" vocabulary.
- **Invariant Usefulness**: 6/10 — Each method earns its keep; `postIdsReadToday` encodes the domain-critical billing rule.
- **Invariant Enforcement**: 3/10 — No transactions across the multi-step route flows; `putOAuthTokens` is a blind overwrite (Finding 3); JSON columns are trusted casts.

### Type: API response types (src/shared/types.ts:48–149) + the cast pipeline

**Invariants identified**
- Contract enforcement is sporadic: some handlers annotate (`const response: OwnPostsResponse`, app.ts:349), most return inline literals. The type already lies: `/api/auth/status` returns `loginUrl` (app.ts:371) which `AuthStatus` doesn't declare.
- `AuthStatus` (types.ts:140–149) is a state blob: `{ configured: false, user: {...} }`, `{ authorized: true, error: "..." }` all representable. Inbox.tsx:301 has to re-check `auth.user ?` inside an authorized branch because the type can't promise it.
- `ConversationResponse.truncated` is documented as "the fetch stopped at MAX_POSTS_PER_FETCH" (types.ts:70) but is modeled as response-transient while truncation is actually a persistent property of the cache (Finding 2).
- `cost?: FetchCost` — optionality encodes "this response involved API reads" (types.ts:74), overloading `undefined`; `RefreshResponse` redundantly redeclares it (types.ts:92) though it inherits it.
- `unreadIds: string[]` alongside `posts` — invariant `unreadIds ⊆ posts.map(id)` holds by SQL-join construction server-side, unstated in the type; client mutates it optimistically without reconciliation on failure (App.tsx:169–180).
- `quoted: Record<string, Post>` — key === value.id unstated; appears on four response types.
- `SettingsResponse.bookmarkFolderId: string | null` — but clearing writes `""` (app.ts:181), so runtime has three states (null, "", id) where the type promises two; every consumer accidentally survives via falsiness.
- Name collision: `FetchCost` the shared type vs `FetchCost` the React component (Inbox.tsx:27).

**Ratings**
- **Encapsulation**: 3/10 — The shared-types-as-contract idea is right, but nothing binds handlers to it (no `satisfies`, no typed `c.json<T>`), and both directions are unchecked casts.
- **Invariant Expression**: 5/10 — Doc comments carry real meaning; but `AuthStatus` and the `""`-vs-`null` settings hole misexpress their state spaces.
- **Invariant Usefulness**: 7/10 — The response shapes match UI needs closely; `FetchCost`'s posts/billable split is a genuinely good domain type.
- **Invariant Enforcement**: 2/10 — Zero runtime validation; drift already exists (`loginUrl`).

### Type: `OAuthTokens` / `OAuthConfig` / token flow (src/server/oauth.ts, storage.ts:66–74)

**Invariants identified**
- **Rotation invariant**: refresh tokens are single-use; the new pair must be persisted before use (comment, oauth.ts:124–127). Enforced by statement order in `getUserAccessToken` (oauth.ts:185–187) and by `refresh` being module-private — good. Not enforced against **concurrency**: two overlapping requests past expiry both call `refresh` with the same token; X invalidates the chain and the second `putOAuthTokens` clobbers whichever won. `Storage.putOAuthTokens` has no compare-and-swap. On Workers this is a real race (Finding 3).
- Seed state modeled as sentinel tokens (`expiresAt: 0, scope: ""`, oauth.ts:173–178) rather than a distinct state.
- `scope: string` space-joined, split ad hoc in two places (oauth.ts:193, app.ts:379).
- The `SELF` row-id: oauth.ts exports `SELF_ID` (oauth.ts:121) which **nobody imports**, while app.ts hardcodes `"self"` twice (app.ts:158, 374).
- `expiresAt` is unix-ms `number` while every other timestamp in the system is an ISO string — documented (storage.ts:69) but a units brand would end the question.

**Ratings**
- **Encapsulation**: 6/10 — The refresh machinery is well-contained; `refresh` private is exactly right. Magic-string row IDs leak.
- **Invariant Expression**: 5/10 — The most important invariant in the file exists only as a comment; seed/stored/absent states are sentinel-encoded.
- **Invariant Usefulness**: 8/10 — Rotation-before-use and refresh-margin are precisely the invariants that prevent lockout.
- **Invariant Enforcement**: 4/10 — Enforced along one happy path; unguarded against the concurrent path that will eventually happen.

### Cross-cutting: stringly-typed IDs

`PostId`, `ConversationId`, `UserId`, `FolderId`, `MediaKey` are all `string`. Evidence they'd pay their way *selectively*:

- Post IDs already have three informal parse sites — `parsePostUrl` (urls.ts:9), `parseRoute` (App.tsx:21), and `snowflakeMs`'s implicit digits-only precondition (tree.ts:22) — a branded `PostId` with one `parsePostId` would unify them and make `snowflakeMs` total.
- `ConversationId = PostId` as a branded alias would *state* the root-identity convention the whole app leans on, instead of the reader inferring it from `rootId = post.conversationId`.
- Bare `string[]` flows through read-state, saved items, and quoted-post plumbing where a `userId`/`postId` mixup would typecheck today (`groupOwnThreads(posts, userId)` sits next to conversation-ID maps, app.ts:284).
- `FolderId`, `MediaKey`: not worth it — single-use, no crossing flows.

Verdict: brand `PostId` and `UserId` (~15 lines total, zero runtime cost); skip the rest.

---

## 3. Findings by severity

### Finding 1 (High): unvalidated numeric inputs can trigger unbounded paid API scans

- `GET /api/me/posts?threads=abc` → `Number("abc") = NaN` (app.ts:328). Then `items.length >= NaN` and `posts.length >= MAX_SCAN(NaN)` are both always false, so the loop (app.ts:338–346) pages until the timeline API is exhausted (up to ~3,200 posts × $0.001, plus $0.005 root lookups), then `slice(0, NaN)` returns nothing. Money spent, empty response.
- Same pattern for config: `Number(env.MAX_POSTS_PER_FETCH ?? 500)` (worker.ts:43, index.ts:8) — a malformed value yields `maxPosts = NaN`, and `posts.length >= maxPosts` in `fetchConversation` (xapi.ts:353) never trips, removing the spend cap on every conversation fetch.

Cloudflare Access reduces the attacker surface, but this is exactly the class of bug the app exists to prevent (uncontrolled spend). Fix with a total parse function, no library needed:

```ts
// shared: parse-or-default with bounds; NaN can never escape
function intInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}
// app.ts: const target = intInRange(c.req.query("threads"), 10, 1, 50);
// worker.ts/index.ts: const maxPosts = intInRange(env.MAX_POSTS_PER_FETCH, 500, 1, 5000);
```

### Finding 2 (High): `truncated` is typed as transient but is a persistent property — cached views lie

A capped fetch returns `truncated: true` once. The flag is never persisted; `conversationResponse` defaults it to `false` (app.ts:49), so every later `GET /api/conversations/:rootId` reports a truncated cache as complete. Thread.tsx then computes `hiddenReplyCounts` (gated on `!conversation.truncated`, Thread.tsx:328–331) against an incomplete tree, showing wrong "N replies not available" annotations — the exact misinformation the gate was written to prevent. The type system pointed straight at this: truncation belongs on the cached-conversation record, not the response envelope.

```ts
// storage.ts
export interface ConversationMeta {
  rootId: ConversationId;
  fetchedAt: IsoUtc;
  truncated: boolean;   // persisted; cleared when a refresh drains pagination
}
// ConversationResponse.truncated is then derived from the cache, honest on every path.
```

(Also fixes the dead denormalized fields — see Finding 8.)

### Finding 3 (Medium-High): refresh-token rotation race; `putOAuthTokens` is a blind overwrite

Two concurrent requests that both find the token expired both call `refresh` (oauth.ts:181–187). X rotates refresh tokens; the loser's grant chain dies and its `putOAuthTokens` may clobber the winner's fresh pair, forcing a manual re-auth. The storage signature can encode the guard:

```ts
// Storage
/** Persist rotated tokens only if the stored refresh token still matches.
 *  Returns the tokens now in the store (winner's on conflict). */
rotateOAuthTokens(id: string, expectedRefreshToken: string, next: OAuthTokens): Promise<OAuthTokens>;
```

SQLite/D1 both support `UPDATE ... WHERE refresh_token = ?` + read-back, which makes the CAS one statement. In `getUserAccessToken`, on CAS failure, use the returned (winner's) tokens instead of the failed refresh. This converts a comment-only invariant ("the caller must persist the result before using it") into an interface obligation, and handles the concurrent case the comment can't.

### Finding 4 (Medium): placeholder posts are sentinel `Post`s; `TreeNode` should be a discriminated union

`placeholderPost` (tree.ts:27–44) manufactures `Post`s that violate `Post`'s own documented invariants, distinguishable only via a boolean sitting next to an optional that's meaningless without it. Redesign:

```ts
type TreeNode = PostNode | GapNode;
interface PostNode {
  kind: "post";
  post: Post;
  displayText: string;          // computed at construction, not mutated after
  children: TreeNode[];
}
interface GapNode {               // a post the API wouldn't return
  kind: "gap";
  id: PostId;                     // the real missing post's ID
  createdAt: IsoUtc;              // from the snowflake
  placement: "inferred" | "root-fallback";
  children: TreeNode[];
}
```

Payoffs: `placeholderPost` is deleted outright; `PostCard`'s branch becomes a `switch` on `kind`; `placementInferred`-without-`placeholder` becomes unrepresentable; `hiddenReplyCounts`' explicit skip (tree.ts:325) becomes structural; and read-state writes for gap IDs (via `scopeIds`) become a visible decision instead of an accident. Cost: a `kind` check in ~6 call sites. This is the highest leverage-per-line change in the codebase.

### Finding 5 (Medium): `AuthStatus` is a state blob — make it a union and stop the drift

The server already returns a field the type doesn't declare (`loginUrl`, app.ts:371). Redesign (types.ts:140–149):

```ts
type AuthStatus =
  | { state: "unconfigured" }
  | { state: "unauthorized"; loginUrl: string; error?: string }
  | { state: "authorized"; user: XUser; scopes: Scope[]; expiresAt: number | null };
type Scope = "tweet.read" | "users.read" | "bookmark.read" | "offline.access";
interface XUser { id: UserId; username: string; name: string }
```

`ConnectPrompt` and the Inbox's `auth.user ?` re-check (Inbox.tsx:301) collapse into exhaustive narrowing; the three handler returns in `/api/auth/status` (app.ts:366–388) each construct exactly one variant, and `satisfies AuthStatus` on each would have caught `loginUrl` on day one.

### Finding 6 (Medium): the parse-don't-validate boundary belongs at X API ingestion — and only there

There are four candidate boundaries; they don't deserve equal treatment:

1. **X API → app (xapi.ts:180 `as T`)**: highest value. External, versionless, and its output is *persisted* — one malformed response poisons the cache forever. A single valibot/zod schema for `ApiTweet`/`Includes`/`SearchPage` parsed inside `XApi.get` covers every endpoint, and `toPost` becomes provably total.
2. **Client request bodies (app.ts:179, 431, 526)**: `/api/read-state` already hand-validates; `/api/settings` PATCH and `/api/conversations` POST are casts. Cheap to align — three tiny schemas or hand checks. Plus Finding 1's numeric params.
3. **DB JSON columns (storage.ts:189–191)**: medium — self-written data, but it survives schema evolution (the codebase already migrates columns, store-sqlite.ts:30–36). A lenient parse-with-fallback-to-null is enough.
4. **Client ← server (api.ts:15)**: skip runtime validation — same repo, same types. The real fix is *binding handlers to the shared types* so the compile-time contract is actually checked: annotate every `c.json` payload with `satisfies ConversationResponse` etc. Zero runtime cost, catches `loginUrl`-class drift.

### Finding 7 (Medium): `Storage` should be one implementation over a tiny driver, not one interface with two SQL copies

The two stores implement the same shared `SCHEMA` (storage.ts:76) in the same SQL dialect with structurally identical queries — ~600 duplicated lines where any future query change must be made twice or drift silently (the argument-order hazard in the 19-column `upsertPosts` bind lists, store-sqlite.ts:110–145 vs store-d1.ts:86–120, is exactly the kind of thing that diverges). The honest abstraction boundary is the *driver*, not the repository:

```ts
interface SqlDriver {
  get<T>(sql: string, params: unknown[]): Promise<T | null>;
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
  run(sql: string, params: unknown[]): Promise<void>;
  batch(stmts: { sql: string; params: unknown[] }[]): Promise<void>;
}
class SqlStore implements Storage { constructor(private db: SqlDriver) {} /* all queries once */ }
```

Each runtime provides a ~20-line adapter (bun:sqlite is sync — wrap; D1 maps directly). Secondarily, split the interface by role (`ConversationStore`, `ReadStateStore`, `TokenStore`, `SettingsStore`, `SavedStore`) so signatures like `getUserAccessToken(store: TokenStore, ...)` state their actual dependency — today `oauth.ts` demands all 20 methods to touch 2.

Also fold the billing-order invariant into the boundary: `ingest`'s check-before-upsert dance (app.ts:84–98) should be one method, `ingestPosts(posts): Promise<FetchCost>`, so "query `fetchedAt` before overwriting it" is physically impossible to get wrong from the outside.

### Finding 8 (Low): accumulated small dishonesties

- `SavedItem.source` / `SavedEntry.source`: `string` → `type SavedSource = "bookmark" | "manual"` (storage.ts:61, types.ts:102; compared as literal at app.ts:244, Inbox.tsx:271).
- Settings `""`-means-cleared vs declared `string | null` (app.ts:181): store the pair as one JSON setting `{ id: FolderId; name: string } | null` — also fixes id/name desync, which today is two independent rows.
- `OAuthTokens.userId?: string | null` → `userId: UserId | null` (storage.ts:73).
- `upsertConversation`'s update-only-touches-`fetchedAt` behavior: either rename (`touchConversation`) or make it honest — moot if Finding 2's slimmer `ConversationMeta` lands, since `rootAuthorHandle`/`rootText`/`rootCreatedAt` are written but never read by any route (the list route re-reads the root from `posts`, app.ts:405).
- `SELF_ID` exported but unused (oauth.ts:121) while `"self"` is hardcoded twice in app.ts:158,374 — use the constant or drop it.
- `postIdsReadToday` → rename to `postIdsBilledToday` to break the "read" collision with read state.
- `RefreshResponse` redeclares inherited `cost` (types.ts:92); `FetchCost` type vs `FetchCost` component name collision (Inbox.tsx:27).
- `MediaItem.type: string` → `"photo" | "video" | "animated_gif" | (string & {})` — PostView already branches on the literals (PostView.tsx:125,138).
- `spineLength`'s `byParent: Map<string, Post>` (app.ts:268–271) silently assumes at most one own-reply per parent; a forked self-thread makes the map drop a branch (last write wins). Harmless for a count, but `Map<PostId, Post[]>` would state the truth.

---

## 4. From scratch: the domain model I'd build first

The core insight this app rests on: **a conversation is a partially-observed tree, and observations cost money.** The ideal model makes partiality and cost first-class instead of ambient.

```ts
// ---- ids.ts — parsed once, total everywhere after ----
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };
export type PostId = Brand<string, "PostId">;          // digits-only snowflake
export type UserId = Brand<string, "UserId">;
export type ConversationId = PostId;                    // a conversation IS its root post
export type IsoUtc = Brand<string, "IsoUtc">;           // lexicographic order == time order
export function parsePostId(raw: string): PostId | null { return /^\d{5,}$/.test(raw) ? raw as PostId : null; }
export function snowflakeMs(id: PostId): number { /* now total */ }

// ---- post.ts — one honest observation of one post ----
export interface Author { id: UserId; handle: string; name: string; avatarUrl: string | null }
export interface Post {
  id: PostId;
  conversationId: ConversationId;
  parentId: PostId | null;         // null ⟺ id === conversationId — assert in the sole parser
  author: Author;                  // grouped: an author is one thing, not four columns
  text: string;
  createdAt: IsoUtc;
  metrics: PostMetrics;
  urls: UrlEntity[];               // empty = none; no null/[]/undefined trinity
  media: MediaItem[];
  quotedPostId: PostId | null;
  fetchedAt: IsoUtc;               // observation time; billing uses a separate billedOn date
}
// Sole constructor: parsePost(apiTweet, includes) — the parse-don't-validate boundary,
// where the root⟺no-parent assertion and text unescaping live.

// ---- cache.ts — partiality is a property of the cache, not the response ----
export interface CachedConversation {
  rootId: ConversationId;
  fetchedAt: IsoUtc;
  completeness: "complete" | "truncated";   // Finding 2, made unforgettable
}

// ---- tree.ts — gaps are not posts ----
export type TreeNode =
  | { kind: "post"; post: Post; displayText: string; children: TreeNode[] }
  | { kind: "gap"; id: PostId; createdAt: IsoUtc;
      placement: "inferred" | "root-fallback"; children: TreeNode[] };

/** The one constructor; everything downstream consumes the bundle whose parts
 *  provably came from the same build — no more 7 must-agree memos. */
export interface ThreadModel {
  root: TreeNode & { kind: "post" };
  spine: readonly TreeNode[];                  // spine[0] === root by construction
  order: readonly TreeNode[];                  // full document order
  parents: ReadonlyMap<PostId, PostId | null>;
  folds: { branch: ReadonlySet<PostId>; segment: ReadonlySet<PostId> };
}
export function buildThread(rootId: ConversationId, posts: Post[]): ThreadModel | null;

// ---- auth.ts — states, not flag soup ----
export type Scope = "tweet.read" | "users.read" | "bookmark.read" | "offline.access";
export type AuthStatus =
  | { state: "unconfigured" }
  | { state: "unauthorized"; loginUrl: string; error?: string }
  | { state: "authorized"; user: { id: UserId; username: string; name: string };
      scopes: Scope[]; expiresAt: number | null };
export type TokenSource =
  | { kind: "stored"; tokens: OAuthTokens }
  | { kind: "seed"; accessToken: string; refreshToken: string }   // no expiresAt:0 sentinel
  | { kind: "none" };

// ---- cost.ts — the app's reason to exist gets its own types ----
export type Usd = Brand<number, "Usd">;
export interface FetchCost { posts: number; billable: number; usd: Usd }
// Storage owns the invariant: ingestPosts(posts): Promise<FetchCost>
// (billed-today check and upsert are one atomic operation, ordering unforgeable)
```

**Enforcement placement, in priority order:** (1) parse X API responses in `XApi.get` — the only untrusted, persisted input; (2) total parsers for numeric config/query params — the money guard; (3) `satisfies` annotations binding every Hono handler to the shared response types — free contract checking; (4) `rotateOAuthTokens` CAS in `Storage`; (5) skip client-side response validation entirely — the shared types plus (3) already make that boundary compile-time-honest.

What I would deliberately *not* do: brand every string (FolderId, MediaKey — no crossing flows), introduce a Result type for `Storage` (infrastructure failures bubbling as exceptions is fine at this scale), or model read-state as an event log. The current `unreadIds`-derived-by-join design is genuinely good — read state is stored once, derived everywhere, and cannot desynchronize server-side; the only gap is the client's optimistic update having no reconciliation story, which is acceptable for one user.

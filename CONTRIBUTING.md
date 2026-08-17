# Contributing

This is a single-maintainer personal tool that happens to be deployable by
anyone. Issues and pull requests are welcome; so is forking it and never
speaking to me again.

## Getting set up

[`DEPLOYING.md`](DEPLOYING.md) step 2 — clone, `bun install && bun run build`,
put a token in `.env`, `bun run dev:server`. You need an X developer account on
pay-per-use for anything that talks to X, but most of the code can be worked on
and tested without one.

## The gates

```bash
bun run lint && bun run typecheck && bun test && bun run test:d1 && bun run build
```

All five, before a PR. Two of them have non-obvious reasons:

- **`typecheck` is `tsc -b --force`.** Incremental `tsc -b` trusts the
  `.tsbuildinfo` files, and a stale one reports success over sources that no
  longer compile. That was demonstrated, not theorised. A gate that can pass on
  broken code is not a gate — please don't "optimise" the flag away.
- **`test:d1` is not optional.** It runs the storage contract against a real
  workerd D1 binding, verifying D1's API shapes, batch behaviour, and the schema
  produced by `migrations/`. Local workerd does **not** enforce D1's service
  limit of 100 bound parameters per statement; the fake-D1 contract in the
  default `bun test` suite owns that regression. The D1 leg disables persistence,
  remote bindings, and env-file loading, and guards that the repo's normal
  `.wrangler/state` fingerprint is unchanged. It is slow because it boots
  workerd, which is why it's out of the default run, not because it's secondary.

CI follows the five contributor gates with
`bunx wrangler deploy --dry-run`. That validates the Worker bundle,
configuration, and static-asset wiring without deploying anything; run it
locally too when changing the Worker entry, `wrangler.jsonc`, or assets setup.

## Four invariants

Most review findings on this codebase have come back to one of these.

**Money is accounted structurally.** Every `XApi` method returns its value with
a cost receipt attached (`Billed<T>`, see `src/server/xapi.ts` and `meter.ts`),
so a code path that spends without reporting has to be *written* to look wrong.
Adding an X call means adding its receipt. Related: config that bounds main
search-result spending fails closed — a malformed `MAX_POSTS_PER_FETCH` refuses
to boot rather than silently removing that bound. It is not a total spend cap:
referenced posts and media/root/quote lookups can add billed reads. A deployment
with no gate likewise refuses to serve rather than silently opening. Keep that
direction.

**Nothing per-deployment goes in `wrangler.jsonc`.** It's committed, so anything
in it follows every fork — a pinned `database_id` would aim a stranger's Worker
at someone else's database. Per-deployment values are secrets, documented in
`.env.example`.

**`migrations/` is the only source of schema.** Add a new numbered file; never
edit `0001_init.sql`, which existing databases have already recorded and will
skip. After first bootstrap, apply migrations before deploying a Worker that
needs new columns. The bootstrap exception is documented in `DEPLOYING.md`:
the first raw deploy must provision D1 before migrations can run.

**Account transitions are owned protocols, not settings writes.** Account-bound
requests carry the observed opaque account generation and must reject a stale
generation atomically before X spend or mutation; confirmation dialogs retain
the generation under which they opened. X work also carries the observed
refresh token and is checked before outbound calls and conditional persistence.
A folder switch must stage its paid target scan
under the source/target/run lease and atomically activate only a complete scan;
selecting an option in the UI must remain inert until explicit confirmation.
Stopping sync requires a `keep` or `remove` disposition for bookmark-owned
Saved rows. Reauthorization is same-account-only and uses a callback lease plus
identity comparison before replacing the grant, while preserving that account's
folder and library. Claiming that callback must first durably move the old pair
to `reauthorizing`: only a conclusive provider refusal or confirmed
different-account identity may restore its displaced state. Ambiguous exchange,
identity, and promotion outcomes stay fenced; a read-after-error probe must
distinguish a committed promotion before cleanup can revoke its token. A settled
or expired pending row with cached identity may be reclaimed only by another
same-account callback. Disconnect first claims the grant, fences competing
bookmark/profile/timeline work, and revokes at X; only confirmed revocation may
atomically apply the disposition and remove local credentials. An account X
request already sent can still bill, but its late result must not persist. A
fresh login after terminal disconnect is a new account generation with no
inherited folder or bookmark ownership. Keep these rules coherent across routes,
storage drivers, and client cache invalidation.

Before changing anything that talks to X, read
[`docs/x-api-notes.md`](docs/x-api-notes.md); before touching the thread view,
[`docs/design/`](docs/design/README.md). The README's Further reading section
says what each one is for.

## Two traps worth knowing about

**The react-hooks compiler fails silently.** A duplicate identifier — or any
compile-ish error — makes the `react-hooks` ESLint rules skip the *entire*
component without saying so. The only symptom is an "unused eslint-disable
directive" warning. So if that warning appears on a file with real
`eslint-disable` comments in it (`Thread.tsx` has several), the directive is
almost certainly *not* dead: the compiler bailed, and the rules you think are
protecting that component are not running.

**Ref writes must be in event handlers, and the variable name must end in
`Ref`.** The compiler enforces both, and the diagnostic doesn't make the naming
requirement obvious.

## Things that look like bugs and are not

Several behaviours are deliberate, argued about at length, and documented at
the point where they happen. Before "fixing" one, read the comment next to it:

- The spend meter **over-counts in one place** — re-reading a referenced post to
  resolve its media is billed even when the same post was read minutes earlier.
  The estimate is meant to lean high.
- **Opening a cached conversation currently auto-refreshes** it. That is an
  explicit code path, not accidental query invalidation, but whether the product
  should keep automatically spending there remains user decision 3 in
  `PLANS.md`. An empty cross-day `since_id` page normally bills nothing, but a
  same-day full reread or missing media/root/quote hydration can still produce a
  charge.
- Protected accounts' replies stay as **"unavailable post" placeholders**.
  Full-archive search accepts the app-only bearer *only* (see x-api-notes N5),
  so conversation trees can never run as the signed-in user.
- Resuming a truncated fetch can **step over a mid-history gap**; a full
  re-read repairs it. See the `oldestReplyId` docstring.

## Known gaps

They live in the README's [Limitations](README.md#limitations) section, written
as what a user notices rather than as what's absent from the code. Notes for
whoever picks one up:

- The **per-conversation run lease** is durable and renewable. It starts at five
  minutes; the owner checks before every outbound X boundary and internal
  100-ID lookup batch, renews when less than 90 seconds remain or when first
  marking possible post persistence, and holds ownership through quote
  resolution. An active overlap must be rejected once the root is known, and
  only the `run_id` owner may finish or restore. Recovery can overlap only if
  one X operation or a between-boundary stall outlives the protected window;
  the stale owner still cannot write lifecycle metadata. A write-less recovery
  may restore the prior lifecycle, while possible post persistence leaves the
  conversation conservatively partial. Before the root is known, concurrent
  requests for the same unseen post can still each buy the initial lookup; the
  root lease prevents losing requests from continuing into conversation search.
- The **settings surface** is further along than it looks — the `settings`
  table, clear-only `/api/settings` route, confirmed `/api/bookmarks/switch`
  protocol, and bookmark-folder controls already exist. Both runtime entries
  already read the fetch cap from the environment. What's missing is an in-app
  lower override, with that environment value remaining the hard ceiling.
- **Disconnect ownership does not include public conversation fetching.** It
  fences work attached to the user OAuth grant. Conversation fetches use the
  app-only bearer and their own per-root lease, so disconnecting X neither
  cancels them nor resolves the separate automatic-spend product decision.
- A **Your posts** request may scan at most four 50-post timeline pages and may
  return at most 50 threads. Filtering self-thread continuations and replies
  into other people's conversations can leave fewer than the requested number
  while `hasMore` remains true. Preserve that truthful result instead of buying
  a fifth page or treating the timeline as exhausted.

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
  workerd D1 binding, and D1 rejects things `bun:sqlite` happily accepts —
  above all **a limit of 100 bound parameters per statement**
  (`MAX_SQL_PARAMS` in `src/server/db/driver.ts`). That limit shipped as a
  production bug once, invisible in local dev for weeks. It's slow, which is
  why it's out of the default `bun test` run, not because it's secondary.

## Three invariants

Most review findings on this codebase have come back to one of these.

**Money is accounted structurally.** Every `XApi` method returns its value with
a cost receipt attached (`Billed<T>`, see `src/server/xapi.ts` and `meter.ts`),
so a code path that spends without reporting has to be *written* to look wrong.
Adding an X call means adding its receipt. Related: config that caps spending
fails closed — a malformed `MAX_POSTS_PER_FETCH` refuses to boot rather than
silently uncapping, and a deployment with no gate refuses to serve rather than
silently opening. Keep that direction.

**Nothing per-deployment goes in `wrangler.jsonc`.** It's committed, so anything
in it follows every fork — a pinned `database_id` would aim a stranger's Worker
at someone else's database. Per-deployment values are secrets, documented in
`.env.example`.

**`migrations/` is the only source of schema.** Add a new numbered file; never
edit `0001_init.sql`, which existing databases have already recorded and will
skip. Apply migrations before deploying a Worker that needs new columns.

## Where the knowledge lives

- **[`docs/x-api-notes.md`](docs/x-api-notes.md)** — read this before changing
  anything that talks to X. It records what this app has *measured* about the
  API, including several behaviours X's own documentation contradicts. Entries
  are labelled Measured or Recorded so you can tell evidence from documentation.
- **[`docs/design/`](docs/design/README.md)** — the design record for the thread
  view. Read it before touching `styles.css`, `Thread.tsx`, or `PostView.tsx`.
  Its own trust order applies: where those documents disagree with `src/web` on
  paint numbers, the app is the truth.
- **[`docs/history/`](docs/history/README.md)** — superseded. Good reasoning,
  stale line numbers. Don't take it as a description of the current code.

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
- **Opening a cached conversation auto-refreshes** it. That's first-view-is-
  consent, not an accident; a no-new-posts refresh bills nothing.
- Protected accounts' replies stay as **"unavailable post" placeholders**.
  Full-archive search accepts the app-only bearer *only* (see x-api-notes N5),
  so conversation trees can never run as the signed-in user.
- Resuming a truncated fetch can **step over a mid-history gap**; a full
  re-read repairs it. See the `oldestReplyId` docstring.

## Known gaps

The list the code means when a comment says "ship-day list":

- **No per-conversation run lease.** Two overlapping runs on one conversation
  can overwrite each other's lifecycle status, and the write-less-death restore
  in `conversation-fetch.ts` can lay a stale snapshot over newer state. Benign
  for a single user driving one browser; the lease is the real fix, and the
  restore should become lease-holder-only when it lands.
- **No in-app settings surface.** `MAX_POSTS_PER_FETCH` is env-only, though the
  `settings` table and `/api/settings` route already exist, and the two
  automatic fetches (open-refresh, own-posts scan on reload) have no toggles.
- **`/api/auth/status` can report `user: null`** for a token row that predates
  profile caching. It heals on any re-login.
- **No placeholder cards for unavailable bookmarks.** Sync reports them; the
  Saved tab doesn't show them.

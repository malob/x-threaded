# x-threaded

> [!WARNING]
> **This is a personal work in progress.** It was built for one person's use,
> and it has not been tested by anyone else, on anyone else's Cloudflare
> account, or against anyone else's X data. It is not fitted for general use:
> expect rough edges, expect to read the source when something is confusing,
> and expect no support. It also spends real money on **your** X API account
> every time it fetches — read [Costs](#costs) and set a spending limit before
> you deploy it.
>
> If you want it anyway, [`DEPLOYING.md`](DEPLOYING.md) is honest about every
> step, and [Limitations](#limitations) is honest about what's missing.

A threaded reader for X/Twitter reply trees. Paste a post URL, get the full
conversation as a navigable tree — the thing x.com's flattened reply view
can't do. Keyboard-driven, with a saved queue fed by an X bookmark folder, a
tab for your own threads, and deep links that mirror x.com's URLs (swap the
domain on any post URL).

It runs as your own single-user deployment. You bring an X API token and pay X
per post you read; the app stores every conversation it buys, and cached posts
render without another X read. Opening a cached conversation also refreshes it,
however: newly returned main or referenced posts, deliberately uncredited media
refetches, and missing root or quote lookups can still bill. The app shows
estimates where it can and receipts for paid actions. There is no hosted
instance and no account system — the deployment is yours.

> **What you need first:** an X developer account with **pay-per-use billing**.
> The free tier can't read conversations at all. Main conversation-search
> results cost about $0.005 each, so 50–500 of them cost $0.25–$2.50; referenced
> posts and follow-up lookups can add reads. Cached posts are free to render,
> but revisiting starts a refresh that may spend — [set a spending
> limit](https://developer.x.com) before you start.

## Try it locally

Three minutes, no Cloudflare account. The Bun server binds only to
`127.0.0.1`, so it is not exposed to the internet.

```bash
bun install && bun run build
cp .env.example .env      # put your Bearer Token in X_BEARER_TOKEN
bun run dev:server
```

Then open <http://localhost:8788> and paste any x.com post URL. That's the
whole app — everything else is about reaching it from somewhere other than
your laptop.

## Deploy it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/malob/x-threaded)

The button clones this repo into your GitHub, provisions a Worker and a D1
database on the free tiers (no card), asks for your X token, and deploys.

**[`DEPLOYING.md`](DEPLOYING.md) is the full procedure** — the button, the
manual route, the Access gate, and connecting an X account for the Your posts
tab and bookmark sync. Using Claude Code? Ask it to deploy this and point it
at that file; it's written to be followed literally.

One thing worth knowing before you start: a deployed Worker holding a working
X token is a way for anyone with the URL to spend your money, so the app
**refuses to serve its API until you've either put a gate in front of it or
said explicitly that you don't want one.** Localhost is never gated.

## Configuration

Deployment configuration is per-deployment and is not committed.
`.env.example` documents each environment value and what it unlocks.
`X_BEARER_TOKEN` is the only credential required to run locally; a deployed
Worker also requires the Access pair or an explicit `ALLOW_UNGATED` choice.
OAuth is optional, and tuning values have working defaults.

| Variable | What it does |
|---|---|
| `X_BEARER_TOKEN` | **Required.** App-only bearer; reads public conversations. |
| `X_OAUTH_CLIENT_ID` / `X_OAUTH_CLIENT_SECRET` | Enables the Your posts tab and bookmark folder sync. |
| `POLICY_AUD` / `TEAM_DOMAIN` | Verify Cloudflare Access JWTs, so the API fails closed if Access is turned off. |
| `ALLOW_UNGATED` | `true` serves a deployed Worker with no gate at all. Deliberately explicit. |
| `MAX_POSTS_PER_FETCH` | Main conversation-search result cap per run, 10–5000 (default 500, at most $2.50 gross for those main results). Referenced posts and follow-up media/root/quote lookups can add billed reads. A malformed value refuses to boot. |
| `PORT` / `DB_PATH` | Bun server only: listen port, SQLite file. |
| `WORKER_PORT` | `scripts/dev-worker.sh` only: port for `wrangler dev`. |

Locally, `cp .env.example .env` and fill it in — both runtimes read it. When
deployed, set the same names with `bunx wrangler secret put NAME`;
`wrangler.jsonc` vars are committed and would follow anyone who forks this
repo.

On D1 Free, the five-page, no-ancillary default-cap regression uses 14 of the
[50 queries allowed per Worker invocation](https://developers.cloudflare.com/d1/platform/limits/).
Higher values are not certified for Free; a full 5,000-main-result run is not
Free-safe even before ancillary lookups.

The user-context features need an initial interactive authorization per deployment at
`/auth/login`. **Give each deployment its own X app.** X allows one live grant
per user per client id, so two deployments sharing a client id revoke each
other's tokens on login — see [`docs/x-api-notes.md`](docs/x-api-notes.md) N15.

## Development

```bash
bun run dev:server       # Bun + a SQLite file
# or, to run the Worker itself:
bun run db:migrate       # applies migrations to the local D1 simulation
./scripts/dev-worker.sh  # wrangler dev + local D1
```

Both targets serve the same app on `:8788`. For frontend work with HMR, also
run `bun run dev:web` (Vite on `:5173`, proxying `/api` and `/auth` to `:8788`).

Before opening a pull request, run the gates and read
[`CONTRIBUTING.md`](CONTRIBUTING.md) — it has them in one place, along with the
invariants worth preserving and two failure modes that are silent. CI follows
those gates with `bunx wrangler deploy --dry-run`, which validates the Worker
bundle and configuration without deploying anything.

## Architecture

One TypeScript repo, two server targets, one set of routes.

- **`src/server/app.ts`** — every API route, as a Hono app with no runtime
  dependencies. `src/server/index.ts` (Bun) and `src/server/worker.ts`
  (Workers) are thin entries that build it with the right storage driver.
- **Storage** — `SqlStore` writes each query exactly once over a five-method
  `SqlDriver` seam (`src/server/db/`), backed by `bun:sqlite` locally and D1
  when deployed. The interface is async so both fit behind it.
- **Schema** — `migrations/` is the only source of it, applied by wrangler
  when deployed and by `src/server/db/migrations.ts` locally.
- **X gateway** — `src/server/xapi.ts` is the only layer that knows an
  endpoint's billing unit; every method returns its value with a cost receipt
  attached, so a call whose spend goes unreported has to be written to look
  wrong.
- **Client** — a React/Vite SPA where TanStack Query owns all server state
  (`src/web/queries/`), the thread tree is a pure model
  (`src/web/thread/model.ts`), and the keyboard layer is a reducer over a
  command table.
- **Types** — five per-runtime tsconfig projects (server, worker, web, shared,
  test), so each file is checked against the globals it actually gets.

## Costs

X's pay-per-use tier bills in three units — $0.005 a post read, $0.001 an
Owned Read (posts in your own timeline or a bookmark folder), $0.010 a User
Read (the identity lookup) — and the app shows estimates or receipts around
paid actions:

| Action | What it costs |
|---|---|
| Fetching a conversation | $0.005 per returned main or referenced post, plus any initial/missing-post, media, or quote lookup; the pre-click estimate covers likely main results |
| Re-opening a cached one | free to render from storage; the automatic refresh can bill newly returned posts or missing media/root/quote lookups |
| Refreshing for new replies | $0.005 per newly returned main or referenced post, plus ancillary lookups; stored page posts read earlier that UTC day are credited |
| Resuming a truncated fetch | $0.005 per newly returned older main or referenced post, plus ancillary lookups |
| Your posts tab | $0.001 per timeline post (Owned Read), plus $0.005 for any thread root older than the scan window; one request reads at most four 50-post timeline pages and returns at most 50 threads, and can report that more may exist |
| Bookmark sync | $0.001 per bookmark enumerated, plus $0.005 per post hydrated |
| User-context identity lookup | A fresh connection defers its $0.010 `/2/users/me` read until the first folder or timeline action and then caches it with that grant. A Reconnect callback that reaches account comparison buys one replacement-grant identity read—even when that account is rejected; identifying a usable old grant with no cached identity first can make two |
| Opening the bookmark-folder picker | folder enumeration itself is free and happens only while the picker is open |
| Choosing or switching bookmark folders | selection is inert until you confirm a paid target-folder scan; only a complete scan atomically activates the folder and replaces the bookmark-owned Saved rows |

Bookmark settings themselves live in the app database and are free to read and
write. The folder picker asks X for folders only when you open it. Settings and
folder-list failures are shown separately from a genuinely empty result, with a
retry control, and any identity lookup or sync charge is reported in the UI.

Folder and account changes are explicit lifecycle operations. Switching folders
first scans the target while the old selection and its Saved rows remain active;
an incomplete, failed, or superseded scan leaves them unchanged. **Stop syncing**
asks whether imported bookmarks should become ordinary local saves or be removed
from this app. Either choice clears the folder selection without changing X, and
manual saves, cached posts and conversations, and read history remain.

**Reconnect** can replace credentials only for the X account already connected.
A callback that reaches account comparison identifies the replacement grant to
enforce that rule, rejects a different account, and preserves the current folder
and local library. The old pair is paused before the code exchange: if X
conclusively refuses the code it is restored, while a timeout, rate limit,
server failure, lost response, identity failure, or local promotion failure
stays visibly paused because the replacement may already have invalidated it.
Retrying **Reconnect** can recover that state for the same cached account; it is
never reported as a usable old session merely because a callback lease expired.
To change accounts, use **Disconnect X**: choose the same
keep/remove treatment for imported bookmarks, then the app fences work owned by
that grant and asks X to revoke it before deleting local credentials and
applying the choice. A user-context X call already sent can still finish and
bill, but its late result cannot be persisted after the account transition. If
X does not confirm revocation, the app retains the existing local grant and
account data so you can retry. After a successful disconnect, the next
connection is fresh: it may authorize any X account, starts with no selected
bookmark folder, and does not turn prior local saves back into bookmark-owned
rows. Fresh connection and terminal disconnect also rotate the opaque account
generation used to namespace browser caches and guard account-bound requests.
Stale tabs are rejected before account work, and a generation change resets a
remembered inbox view to Saved. Same-account reconnect and token refresh preserve
the generation.

Those are estimates, not invoices. X's same-day deduplication is observed
rather than contractual, and the app deliberately over-counts in one place —
re-reading a referenced post to resolve its media is billed even when the same
post was read minutes earlier — so the estimate leans high rather than low.
X's free `/2/usage/tweets` endpoint reports daily post-consumption counts, so
it cross-checks the post counts and not the dollars; the X Developer Console
is where the bill lives, and where you should set a spending limit.

## Limitations

Known and deliberate, as of this writing:

- **Conversation fetches use a renewable five-minute lease.** Once the root is
  known, an active overlap is refused before conversation X calls. The owner
  checks before every outbound boundary and internal 100-ID lookup batch,
  renews when less than 90 seconds remain or before its first possible post
  write, and holds the lease through quote resolution. Recovery can overlap
  only if one X operation or a between-boundary stall outlives that protected
  window. A stale owner cannot overwrite lifecycle metadata, though duplicate
  paid reads are still possible. In particular, simultaneous opens of the same
  entirely unseen post can each buy its initial `$0.005` lookup before either
  knows the root; every losing request is then stopped before conversation
  search.
- **Replies from protected accounts stay "unavailable post" placeholders.**
  Full-archive search accepts the app-only bearer token *only*, so conversation
  trees can never be fetched as the signed-in user — connecting your X account
  doesn't change this. See [`docs/x-api-notes.md`](docs/x-api-notes.md) N5.
- **The main-search cap is an environment variable, not a settings control.**
  Locally, change `MAX_POSTS_PER_FETCH` in `.env` and restart; on Workers,
  `bunx wrangler secret put MAX_POSTS_PER_FETCH` immediately activates the new
  value. The bookmark-folder choice does have an in-app control, but the two
  automatic fetches — the refresh when you open a cached conversation, and the
  own-posts scan when a remembered Your posts tab reloads for the same account
  generation — have no toggles.
  That automatic-spend choice is separate from the X-account lifecycle:
  Disconnect fences user-context work, while public conversation fetches use
  the app-only bearer token and are not canceled by disconnecting an account.
- **Bookmarks you can't read are reported but not shown.** Sync tells you how
  many were unavailable; the Saved tab has no placeholder card for them.
- **A fresh X connection can initially show no account handle.** Login defers
  the first billable identity lookup until a folder or timeline action needs
  it. Reconnect is different: a callback that reaches account comparison buys
  one identity read to identify the replacement grant, even if that account is
  then rejected. Identifying a usable old grant with no cached identity before
  exchange can make two.

## Further reading

- [`DEPLOYING.md`](DEPLOYING.md) — the full deploy procedure, start to finish.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the gates, the invariants worth
  preserving, the traps that fail silently, and what's knowingly missing.
- [`docs/x-api-notes.md`](docs/x-api-notes.md) — what this app has measured
  about the X API, including several behaviours X's own docs contradict. Read
  it before changing anything that talks to X.
- [`docs/design/`](docs/design/README.md) — the design record for the thread
  view: the "avatar graph" grammar, the rulings behind it, and three
  self-contained mockups you can open in a browser.
- [`docs/history/`](docs/history/README.md) — superseded work kept for its
  reasoning, including a seven-reviewer architecture audit and the adversarial
  dialogue that settled its roadmap. Describes older code, not this one.

## License

MIT — see [`LICENSE`](LICENSE).

# x-threaded

A threaded reader for X/Twitter reply trees. Paste a post URL, get the full
conversation as a navigable tree — the thing x.com's flattened reply view
can't do. Keyboard-driven, with a saved queue fed by an X bookmark folder, a
tab for your own threads, and deep links that mirror x.com's URLs (swap the
domain on any post URL).

It runs as your own single-user deployment. You bring an X API token and pay X
per post you read; the app caches every conversation it buys, serves it from
that cache for free afterwards, and prices anything that would spend before
you click it. There is no hosted instance and no account system — the
deployment is yours.

> **What you need first:** an X developer account with **pay-per-use billing**.
> The free tier can't read conversations at all. Reads cost about $0.005 a
> post, so a typical conversation is $0.25–$2.50 to load and free to revisit —
> [set a spending limit](https://developer.x.com) before you start.

## Try it locally

Three minutes, no Cloudflare account, nothing exposed to the internet.

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

Every setting is per-deployment and none are committed. `.env.example`
documents each one and what it unlocks; only `X_BEARER_TOKEN` is required, and
the app degrades cleanly without the rest.

| Variable | What it does |
|---|---|
| `X_BEARER_TOKEN` | **Required.** App-only bearer; reads public conversations. |
| `X_OAUTH_CLIENT_ID` / `X_OAUTH_CLIENT_SECRET` | Enables the Your posts tab and bookmark folder sync. |
| `POLICY_AUD` / `TEAM_DOMAIN` | Verify Cloudflare Access JWTs, so the API fails closed if Access is turned off. |
| `ALLOW_UNGATED` | `true` serves a deployed Worker with no gate at all. Deliberately explicit. |
| `MAX_POSTS_PER_FETCH` | Safety cap per conversation load, 10–5000 (default 500 ≈ $2.50 worst case). A malformed value refuses to boot rather than uncapping spend. |
| `PORT` / `DB_PATH` | Bun server only: listen port, SQLite file. |
| `WORKER_PORT` | `scripts/dev-worker.sh` only: port for `wrangler dev`. |

Locally, `cp .env.example .env` and fill it in — both runtimes read it. When
deployed, set the same names with `bunx wrangler secret put NAME`;
`wrangler.jsonc` vars are committed and would follow anyone who forks this
repo.

The user-context features need one interactive authorization per deployment at
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

Gates: `bun run lint`, `bun run typecheck`, `bun test`, `bun run test:d1`
(the storage contract against a real local-workerd D1 binding — slow, so it is
kept out of the default run), `bun run build`.

`typecheck` is `tsc -b --force` on purpose. Incremental `tsc -b` trusts the
`.tsbuildinfo` files, and a stale one reports success over sources that no
longer compile — a gate that can pass on broken code is not a gate. The full
build takes about a second and a half.

## Architecture

One TypeScript repo, two server targets, one set of routes.

- **`src/server/app.ts`** — every API route, as a Hono app with no runtime
  dependencies. `src/server/index.ts` (Bun) and `src/server/worker.ts`
  (Workers) are thin entries that build it with the right storage driver.
- **Storage** — `SqlStore` writes each query exactly once over a four-method
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
Owned Read (your own timeline, your bookmark folders), $0.010 a User Read (the
identity lookup) — and the app shows the price of every action that spends:

| Action | What it costs |
|---|---|
| Fetching a conversation | $0.005 per post, estimated at ~1.5× the root's reply count and shown before you commit |
| Re-opening a cached one | free to render; the refresh it fires bills $0.005 for each reply that has arrived since, and nothing for posts already read this UTC calendar day |
| Refreshing for new replies | $0.005 per post that arrived since |
| Resuming a truncated fetch | $0.005 per older post it goes back for |
| Your posts tab | $0.001 per post (Owned Read), plus $0.005 for any thread root older than the scan window |
| Bookmark sync | $0.001 per bookmark enumerated, plus $0.005 per post hydrated |
| Connecting your X account | $0.010 once (a User Read on `/2/users/me`), then cached with the grant |

Those are estimates, not invoices. X's same-day deduplication is observed
rather than contractual, and the app deliberately over-counts in one place —
re-reading a referenced post to resolve its media is billed even when the same
post was read minutes earlier — so the estimate leans high rather than low.
X's free `/2/usage/tweets` endpoint reports daily post-consumption counts, so
it cross-checks the post counts and not the dollars; the X Developer Console
is where the bill lives, and where you should set a spending limit.

## Further reading

- [`DEPLOYING.md`](DEPLOYING.md) — the full deploy procedure, start to finish.
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

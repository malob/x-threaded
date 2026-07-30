# x-threaded

A threaded reader for X/Twitter reply trees. Paste a post URL, get the full
conversation as a navigable tree — the thing x.com's flattened reply view
can't do.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/malob/x-threaded)

Deploying your own instance is free (Cloudflare Workers + D1 free tiers, no
card required); you bring your own X API token (`wrangler secret put
X_BEARER_TOKEN`) and pay X per post you read. The deploy button activates
once this repo is public on GitHub.

Built on the X API's pay-per-use tier ($0.005/post read, deduplicated within a
24-hour UTC window). A conversation is fetched once via full-archive search on
its `conversation_id`, cached in SQLite forever, and later refreshed
incrementally.

## Stack

Single TypeScript repo: Bun + Hono server (X API proxy, SQLite cache via
`bun:sqlite`, serves the built SPA) and a React/Vite frontend.

## Running

Two interchangeable server targets share the same app code
(`src/server/app.ts`) behind an async storage interface: Bun + SQLite file,
or Cloudflare Workers + D1.

### Bun (local)

```
bun install
bun run build          # build the SPA into dist/
bun run dev:server     # start the server on :8787 (sources X_BEARER_TOKEN
                       # from ~/.claude/secrets.env, or use .env — see
                       # .env.example)
```

For frontend work with HMR, also run `bun run dev:web` (Vite on :5173,
proxying /api to :8787).

### Cloudflare Workers (local simulation or deployed)

```
bun install && bun run build
npx wrangler d1 migrations apply x-threaded --local
./scripts/dev-worker.sh          # wrangler dev on :8788, local D1
```

To deploy: `wrangler login`, `wrangler deploy` (auto-provisions the D1
database), `wrangler d1 migrations apply x-threaded --remote`, and set the
API token with `wrangler secret put X_BEARER_TOKEN`.

## Status

- [x] Milestone 1 — fetch pipeline, SQLite cache, crude tree render
- [x] Milestone 2 (display) — thread spines with inline reply stubs, run
      flattening with git-graph rails, per-block collapse, entity links,
      inline media, quote cards (nested one level), metrics row, avatars
- [x] Milestone 3 — read/unread state, refresh (`since_id`, with free
      same-day full re-reads for metrics), unread rollups, conversation inbox
- [x] Milestone 2 (navigation) — vim-idiomatic keyboard layer: cursor,
      j/k/h/l + arrows, {/} sibling branches, n/N unread traversal
      (auto-marks read), r/R read state, z-family folds, gx/yy, ? help
- [x] Deep-link routes mirroring x.com (`/<handle>/status/<id>` — swap the
      domain on any post URL) with scroll-to-focus and a fetch-consent prompt
      for uncached conversations
- [x] Milestone 4 — deployed on Cloudflare Workers + D1 (chosen over
      Fly.io: free tier, one-click deploy button, D1 auto-provisioning);
      auth gate via Cloudflare Access on the workers.dev domain

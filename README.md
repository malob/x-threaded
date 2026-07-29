# x-threaded

A threaded reader for X/Twitter reply trees. Paste a post URL, get the full
conversation as a navigable tree — the thing x.com's flattened reply view
can't do.

Built on the X API's pay-per-use tier ($0.005/post read, deduplicated within a
24-hour UTC window). A conversation is fetched once via full-archive search on
its `conversation_id`, cached in SQLite forever, and later refreshed
incrementally.

## Stack

Single TypeScript repo: Bun + Hono server (X API proxy, SQLite cache via
`bun:sqlite`, serves the built SPA) and a React/Vite frontend.

## Running

```
bun install
bun run build          # build the SPA into dist/
bun run dev:server     # start the server on :8787 (sources X_BEARER_TOKEN
                       # from ~/.claude/secrets.env, or use .env — see
                       # .env.example)
```

For frontend work with HMR, also run `bun run dev:web` (Vite on :5173,
proxying /api to :8787).

## Status

- [x] Milestone 1 — fetch pipeline, SQLite cache, crude tree render
- [ ] Milestone 2 — reading experience: single-child-run flattening, collapse,
      keyboard navigation (j/k, n/p, arrows), deep-link focus
- [ ] Milestone 3 — read/unread state, `since_id` refresh, unread rollups,
      conversation inbox
- [ ] Milestone 4 — deploy (Fly.io + volume) behind an auth gate

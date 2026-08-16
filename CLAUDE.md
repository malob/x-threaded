# x-threaded

A threaded reader for X/Twitter reply trees. One TypeScript repo, two server
targets (Bun locally, Cloudflare Workers deployed), one set of routes. The
README's Architecture section is the map; this file is the things that will
bite you.

[`CONTRIBUTING.md`](CONTRIBUTING.md) carries the rest of what this file would
otherwise repeat: the invariants reviews keep returning to, two traps that fail
silently, the behaviours that look like bugs and are deliberate, and the known
gaps a code comment means when it says "Known gaps".

**Deploying, or setting someone up from scratch? Follow
[`DEPLOYING.md`](DEPLOYING.md) start to finish.** Don't improvise the order —
step 4 exists because a deployed Worker with no gate lets anyone spend the
owner's money, and the first-deploy sequence in step 3 exists because D1 isn't
provisioned until the first `wrangler deploy`.

## Gates

Run all of these before calling anything done:

```bash
bun run lint && bun run typecheck && bun test && bun run test:d1 && bun run build
```

`typecheck` is `tsc -b --force` on purpose. Incremental `tsc -b` trusts the
`.tsbuildinfo` files, and a stale one reports success over sources that no
longer compile — this was demonstrated, not theorised. Never "optimise" it
back. `test:d1` runs the storage contract against a real workerd D1 binding
and is slow, which is why it's out of the default `bun test` run; it is not
optional, because the local Bun driver is permissive about things D1 rejects
(the >100 bound parameters limit, most of all).

## Money is the invariant

The app spends real money per X API call — about $0.005 a post read. Two rules
follow, and much of this codebase's review history is about them:

- **Every `XApi` method returns its value with a cost receipt attached**
  (`Billed<T>`, see `src/server/xapi.ts` and `meter.ts`). A path that spends
  without reporting has to be written to look wrong. Keep it that way.
- **Config that caps spending fails closed.** A malformed `MAX_POSTS_PER_FETCH`
  refuses to boot rather than silently uncapping; a deployment with no gate
  refuses to serve rather than silently opening. Preserve that direction when
  touching `config.ts` or `access.ts`.

## Things that follow a fork

`wrangler.jsonc` is committed, so **nothing per-deployment goes in it** — no
`database_id`, no client id, no Access AUD. Those are secrets set on each
Worker (`wrangler secret put`), documented in `.env.example`. A pinned
`database_id` in particular would aim a stranger's Worker at ours.

Apply D1 migrations *before* deploying a Worker that needs new columns.
`migrations/` is the only source of schema.

## Before changing anything that talks to X

Read [`docs/x-api-notes.md`](docs/x-api-notes.md) first. It records what this
app has *measured* about the X API, including several behaviours X's own docs
contradict — billing units, undocumented deduplication, the 30-day default
search window, app-only-vs-user-context on each endpoint. Entries are labelled
Measured or Recorded so you can tell evidence from documentation.

## The design corpus

[`docs/design/`](docs/design/README.md) is the design record for the thread
view — the "avatar graph". It documents shipped behaviour and is worth reading
before touching `styles.css`, `Thread.tsx`, or `PostView.tsx`. One rule from
its own trust order: **where those documents disagree with `src/web` on paint
numbers, the app is the truth.** The mockups trail the implementation.

[`docs/history/`](docs/history/README.md) is archived material about superseded
versions of the code. Don't take its `file:line` references as current.

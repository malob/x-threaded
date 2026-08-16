# x-threaded

A threaded reader for X/Twitter reply trees. One TypeScript repo, two server
targets (Bun locally, Cloudflare Workers deployed), one set of routes.

This file is short on purpose — it loads into every session, so it holds only
pointers and the handful of things that are specific to working here.

## Read first, by task

| Doing what | Read |
|---|---|
| Anything that changes code | [`CONTRIBUTING.md`](CONTRIBUTING.md) — the gates, the invariants, two silent failure modes, and the behaviours that look like bugs and aren't |
| Deploying, or setting someone up | [`DEPLOYING.md`](DEPLOYING.md), start to finish |
| Touching anything that calls X | [`docs/x-api-notes.md`](docs/x-api-notes.md) — measured behaviour, some of it contradicting X's own docs |
| Touching the thread view | [`docs/design/`](docs/design/README.md) — where it disagrees with `src/web` on paint numbers, the app is the truth |
| Orienting on the architecture | the README's Architecture section |

[`docs/history/`](docs/history/README.md) is archived material about superseded
versions of the code. Don't take its `file:line` references as current.

## Specific to this repo

**Run the gates before calling anything done** — all five, listed in
CONTRIBUTING.md. `bun test` alone is not enough: `test:d1` is the leg that
catches what D1 rejects and `bun:sqlite` accepts.

**Don't improvise the deploy order.** DEPLOYING.md step 4 exists because a
deployed Worker with no gate lets anyone spend the owner's money, and the
first-deploy sequence in step 3 exists because D1 isn't provisioned until the
first `wrangler deploy`.

**The money invariant is the one to hold on to.** Every `XApi` method returns
its value with a cost receipt attached, and config that caps spending fails
closed rather than degrading. CONTRIBUTING.md has the detail; the thing to
remember here is that a change which quietly loosens either is wrong even when
it looks tidier.

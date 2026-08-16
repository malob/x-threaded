# Deploying x-threaded

There is no hosted instance. You run your own, against your own X API
credentials, and you pay X for the posts you read. This document is the whole
procedure — local first, then Cloudflare.

> Using Claude Code? Just ask it to deploy this and point it here. The steps
> below are written to be followed literally, in order, including the
> verification at the end of each one. Two things it should not decide on your
> behalf: spending money against your X account, and step 4.

## 1. Before you start

**An X developer account with pay-per-use billing.** This is the real
prerequisite, and the free tier will not work — reading a conversation uses
full-archive search, which the free tier can't call at all. Sign up at
[developer.x.com](https://developer.x.com), enable pay-per-use, and **set a
spending limit in the developer console before you load anything.**

Budget roughly $0.005 per post read, so a typical conversation costs $0.25 to
$2.50 to load the first time. It's cached after that and re-reading is free.
The app prices every action that spends before you click it, and the README's
Costs section breaks down each one.

**Bun.** `curl -fsSL https://bun.sh/install | bash`, or your package manager.

**A Cloudflare account**, only if you want it deployed. The free tier is
enough and takes no card.

## 2. Run it locally

Worth doing even if you plan to deploy — it's three minutes and it proves your
X token works before Cloudflare is in the picture.

```bash
bun install && bun run build
cp .env.example .env
```

Put your app-only Bearer Token in `.env` as `X_BEARER_TOKEN`, then:

```bash
bun run dev:server
```

**Verify:** open <http://localhost:8788>, paste any x.com post URL, and
confirm the tree renders. That's the whole app — everything below is about
reaching it from somewhere other than your laptop.

Local runs are never gated (see step 4) and use a SQLite file under `data/`
rather than D1.

## 3. Deploy to Cloudflare

Two ways in. Both leave you at the same place: a Worker that is deployed but
**refuses to serve its API until step 4**.

### The button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/malob/x-threaded)

Clones the repo into your own GitHub, provisions a D1 database, asks for
`X_BEARER_TOKEN` (and the OAuth pair, which you can leave blank), then builds
and deploys — applying migrations on the way, via this repo's `deploy` script.
It also wires up Workers Builds, so later pushes to your copy redeploy
automatically.

### By hand

```bash
bunx wrangler login
bunx wrangler deploy              # creates the Worker, provisions D1
bun run db:migrate:remote         # only now does the database exist
bunx wrangler secret put X_BEARER_TOKEN
```

The order matters on a first deploy and only on a first deploy: `wrangler
deploy` is what provisions the D1 database, so migrations can't run before it.
Afterwards `bun run deploy` does both in the right order, and that's the
command to use from then on.

`scripts/push-secrets.sh` pushes every credential-shaped value from your local
`.env` in one go, skipping any that aren't set, if you'd rather not run
`secret put` repeatedly.

**Verify:** `curl https://<your-worker>.workers.dev/api/saved` should answer
403 with a message about having no gate. That's step 4 talking, and it means
everything up to here worked.

## 4. Put a gate in front of it

**Do this before you use the deployment, and before you give anyone the URL.**

A deployed Worker holding a working X token is a way for anyone who finds the
URL to spend your money. The app refuses to serve `/api/*` until you've either
put a gate in front of it or explicitly said you don't want one.

The free option is Cloudflare Access, in the Zero Trust dashboard:

1. **Access → Applications → Add an application → Self-hosted.** Point it at
   your Worker's hostname.
2. Add a policy. *Allow* + an include rule of `Emails` with your own address is
   the simplest thing that works; `Cloudflare account members` also works if
   you'd rather not enumerate addresses.
3. Save, and copy the **AUD tag** and your **team domain** out of the modal —
   `https://<your-team>.cloudflareaccess.com`. Team domains are unique across
   all of Cloudflare, so you may need a less obvious name than you'd like.

```bash
bunx wrangler secret put POLICY_AUD
bunx wrangler secret put TEAM_DOMAIN
```

Setting both makes the Worker verify Access's JWT on every request itself, so
the API still fails closed if Access is ever switched off at the dashboard —
the gate isn't the only thing holding the door.

**Verify:** load the Worker URL in a private window. You should be redirected
to a Cloudflare login page, and the app should work after you sign in.

If you genuinely want no gate — you're the only one who knows the URL, and you
accept that this is not a security boundary — set `ALLOW_UNGATED` to exactly
`true` instead. It's deliberately awkward to say.

## 5. Optional: connect your X account

Everything so far reads public conversations. Connecting an X account adds the
**Your posts** tab and **bookmark folder sync**, and drops the price of your
own data from $0.005 to $0.001 a read.

1. On your X app, set *Type of App* to **confidential client** and register
   `https://<your-worker>/auth/callback` as a callback URL.
2. `bunx wrangler secret put X_OAUTH_CLIENT_ID` and
   `bunx wrangler secret put X_OAUTH_CLIENT_SECRET`. Read the secret with the
   portal's *Show* button — regenerating it revokes any grant you already have.
3. Visit `https://<your-worker>/auth/login` once and approve. Costs $0.010,
   one time.

**Give each deployment its own X app.** A developer account allows three. X
keeps at most one live grant per user per client id, so authorizing a second
deployment through the same app silently revokes the first one's tokens —
your production instance logs itself out the next time you run local dev.
Never copy tokens between deployments either: refresh tokens are single-use
and rotate, so two holders of one chain invalidate each other. The evidence
for both rules is in [`docs/x-api-notes.md`](docs/x-api-notes.md), N14 and N15.

## Troubleshooting

> **403, "this deployment has no gate in front of it"**

Working as intended — step 4.

> **500, "X_BEARER_TOKEN secret is not set"**

`bunx wrangler secret put X_BEARER_TOKEN`. Secrets survive deploys, so this is
a one-time thing per deployment.

> **"no such table" or a D1 error on first load**

Migrations didn't run: `bun run db:migrate:remote`.

> **The app loads but says your session expired**

Cloudflare Access answers a lapsed session with its login page rather than a
401. Reload and sign in again.

> **`wrangler deploy` hangs for minutes**

Intermittent. Kill it and retry once before looking for a real cause.

> **`wrangler dev --remote` can't reach the deployment**

It proxies through your real hostname, which is behind Access, so it would
need an Access service token — a standing bypass credential. Use
`./scripts/dev-worker.sh` for local Worker development instead.

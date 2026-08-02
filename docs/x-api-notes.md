# X API notes

What this app has learned about X the platform, as opposed to about its own
code. Each entry says what was seen, when, and where X's own docs disagree —
because several of these contradict the documentation, and one of them (N3)
has already flipped once inside this repo on the strength of a confident
comment nobody had re-measured.

The rule that keeps this page and the code from drifting apart: **if the
knowledge is about one line of ours, it is a comment; if it is about X, it is
an entry here** and the comment points at it. A fact stated in five places is
one refactor from contradicting itself in four.

Everything here was seen against the pay-per-use tier. Two labels, and the
difference matters when you are deciding whether to trust an entry or re-run
it:

- **`Measured <date>`** — a probe was run and its numbers survive, in this
  file or in the code it explains.
- **`Recorded <date>`** — the behaviour was observed and the app was built
  around it by that date, but the probe itself wasn't written down. Believe
  it; re-measure before inverting it.

Nothing here is a promise from X. Treat every entry as "true the last time
someone looked," and when you look again, add the date.

---

## Billing

### N1. Post reads bill $0.005; own-timeline and bookmark reads bill $0.001

*Rates published by X — <https://docs.x.com/x-api/getting-started/pricing>.*

Two units, and the endpoint decides which applies. Lookups
(`/2/tweets/:id`, `/2/tweets?ids=`) and full-archive search bill at the post
rate. Reading the signed-in user's own material — `/2/users/:id/tweets`,
bookmark folder pages — bills as an **Owned Read** at a fifth of that. The
rates live in `src/shared/pricing.ts`; the mapping from endpoint to unit lives
in `src/server/xapi.ts`, which is the only layer that knows it.

A lookup of a post that happens to be the user's own is still a post read: the
cheaper rate is a property of the endpoint, not of the author. `groupOwnThreads`
buys roots that fell outside the timeline scan this way, and pays $0.005 for
them.

### N2. Same-UTC-calendar-day dedup is OBSERVED, not contractual

**Recorded 2026-07-30.** A post read twice within one UTC calendar day was
billed once; the same two reads either side of 00:00Z billed twice. The
boundary is the **calendar day**, not a rolling 24-hour window — this repo
said "24-hour window" in several places where the code implemented a calendar
day, and the two answer differently for a read at 23:59Z.

X documents the dedup as soft. It is not a rate the app can hold them to, and
no endpoint will confirm a charge before the fact. So **every cost this app
shows is an estimate**, on both sides of the ledger: `SpendMeter` charges what
each response returned and credits back the posts the store says were already
read today (`postIdsReadToday`). The free `/2/usage/tweets` endpoint is the
only thing that knows what X actually billed, and reconciling against it is
the honest way to find out whether a discrepancy is our bug or their policy
moving.

Consequences that are load-bearing elsewhere:

- A full re-read of a conversation on the same UTC calendar day as its last
  *full* read is free and refreshes metrics — hence `conversations.full_read_at`
  exists separately from `fetched_at` (migration 0006). A `since_id` refresh
  reads a handful of new posts and must not be allowed to claim a full read
  was paid for.
- Re-scanning the own-posts timeline for a larger thread target is nearly
  free for the ground already covered.
- Folder pages enumerate rather than return posts, so whether hydrating an id
  the folder page just listed dedups against it is exactly the soft part of
  the rule. `getBookmarksByFolder` counts both; that is the estimate that
  cannot understate the bill.

### N3. `exclude=replies` keeps the user's own thread continuations

**Measured 2026-07-30, and this repo has believed the opposite.**

Of 49 posts returned from `/2/users/:id/tweets` with
`exclude=replies,retweets`, 23 were replies, and 22 of those continued a
thread whose root was also in the page. So the parameter drops replies *into
other people's* conversations while keeping self-replies — exactly what thread
grouping needs, and it avoids paying to read every reply the user ever made
under someone else's post.

The flip-flop, because a third flip is otherwise likely:

| When | What the repo asserted |
|---|---|
| 2026-07-29 (`be6ac00`) | "exclude=replies also drops the user's own thread continuations, which callers need" — so the code sent `exclude=retweets` only. Confidently worded; never measured. |
| 2026-07-30 (`38ce59c`) | Measured the 49/23/22 split above and inverted the claim; the code now sends `exclude=replies,retweets`. |

X's documentation still describes `exclude=replies` as removing replies,
without carving out self-replies. **Docs and measurement disagree, and this
app follows the measurement.** If someone "fixes" this back, they will pay
about twice as much per timeline page for posts thread grouping then discards.
Re-measure before flipping it a third time, and add a row to this table.

### N4. `reply_count` undercounts the replies a conversation actually contains

**Measured 2026-07-30** across this deployment's cached conversations: the
true post count ran **1.2–1.9×** the root's `reply_count` (mean ≈1.5).
`reply_count` counts direct replies only, so nested discussion is invisible
to it.

`estimatePostCount` in `src/shared/pricing.ts` applies the 1.5 multiplier so
the inbox can price a fetch before the user commits to it. The exact answer is
`/2/tweets/counts/*`, which costs a post read per conversation — too much to
spend rendering a list of cards nobody may click.

---

## Endpoints

### N5. `conversation_id` search works with the app-only bearer ONLY

**Recorded 2026-07-30.** `/2/tweets/search/all` with
`query=conversation_id:<id>` returns results under the app-only bearer token
and is **rejected under a user-context OAuth 2.0 access token**. Full-archive
search is an app-only endpoint on this tier.

This is why `XApi.get()` takes an optional token override instead of the class
holding one token: `searchConversationPage` deliberately does not pass one and
falls through to the app-only bearer, while `getOwnPosts`, `getMe` and the
bookmark endpoints must pass the user token. A maintainer "simplifying" the
class down to a single token breaks conversation fetching, which is the
app's entire reason to exist.

### N6. `/2/tweets/search/all` silently defaults to a 30-day window

**Recorded 2026-07-30.** Without `start_time`, a `conversation_id` search
returns only the last ~30 days. An older conversation comes back missing its
history with **no error and no truncation flag** — the single most dangerous
default on this endpoint, because a partial answer is indistinguishable from a
complete one.

`conversationStartTime()` therefore dates the conversation from its root's
snowflake ID and opens the window an hour before it (the margin absorbs slop
between a snowflake's encoded time and X's indexing time). `start_time` wants
RFC3339 at *second* precision; `toISOString()`'s milliseconds are outside the
documented grammar.

`since_id` and `start_time` cannot both apply — `since_id` already bounds the
range.

### N7. Full-archive search paces at roughly 1 request/second

**Recorded 2026-07-30.** Paging faster than about 1 req/s on this tier draws
429s. `PAGE_DELAY_MS = 1100` in `src/server/xapi.ts` is that limit with a
little headroom, and the sleep lives inside `searchConversationPage` rather
than in any caller's loop, so every walker of the endpoint owes X the same
gap whether or not it remembered to.

Retry policy for 429s and 5xx: **exactly one** retry, waiting on
`x-rate-limit-reset` when X sends it (5s default for a 429, 2s for a 5xx),
capped at 60s. One retry, because a request that fails twice is a condition
that will not clear inside a user's page load; capped, because a request must
not outlive the runtime's limit while holding a spend meter open.

### N8. Bookmark folder endpoints accept no field or expansion parameters

**Recorded 2026-07-30.** `/2/users/:id/bookmarks/folders/:folder_id` accepts
only `id`, `folder_id`, `max_results` and `pagination_token`. Sending
`tweet.fields`, `expansions`, `user.fields` or `media.fields` does not enrich
the response. What comes back is bare id stubs.

So the sync is two-phase: enumerate ids from the folder (Owned Reads), then
hydrate them through `/2/tweets?ids=` (post reads). The identity of what is
bookmarked comes from the enumerated ids, never the hydrated posts —
hydration drops posts whose author went private or which were deleted, and
those are still bookmarks, not removals.

Folder *listing* (`/2/users/:id/bookmarks/folders`) returns folders, which are
not posts, and bills nothing.

### N9. Quoted posts inside search `includes` arrive without media objects

**Recorded 2026-07-30.** `/2/tweets/search/all` attaches `media` only to the
main results. A post that appears in `includes.tweets` — a quoted post, a
recovered parent — carries its `attachments.media_keys` but no matching entry
in `includes.media`, so its images cannot be resolved from that response.

Resolving them means looking the post up again, which is a second response and
a second charge. `ConversationPage.unresolvedMediaIds` names them and lets the
caller decide whether the pictures are worth another read.

### N10. `note_tweet` holds the full text; `text` is a truncated preview

**Recorded 2026-07-30.** For posts past 280 characters, the `text` field is a
preview and `note_tweet.text` is the whole thing. The same split applies to
entities: `note_tweet.entities.urls` covers the full text, `entities.urls`
only the preview, so reading URLs from the wrong one silently loses links that
appear past the cut. `toPost()` prefers `note_tweet` for both.

### N11. API text is HTML-escaped; x.com renders it unescaped

**Recorded 2026-07-30.** The v2 API escapes `&`, `<` and `>` in post text
(`&amp;`, `&lt;`, `&gt;`). x.com shows the unescaped characters, so rendering
the API's text verbatim produces visible entity references the author never
typed. `unescapeText()` reverses exactly those three, in that order — `&amp;`
last, so an escaped `&amp;lt;` does not decode twice.

### N12. Partial failures ride an `errors[]` array, not the HTTP status

**Recorded 2026-07-30.** A lookup for 100 ids where 3 are deleted returns
**HTTP 200** with 97 posts in `data` and 3 entries in `errors[]`. Ignoring
`errors[]` turns "X refused to give us this" into "this does not exist,"
which is how a live bookmark gets deleted from the saved queue.

The entries are OpenAPI Problem variants and their shape varies: the id is in
`resource_id` on some variants and `value` on others, and the human-readable
reason is `title` (with `detail` as the fallback). `getPostsByIds` attributes
reasons by id and reports anything it could not explain as missing anyway —
absence from `data` is the backstop, because a variant we have not seen must
not read as success.

---

## OAuth and grants

### N13. Portal-minted tokens carry a fixed scope set that lacks `bookmark.read`

**Recorded 2026-07-30.** Access tokens generated in the X developer portal come
with a fixed scope set that does not include `bookmark.read`, and there is no
way to widen it there. The bookmark-folder inbox therefore requires going
through the interactive consent flow at `/auth/login`, which asks for
`tweet.read users.read bookmark.read offline.access` (`SCOPES` in
`src/server/oauth.ts`).

This is why the app has an OAuth flow at all rather than a pair of pasted
token secrets. An earlier version of this repo accepted seed tokens from the
environment; that pathway is gone, and its removal is why `.env.example` lists
no token variables beyond the app-only bearer.

### N14. Refresh tokens rotate on every use and are single-use

**Recorded 2026-07-30**, and consistent with what X documents. Each successful
refresh returns a **new** refresh token and kills the one that was presented.
The consequences the code is built around:

- The rotated pair must be persisted **before** it is used; a rotation lost
  between the wire and the database bricks the grant.
- A refresh must **never** be retried. Re-presenting a token that may already
  have been spent is the one thing the whole lease protocol in
  `src/server/oauth.ts` exists to prevent — hence a hard timeout with no
  retry, and a single one-shot recovery attempt per grant.
- "We got an HTTP response" is not proof the token went unspent. Only a
  definite 4xx (excluding 429) proves X evaluated and refused before issuing
  anything; a 5xx or a 429 can come from a gateway *after* the exchange was
  processed.
- Two processes must never share one token chain. Local dev and production
  each authorize themselves and hold their own.

### N15. X issues no concurrent grants per (user, client) — re-auth revokes the previous one

**Proven 2026-07-30.** Authorizing a second deployment through the same X app,
as the same user, **silently revoked the first deployment's unexpired tokens**.
No notification, no error at the time; the first deployment simply started
failing its next refresh with `invalid_grant`.

X keeps at most one live grant per (user, client id) pair. Registering both
callback URLs on one app — which the app's settings happily allow — makes the
two deployments look like one client to X, so `/auth/login` on either one
evicts the other.

**Therefore: one X app per deployment.** A developer account allows 3 apps, so
a local, a staging and a production deployment each get their own client id
and client secret, and their grants stop competing. This is the failure a
future maintainer will actually hit, and the symptom (a production deployment
that logs out whenever someone runs the local one) points nowhere near its
cause.

---

## Reconciling

X's own free endpoint `/2/usage/tweets` reports what the project actually
consumed. It is the check on everything under "Billing" above: if the app's
estimate and X's meter diverge, the estimate's assumptions — N2's dedup most
of all — are what to re-measure, and the result belongs in this file with a
new date.

1. **Q1 — Confirm with three corrections: bind the claim to the observed token, identify the owner, and never automatically reclaim an expired in-flight lease.**  
   Use an atomic claim conditioned on `state='ready'`, `refresh_token=:observed`, and token expiry; set `state='refreshing'`, a random `lease_id`, and `lease_until`. Final replacement must match both `refresh_token=:observed` and `lease_id=:mine`. Otherwise a stale reader can acquire a later lease and present an already-consumed token. Thirty seconds is reasonable only if the refresh fetch has a shorter hard timeout and no automatic retry. Losers wait briefly and reread; a changed token means success. An expired `refreshing` lease is `uncertain/broken`, not reclaimable: the holder may have exchanged successfully before crashing. This is conservative but appropriate for single-use credentials. The current unconditional exchange/write at [`oauth.ts:185-186`](/Users/malo/Code/x-threaded/src/server/oauth.ts:185) becomes the conditional finalize. No Durable Object is warranted.

2. **Q2 — The installed local workerd path does not faithfully enforce D1’s 100-parameter service limit; the deployed probe is required.**  
   Code inspection is decisive enough here: Miniflare passes the complete parameter array straight to workerd’s SQLite-backed storage without a 100-parameter check at [`database.worker.js:154`](/Users/malo/Code/x-threaded/node_modules/miniflare/dist/src/workers/d1/database.worker.js:154), and the installed workerd binary reports `MAX_VARIABLE_NUMBER=32766`. The locked stack is Miniflare/workerd 2026-07-22 at [`bun.lock:327-379`](/Users/malo/Code/x-threaded/bun.lock:327). Cloudflare says local D1 uses the production runtime, but the documented 100 limit is evidently a service policy not reproduced by this local adapter: [local D1 development](https://developers.cloudflare.com/d1/best-practices/local-development/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

   Therefore:

   - Stage 0 gates on unit tests using a driver/fake that rejects statements over `maxParams`, including the fixed date parameter in `postIdsReadToday`.
   - Run the deployed 101/150-ID probe with `read:false` only; `read:true` would insert fake `read_state` rows.
   - Keep the Stage 2 local-workerd suite required for D1 API shapes, transactions, batches, and migrations—but do not claim it verifies C1.
   - A remote staging-D1 test could replace the one-time probe later, but is unnecessary machinery now.

3. **Q3 — Demote two items and simplify a third; add the temporary lifecycle hotfix.**  
   Demote the content-type client check to 4a and stale `autoRefresh` protection to the TanStack Query work in Stage 6; neither is a spend/data-integrity emergency, and testing the latter properly would expand Stage 0. Keep eliminating `getMe` per mount, but do not add profile persistence/schema work yet: `/api/auth/status` should read token state only and omit its optional `user` field—the UI already guards that at [`Inbox.tsx:301`](/Users/malo/Code/x-threaded/src/web/Inbox.tsx:301). Persist a full profile with the Stage 3 token model.

   Add one small urgent fix: move `upsertConversation` after successful `ingest` for now. That closes the general poisoned-cache path, not merely the D1 instance, until 5b replaces it with explicit `incomplete → complete` lifecycle state.

   The two-day 0B set should therefore be:

   1. D1 chunking, limit-fake tests, deployed `read:false` probe.
   2. Bounded parsing plus strict page budgeting.
   3. Historical `start_time`.
   4. Cache-first conversation resolution.
   5. Fail-closed incomplete bookmark reconciliation.
   6. OAuth metadata preservation plus in-isolate single-flight.
   7. Store-only auth status—no refresh or `getMe`.
   8. Temporary conversation-row-last ingest.

   One strict-budget edge: full-archive `max_results` is 10–500. If fewer than ten budgeted reads remain, stop under budget and mark incomplete; do not request ten and overspend. [X documents that minimum here](https://docs.x.com/x-api/posts/search/quickstart/full-archive-search).

4. **Q4 — Yes, the architecture is converged; I would make four roadmap edits, none of which blocks proceeding.**

   - Split Stage 2 internally into **2a driver/one store/bulk contracts** and **2b migration ledger/baselining/schema-source retirement**. They are separate failure domains and should each ship green.
   - Move the `AuthStatus` discriminated union into Stage 3 because `ready | refreshing | broken` is part of the token-manager contract. Do not retain a generic 4b “type redesign” stage: land `PostNode | GapNode` with ThreadModel in Stage 6; defer branded IDs unless an actual ID-mixup risk justifies the cross-repository churn.
   - Split Stage 6 into **6a TanStack Query/server-state correctness**, **6b ThreadModel + keyboard reducer**, and **6c context/memo/StrictMode/error boundary**. Enable the React-hooks lint rule before 6a, not afterward, because the web refactor is exactly when it provides leverage.
   - Keep tsconfig references and broader documentation polish in Stage 7.

   Receipts before conversation lifecycle is correct; lifecycle before bookmark reconciliation is correct; durable OAuth immediately after the storage seam is correct. The only newly established platform fact is that local workerd cannot serve as the 100-parameter proof. With the deployed probe and the Stage 0 scope adjustment above, I consider the plan converged.

Codex session ID: 019fb4c3-906b-7863-9bc5-9c80bbaeac4c
Resume in Codex: codex resume 019fb4c3-906b-7863-9bc5-9c80bbaeac4c

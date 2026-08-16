# Stabilization Plan

Status: stabilization implementation and verification complete; awaiting product decisions
Baseline: `1b4783c3f24dc150d9dbe6494def81142e35a877`
Branch: `codex/stabilization`

## Goal

Make the existing feature set safe and dependable before adding features. Preserve the current product shape; prefer regression tests and small ownership fixes over rewrites.

## Operating constraints

- Protect local data before persistence tests. The real-D1 contract test must be isolated before it runs again.
- Prefer deterministic fake X responses. The user authorized live read-only X validation when it materially improves confidence, with a working ceiling of about `$1` total before checking again; no live X request was needed during this stabilization.
- Do not post to X, deploy Workers, migrate or inspect production databases, change live Cloudflare resources, or perform destructive external actions without explicit user approval.
- Write a failing regression test before fixing an inferred race or platform edge.
- Keep changes behavior-preserving unless a decision is listed under **User decisions**.
- Run focused checks after each change and the full gate set at phase boundaries.

## Confidence ledger

### Confirmed or directly reproduced

- **Closed, Phase 0:** the D1 contract test used normal `.wrangler/state` and deleted application tables.
- **Closed, Phase 1:** the Bun entrypoint listened on all interfaces unless a hostname was explicit.
- **Closed, Phase 1:** an error-only bookmark-folder response could be treated as a complete empty scan and remove saved items.
- `MAX_POSTS_PER_FETCH` intentionally caps main search results, not every billed post read; current docs name the exceptions.
- **Closed, Phase 2:** an older conversation run could restore stale lifecycle metadata over a newer run.
- **Closed, Phase 2:** OAuth token/profile resolution could combine two different grants or continue with a stale account after losing its profile CAS.
- **Closed, Phase 2:** concurrent first-use requests in separate Worker isolates could both pay to resolve the same OAuth profile.
- **Closed, Phase 2:** concurrent bookmark scans in separate tabs or Worker isolates could both spend before one stale result was rejected.
- **Closed, Phase 2:** a paid quote lookup or bookmark scan that lost an expired lease could persist its stale response after a recovery run.
- **Closed, Phase 2:** stale or out-of-order client responses could restore read state, and a timeless mark-all overlay could consume posts delivered by a later response.
- **Closed, Phase 2:** root-unknown client loads could bypass the resolved conversation's response ordering or turn a successful paid load into a free-reconciliation failure.
- **Closed, Phase 2:** either ordering of separate lifecycle/post reads could combine a status with the wrong post snapshot during partial/complete transitions; responses now use one SQL snapshot.
- **Closed, Phase 3:** unique-author ancestor context made `buildThread` quadratic at the configured 5,000-post cap.
- **Closed, Phase 1:** secret upload failures could be reported as success, and manual deploy could use stale assets.
- **Closed, Phase 1:** `.env` could replace the secret uploader's internal allowlist and cause an excluded value to be uploaded.
- Browser rendering has a local smoke check; assistive-technology and visual-regression behavior remain outside executable coverage.

### Confirmed operating limit

- **Documented, not changed:** a full 5,000-main-result run exceeds D1 Free's 50-query invocation budget even with set-based page writes.
- **Documented, not changed:** simultaneous requests for the same entirely unseen post can each buy its initial `$0.005` lookup; after the root resolves, the durable conversation lease stops every loser before search.

### Unresolved or product-dependent

- Whether to expand the current main-search-result cap into an enrichment or USD ceiling.
- Whether disconnected paid work should cancel or finish and cache.
- Whether cached opens and remembered inbox tabs should automatically spend.
- Visual treatment for accessible contrast and the keyboard-operable inbox-card affordance.
- OAuth abandoned-lease recovery policy.
- Whether a fresh login or clearing the selected folder should clear or preserve the prior account/folder's bookmark choice and bookmark-sourced queue.
- Applicability of X's multiple-app policy to independent personal forks.
- Whether any external database exists from an intermediate folded-migration version.

## Execution phases

### Phase 0 — Safe baseline

- [x] Make the real-D1 contract test hermetic and prove normal `.wrangler/state` is unchanged.
- [x] Correct the gate documentation about workerd versus the 100-parameter service limit.
- [x] Add Worker bundle/config dry-run coverage without deploying.
- [x] Record focused regression tests for confirmed safety findings.

### Phase 1 — Safety and money

- [x] Bind the Bun server to loopback by default, disable the documented idle reset, and execute a real loopback entrypoint probe.
- [x] Replace per-row D1 write patterns with bounded set-based operations and test page-scale query counts.
- [x] Treat bookmark enumeration errors as incomplete and prohibit destructive reconciliation.
- [x] Truthfully document the existing main-search-result cap and every known billed-read exception without changing product behavior.
- [x] Make secret/deploy helpers fail honestly, remain portable, and build current assets.

### Phase 2 — Async ownership

- [x] Add conversation run generation/renewable lease/CAS ownership.
- [x] Make OAuth token and profile resolution use one coherent grant snapshot.
- [x] Serialize and generation-bind bookmark sync, post persistence, and folder selection.
- [x] Establish per-root frontend response sequencing and ordered optimistic read overlays.

### Phase 3 — Frontend scale and accessibility

- [x] Replace ancestor-set cloning with DFS push/pop context and adversarial max-cap tests.
- [x] Separate settings loading/error/empty states and surface returned cost receipts.
- [x] Add control names, tab semantics, and error/status live regions without visual changes.
- [ ] Decide the keyboard-operable inbox-card affordance and visible contrast treatment.
- [x] Clear pending key prefixes on pointer/native target changes.
- [x] Track media failure in React state keyed by media identity and source.
- [ ] Expand the local browser smoke check into component, assistive-technology, and visual-regression coverage.

### Phase 4 — Documentation and factoring

- [x] Reconcile billing, deployment, access, prerequisite, and support-link documentation with behavior.
- [ ] Resolve user decisions before changing spend/disconnect/public-distribution semantics.
- [ ] Split route/controller responsibilities only after behavioral coverage exists.
- [ ] Inventory links before moving historical design material.
- [x] Run the final lint, typecheck, unit, isolated D1, production build, Worker dry-run, browser, and diff checks.

## User decisions

Check in only when work reaches one of these boundaries:

1. Any future spend-cap change: all billed reads, a USD ceiling, or keep the current main-search-result cap.
2. Disconnect behavior: cancel paid work or finish and cache it.
3. Automatic spending on cached opens and remembered inbox state.
4. Visible accessibility treatment and inbox-card interaction design.
5. OAuth recovery allowance semantics.
6. Public self-deployment posture and X policy risk.
7. Any production deployment, live migration, or external data inspection.
8. Whether reconnecting a different X account or selecting no bookmark folder clears the existing bookmark-folder choice and bookmark-sourced queue.

## Verification record

- Baseline audit: lint passed; five TypeScript projects passed; 508 tests and 1,895 assertions passed; Vite production build passed; Wrangler dry-run passed.
- Real X was not contacted during the audit.
- Local Bun SQLite data remained intact. The pre-fix real-D1 gate cleared normal local Worker D1 state; Phase 0 has now isolated that gate from normal state.
- Earlier hermetic workerd D1 checkpoint: 84 tests and 141 assertions passed; the normal `.wrangler/state` 9-file, 278,688-byte fingerprint was identical before and after.
- Earlier stabilization checkpoint: lint passed; all forced TypeScript projects passed; 515 tests and 1,910 assertions passed.
- Page-scale D1 regressions now hold ordinary 100-item post, credit, read-state, saved-item, and cached-quote operations to one query each.
- The 5,000-node unique-handle thread probe fell from roughly 1.43 GB maximum RSS to roughly 66 MB.
- Factual-doc pass: 80 focused money/lifecycle tests and 210 assertions passed; lint and forced multi-project typechecking passed.
- Bookmark ownership regressions cover cross-tab overlap, expiry recovery, folder replacement, stale post snapshots, fresh OAuth grants, retry fencing, and safe request/database budgets. A maximal no-retry route uses 28 D1 statements with a cached profile or 31 while resolving the first profile; the adversarial seventh-pass profile recovery path reserves exactly enough room to stay at or below D1 Free's 50-query limit.
- OAuth profile resolution is single-flight across independent Worker instances; losing callers make no X request, and expired owners are recoverable.
- Final unit/integration gate: 638 tests and 2,491 assertions passed across 21 files.
- Final hermetic workerd/D1 gate: 103 tests and 239 assertions passed, including the 1,000-post bookmark transaction; its normal-state fingerprint check passed.
- Final lint, forced multi-project typecheck, Vite production build, Worker deploy dry-run, and `git diff --check` all passed.
- A real Bun entrypoint probe bound only to `127.0.0.1`, served the empty saved queue, and shut down cleanly.
- The built app passed a local browser smoke check for Saved/Your Posts navigation and the OAuth-disabled state with no browser warnings or errors.
- Two orphaned Bun test processes from the review were detected after the user reported high CPU, terminated explicitly, and followed by a clean Bun/Workerd/Wrangler process check after the final gates.

Retain this record until the account-switch and other listed product decisions are resolved; after that, it can be reduced to a short durable stabilization record.

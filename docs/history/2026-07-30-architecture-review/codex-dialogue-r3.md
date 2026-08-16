1. **Verdicts**

   **Point 1 — Accept one automatic recovery attempt, but not the claim that it is strictly risk-free.** Your case analysis omits an ambiguous third case: the original exchange reached X, but the holder timed out, paused, or was delayed before durable finalize. A retry can race with late X-side processing or displace an owner that could still finalize. OAuth BCP says replay detection may revoke the active successor token; X’s own documentation does not specify its replay/revocation scope. [RFC 9700 §4.14](https://datatracker.ietf.org/doc/html/rfc9700#section-4.14), [X refresh-token documentation](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code).

   Nevertheless, one recovery attempt is the right practical policy if:

   - The original owner may finalize during a short post-expiry grace period.
   - Recovery begins only after that grace, using an atomic claim bound to the unchanged observed token.
   - A persistent `recovery_used` flag prevents a second recovery after another crash.
   - Finalize remains bound to `lease_id` and observed token.
   - Any `invalid_grant` or ambiguous recovery outcome becomes `broken`.

   That preserves the useful case-(a) recovery while bounding the uncertain replay risk.

   **Point 2 — Agree completely.** Centralize `parsePostId` and URL/path construction in `shared/urls.ts`; make `snowflakeMs` (`src/web/tree.ts:22`) total—preferably returning `number | null` so callers must choose an explicit fallback. This removes the duplicated server/client regexes at `server/urls.ts:7-23` and `App.tsx:20-27`, while eliminating the `BigInt()` render-time throw. Branding adds little residual value today: it would prevent theoretical `PostId`/`UserId` mixups, but no observed defect justifies propagating brands through every model and repository signature. Reconsider only if such mixups occur or multi-user boundaries expand.

2. **Residual reservation — NON-BLOCKING**

   X does not document its exact rotating-token replay behavior. Record the one-recovery policy as a deliberate availability tradeoff, log state transitions without tokens, and treat observed production behavior—not assumed “token family” scope—as authoritative. This does not block implementation.

3. **Final convergence**

   The plan is converged. With the bounded one-recovery OAuth rule and shared total ID parsing above, I have no remaining blocking architectural, sequencing, or scope disagreement.

Codex session ID: 019fb4c3-906b-7863-9bc5-9c80bbaeac4c
Resume in Codex: codex resume 019fb4c3-906b-7863-9bc5-9c80bbaeac4c

# Connector packet — implementation plan (2026-08-02)

*Written by Claude (the session's design lead) as the brief for the
implementing agent; scope and riders approved by Malo Bourgon.*

> STATUS: HISTORICAL. This is the brief the packet was built from; it shipped
> in commit 77333be and was then refined further in live review (fork/radius/
> disc retuned, stations moved to the counts line, footer principle, type
> voice). Its process instructions (worktree, no-commits, lead review) and
> numbers reflect the moment of writing — src/web and the coherence spec
> supersede it. Kept because it explains what the packet set out to preserve.

Goal: replace the thread view's rail/stub anatomy with the decided avatar-graph
grammar. RENDER-ONLY: model.ts, keys.ts, keymap.ts are untouched; every existing
test in test/thread-model.test.ts and test/thread-keys.test.ts must pass
unmodified. The design authority is avatar-graph-coherence-spec.md (same directory)
(rulings a–s); reference implementations are k-avatar-graph.html (grammar + skin
idioms) and m-fold-marks.html (fold stations, the click resolver). Port idioms,
don't transplant markup — the app's component boundaries stay.

## What the app gets (rulings in parens)

1. CONNECTOR LAYER. Avatars are the tree nodes: 32px discs in the thread view
   (PostView's .avatar; the inbox shares the component, so it matches — T6/row 33).
   A continuous line runs through them: the spine/trunk for segments (trunk never
   bends), runs render as beads on one straight line (no elbows), forks elbow off
   the parent's line with curved departures (r), mid-thread segment reply blocks
   take off via the tee (i, i-why) — UNIFORMLY: ruling (j) is RETIRED ("no j",
   Malo 2026-08-02), single-branch blocks take the same take-off, one render
   path — and the FINAL segment's replies attach directly: no take-off, ╰ ends
   the trunk (i-amend). Gap nodes render a dashed circle bead (l: never a ring; m: cursor
   may rest there); GapCard keeps its prose + x.com link and its post-<id>
   contract. Deficit counts ("N replies not available") stay prose (k) — keep
   .hidden-replies text form.

2. FOLD STATIONS (s, s-q). Every fold site — segment tee, chain head, fork tail —
   gets the ⊖/⊕ mark: a small disc ON the line at the attachment station —
   junction folds: bottom of the owner's body span; segment folds: the CENTER
   OF THE ARM'S STRAIGHT SPAN per (s-amend) (at the 34rem narrow tokens the
   mark centers on the straight span specifically, or the fork step grows;
   never on the departure curve). Always visible at line ink. Station identity: the mark's position
   is identical open vs closed (derive one anchor; assert it visually). Closed,
   per (s-amend)'s law: the owner's line CONTINUES from the ⊕ to the GHOST CHIP
   along its own direction, turning only where geometry demands — a vertical
   drop ╰s into the chip a fork-step right; the horizontal arm runs STRAIGHT
   into the chip standing where the sub-line was. Chip: caretless, bordered,
   mono, "n replies · k new" (n = subtree count, matching the app's existing
   subtreeSize usage; omit "· k new" when k=0). Mark, line,
   and chip are ONE control: port m's resolver (line/chip clicks defer to the
   mark's handler; never a second code path). All mouse folds go through
   ThreadCtx.setFold (Thread.tsx:520 — the mouse path with cursor rescue); the
   keyboard path (folds map via reducer) is untouched. Root's drop is inert
   (h); no marks between run beads (mid-run declined); trunk pass-throughs
   unmarked.

3. HOVER (e-settled). Hovering a mark or its line brightens the scope's OWN
   line — departure curve, arm, vertical run, first-level elbows — via child
   combinators (never custom-property inheritance at scope roots). Nothing else
   changes ink; NO region wash; no transitions anywhere (o). Line hit strips
   (h-amend): widened invisible strips along scope verticals — no exceptions
   remain now that (j) is retired; every fold has a line.

4. FOCUS (q, s-q). Keyboard-focusable marks/chips get a quiet accent ring
   (new token --accent-quiet, derived from the accent) — ring on the mark
   (chip-sized by construction), never a whole-drop lozenge (q-junction),
   no preview on focus.

5. STATE LAYER. Unread: the .unread-dot button RETIRES; unread renders as a
   2px accent ring on the avatar disc (rings never on gaps — l). Read-toggling
   remains via keyboard (r) and mark-all-read. [FLAGGED to owner: this removes
   the dot's click affordance; his rider said "unread dot likely becomes avatar
   ring".] Cursor: keep .post.cursor exactly as-is (the current background acts
   as the bed; lines pass through it at rest ink automatically). new-badge and
   notice bar untouched.

6. BYLINE (n, T3). Add the app's FIRST profile link: wrap @{authorHandle} in an
   anchor (add xProfileUrl(handle) to src/shared/urls.ts). Display name stays a
   span; date stays text; avatar is NOT a link (avatar click = row click =
   select — but note the click-guard at Thread.tsx:136 uses closest("a,button"),
   so the avatar img must NOT be wrapped in an anchor, and marks/chips must BE
   buttons so they don't move the cursor). Quote-card byline unchanged (name
   already a span; avatar-small stays 16px).

7. AVATAR FALLBACK (required by the grammar — every node is a bead). When
   authorAvatarUrl is null or errors, render an initials disc (first letters of
   authorName, two max) at the same size instead of nothing. Replace the
   onError display:none hack with state-driven fallback.

## Token block (styles.css)

Add a small connector token group mapped onto the existing palette (spec row 32's
two groups): at rest — --line-ink (from --border family), --bead-ink, --accent
(the existing #1d9e75 green), bed = existing --accent-bg; interaction —
--line-hover (brighter line ink), --accent-quiet (focus ring), --surface (chip
bg), ink ladder from --text/--text-muted. Derive geometry tokens (avatar size,
fork step, elbow radius, line width, grab width, station size) as custom
properties with K's naming spirit. Kill the hard-coded #4a8edb rail-hover blues
with the delete-list. --thread (purple spine) retires with .spine. Fix the
phantom --border-strong reference (styles.css:313) while in there.

## Delete-list / keep-list

Exactly the scout's lists: DELETE .children/.rail/.collapse-stub/.run-chain/
.run-rail/.run-post*/.run-branches/.spine/.segment-replies rules and their
DOM emitters' rail/stub markup (component NAMES stay; internals change).
KEEP: .post, .post.cursor, .post-meta, .post-text*, .quote-card*, .post-media*,
.help-overlay*, .notice*, .new-badge; the post-<id> id contract and
getElementById scroll paths; the two-context memo split (connector structure
lives in the wrappers OUTSIDE PostCard so the memo boundary is preserved);
scrollRequestRef discipline; dead .run wrapper class can go.

## Verification

Gates: bun run lint, bun run typecheck (tsc -b --force), bun test, bun run
test:d1, bun run build — all green, zero test edits. Visual verification is the
LEAD's job post-review (dev server needs 1Password-mounted secrets; do NOT try
to run wrangler dev in the sandbox — if you want visual self-checks, you may
build a THROWAWAY static harness page under the scratchpad (never committed)
that renders Thread with test fixtures, but gates are the requirement).
No commits — leave the worktree dirty; the lead reviews and applies the diff.

# Avatar-graph coherence spec (v1)

> AUTHORSHIP: this document was written by Claude (Anthropic's Claude Fable
> 5, via Claude Code) as the design's scribe and lead; the decisions it
> records were made by Malo Bourgon, the project owner, whose quoted words
> are verbatim. See the README's provenance section.
>
> HOW TO READ THIS: it is a decision log, not a clean-state spec — rulings
> are lettered (a)–(s) with amendments kept in place, because each rule's
> value includes its reasons and reversals. "Malo" / "the owner" is the
> project owner, whose quoted words are the source of most rulings. "The red
> team", "the audit", and "Codex" are adversarial review passes (a design
> red-team over the documents, a pixel-level visual audit of the app, and
> code reviews). "K", "the atlas", and "the m specimen" are the three HTML
> mockups beside this file — see this directory's README.
>
> STATUS (2026-08-02, end of ship day): this is the grammar's DECISION LOG
> and inventory. The connector packet shipped in commit 77333be; the late
> live-review refinements (mono telemetry voice, SVG metric icons, 1px line
> weight, zero leads, counts-line stations, quiet chrome links) were decided
> APP-SIDE, so where this document or the mockups disagree with src/web on
> paint numbers, THE APP IS THE TRUTH and the mockups trail it. Superseded
> rulings are kept and marked — the bracketed histories are the point.

The complete element×state inventory of the real app, each resolved against the seven-mark grammar. Rulings (a)-(i) live in k-avatar-graph.html's header (same directory); new rulings here are (j)+. All TASTE rows were answered by Malo (see the taste-calls section); everything else is derived. Every row names its State Atlas exhibit (A#).

## New rulings derived here

### (j) *[RETIRED 2026-08-02, "no j" — see the (s-amend) block; kept as history]* Single-branch take-off collapses to a direct arm.

The sub-line only materializes when 2+ branches must share it; with one branch the arm curves directly into the branch head's line — matching the original ASCII's `┣━━⬤` form. [CONFIRMED by Malo 2026-08-02]

### (k) Structure is never drawn for uncertainty.

Reply-count deficits ("2 replies not available") stay prose-layer — no phantom marks, no dashed stubs — because deficit counts are estimates and the line only ever states facts. Gap nodes are the exception precisely because a gap is a KNOWN missing post with a known id. [CONFIRMED by Malo 2026-08-02, "defensible for now"]

### (l) Rings never on gaps.

A dashed bead cannot be unread — there is no post to read — so the unread ring is impossible there by construction.

### (m) The cursor may rest on a gap.

The bed and bar render normally around a dashed bead (the keyboard walks placeholders today; the grammar must hold wherever the cursor can be).

### (n) Avatar click = row click = select.

The avatar is the node; selecting is what clicking a node means. The @handle in the byline is the ONLY profile link — the display name is not a link, the avatar is not a link. [CONFIRMED by Malo 2026-08-02]

### (o) Zero motion in v1.

No fold animations, no hover transitions — instant state changes. (Precedent: the Instrument mockup empirically hit stale-paint bugs animating theme-dependent colors; and folds re-layout the whole column, which animation would make worse, not better.) [CONFIRMED by Malo 2026-08-02; animations = a separate future decision]

### (p) Depth handling:

DEFERRED as its own design item [Malo 2026-08-02: "a whole separate can of worms"]. v1 keeps the app's existing behavior (indent keeps charging; deep fork chains are rare in practice).

The PARKED PROPOSAL, Malo's, recorded for that future item: past a chosen depth, content hides behind the normal fold mechanism, and opening it RE-ROOTS the view — the subtree renders at shallow indent with the ancestor chain compressed above (One-Branch mockup's ancestor ribbon is prior art). Not in the connector packet.

### (h-amend) The scope's own line is the handle's extended body.

Hover and click anywhere along a scope's vertical line (take-off sub-line, run line, fork drop) previews and folds, via a widened invisible hit strip — the old rails' muscle memory, restored. [Malo request 2026-08-02]

EXCEPTION (red team 2026-08-02): a ruling-(j) direct arm has no vertical of its own, so that one block's handle has no extended body — the chip on the arm is the whole target.

### (e-final) Preview = operand + effect, derived from Malo's distinction (2026-08-02):

folding HIDES the subtree but does not FOLD it — za closes ONE fold; nested fold state persists invisibly and reopening restores it exactly; only zC folds recursively. Therefore: the STEM brightens (the one fold being operated on) and a quiet REGION TINT washes the scope's extent (the effect: this region leaves the view).

Itemized per-mark brightening is rejected as over-attribution — it draws nested bystander structure as participants, previewing zC when the click is za. Round-4's "the set za/r operate on" conflated two different verbs (za occludes a region; r acts on every post in scope) and is corrected by this ruling. Comparison specimen ships anyway for visual confirmation.

### (e-settled) Preview is the line, first level only.

[Malo, 2026-08-02, ruling on the three-way comparison specimen: "this got away from us and got way too complicated. I just want it the way reddit does it. Just the first level is highlighted."]

Hover on a fold handle — or anywhere on its line, per (h-amend) — brightens the scope's OWN line: departure curve, arm, vertical run, and the first-level elbows that are that line's own anatomy. Nothing else changes ink: no region wash, no nested-mark brightening, no depth grading, no avatar involvement. Deeper structure, children's own drops, and bystander stubs stay at rest; a COLLAPSED fold's own stub elbow and badge ring are part of its line and do brighten (the H3-fixed path). The line is the handle (h-amend), so affordance and feedback are one element.

SUPERSEDES (e-final)'s region tint; itemized and depth-graded stay retired. The hide-vs-fold distinction (za closes one fold; nested state persists) remains semantic and no longer seeks visual expression in hover.

The three-way specimen stays in K as the decision's record, relabeled, with the chosen rendering added as its own panel.

### (r) Departures curve; through-lines stay straight.

Any line departing another line — a child elbow off a sibling line, the take-off arm off the trunk — begins with the same rounded curve, drawn as an overlay so the continuing line's own ink stays straight.

[Malo caught the tee departing square while child elbows curved, 2026-08-02; the sharp tee was an implementation artifact, and its "trunk doesn't bend" defense fails against the child-elbow comparison. Fix applies to K and the atlas.]

### (q) Focus-visible on interactive structure (tees, junctions, stubs) is a quiet accent ring (--accent-quiet), distinct from hover's neutral brightening:

hover previews, focus locates.

## Inventory (element × state → resolution → exhibit)

### Tree anatomy

1. Lone root, zero replies → one bead, no lines below it at all → A1

2. Lone root + replies (MOST COMMON) → no take-off (line doesn't continue); replies elbow directly off the root's line, ╰ terminates it → A2

3. Thread, segment WITHOUT replies → bare trunk bead, line passes through → A3

4. MID-THREAD segment with replies → take-off per (i)/(i-why); single-branch block uses (j)'s direct arm → A3, A4

    4b. FINAL segment with replies → NO take-off: replies attach directly and ╰ ends the trunk, per (i-amend) → A12

5. Run (single-child chain) → beads on one line, no elbows → A2

6. Fork mid-branch → elbows, parent's line ends at last ╰ → A2

7. Gap node, placement inferred vs root-fallback → dashed bead; tooltip text distinguishes ("Position inferred from reply counts" / "Replied somewhere in this conversation") — carried from current app → A5

8. Gap with children → children hang below the dashed bead normally → A5

9. Gap as fold owner (chain head/fork tail) → junction on the dashed bead; stub normal → A5

10. Non-snowflake missing parent → no gap node exists (model attaches replies to root); nothing to draw — no exhibit needed

11. Deficit marker ("2 replies not available") → prose-layer per (k) → A2

### Fold states

12. Segment block collapsed → stub at tee (shipped) → A3

13. Chain-head collapsed → stub replaces the run below, hanging where the run line attached (below the head's avatar) → A6

14. Fork-tail collapsed → stub replaces the branch set, same anchor rule → A6

15. zM (all folded) → trunk beads + stubs only; the page IS the thread's skeleton → A7

16. Nested: collapsed stub INSIDE an expanded scope renders normally and KEEPS ITS OWN INK under a hover preview — only the operated fold's own line brightens, per (e-settled); a bystander stub never changes. → A6

### Post content on the line

17. Quote card → bordered (exception ruling stands); sits in body layer, clear of the lane at every depth → A8

18. Nested quote / quote-fallback-link → body layer, unchanged → A8

19. Media (photo single + grid, video preview) → body layer; media never crosses into the lane; max-width = measure → A8

20. Long-post clamp + Show more → body layer, unchanged → A8

21. Unavailable QUOTED post → existing fallback card, unchanged → A8

### State layer

22. Unread ring (real posts only, per (l)) → shipped → A2

23. Cursor on: trunk bead (bed reaches left past the trunk lane; trunk passes THROUGH the bed at rest ink) → A9; mid-run bead (shipped); gap node per (m) → A9; fold-owner post whose stub shows below (bar on the post row only, stub outside the bed) → A9; gap that OWNS a fold with the cursor on it (row 9 ∩ this row — the combination the red team's H3 showed fragile) → A9 (added at the red-team fix round); bed INSIDE a take-off block → no exhibit yet (K base has the rule; the app's audit verified the live rendering)

24. Cursor + unread together → ring + bed + bar coexist, no interaction → A9

25. Fold-handle hover → first-level line preview per (e-settled) → A6

26. Row/avatar hover → minimal (existing row affordances); avatar click selects per (n) → no exhibit

27. Keyboard focus-visible per (q) → A6

### Geometry & responsive

28. Depth budget + exhaustion per (p) → A10 (a depth-9 synthetic column)

29. <980px: map rail hidden (already ruled) → n/a here

30. ≤34rem: avatar 28px, fork 1.95rem, bed-lead compressed (K's media query numbers become tokens; breakpoint corrected in place — an earlier draft said <700px; fork corrected from 1.6rem by measurement at the mocksync round — see the s-amend correction) → A11 (390px strip)

31. RTL → explicitly out of scope v1

### Packet boundary (for implementation against CURRENT paint)

32. The connector layer binds to TWO token groups (red-team correction 2026-08-02: the old "four tokens only" undercounted by half once rounds 4-5 added interaction states). AT REST: line ink (--rail), bead/stub ring (--bead-ink ← --rule), accent (unread rings only), bed surface. INTERACTION: preview wash (--surface-preview), focus ring (--accent-quiet), stub/card surface (--surface), and the ink ladder (--ink-faint/-quiet/-loud) for chip and stub text states. Still no dependency on the synthesis skin — the current app's teal + neutral grays map onto all eight; serif voice / status bar / palette / map remain OUTSIDE the packet. — no exhibit (not a tree state)

33. Inbox: no tree, no connector changes; avatars grow to match (32px) so the inbox view and thread view of a post share one feel — the one inbox touch. [CONFIRMED by Malo 2026-08-02] — no exhibit (inbox, not a tree state; verify at implementation)

## Taste calls — ALL ANSWERED by Malo 2026-08-02

T1 confirmed · T2 deferred as separate item (his re-root proposal parked in ruling p) · T3 confirmed with the sharper form (@handle is the only link) · T4 confirmed · T5 confirmed · T6 confirmed (match at 32px)

## Atlas-round resolutions (v1.2 — the atlas found 9 spec bugs + 2 K bugs)

### (i-amend) The bundle exists where the thread continues.

A mid-thread segment's replies bundle onto a take-off so the next trunk bead is unmistakable. The FINAL segment (and the lone root, its length-1 case) has no continuation to protect: its replies attach directly, ╰ ends the line, and the thread visibly opens out into its discussion at its end. (Resolves the atlas's row-15/(i) collision.)

### (i-why) The squiggle is the price of the thread's inequality.

[Malo's re-derivation 2026-08-02, closing a near-revert: he first read the take-off swerve as his own mistake, then rediscovered why it must exist.]

Every branch-off is the same mark — an elbow off a vertical; what differs is the vertical. At an ordinary fork all children are equal: the parent's line exists only to reach them and ENDS at the last ╰, so elbows attach directly, no squiggle, any number of children. A thread refuses that equality — X forces the author's next post into a privileged continuation, so the trunk outlives its reply set, and the un-privileged replies need their own subordinate vertical, born from the take-off.

Law: a line takes a bundle iff it continues past ALL its attachments to a continuation that is not one of them; today only the trunk qualifies.

Rejected here: uniform direct-elbows-off-trunk (re-opens the fold-anchor and segment-vs-reply questions the take-off settled).

PARKED (Claude's, not blessed): if a future view ever privileges other continuations (e.g. an A↔B dialogue run surviving side replies), those lines take bundles by the same law — needs a which-child-continues rule; adjacent to deferred depth item (p).

### (j-amend) The single-branch take-off's fold handle sits ON THE ARM — ruling (h) applied:

the handle lives where the foldable content attaches. (Atlas A4's answer, ratified.)

### (q-amend) Focus reveals:

a keyboard-focused handle shows the quiet-accent ring AND the handle chip. Hover previews; focus locates and reveals.

### (q-junction) The junction's ring rides its chip.

The junction element's box is its whole drop (avatar-bottom to limb-bottom), so an element outline renders as a lozenge as tall as the post — A6 drew it once and exposed it (red-team follow-on, 2026-08-02).

Focus locates the HANDLE, not the geometry: the junction's ring goes on the chip that (q-amend) reveals, chip-sized like the tee's and the stub's.

### (s) Fold station = mark + ghost.

[Malo 2026-08-02, deciding the fold-marks round: "the chip from k plus the elbow, with the plus/minus before the elbow will be the winner."]

FOLD VERB, settled across all his post-provocation sketches: the OWNER MODEL — a fold hides what hangs below an owner; the owner stays; one verb everywhere including the tee (the shipped app's semantics, so the packet stays render-only).

RENDERING: every fold site is TWO elements with two jobs. The MARK — a small ⊖/⊕ circle sitting ON the owner's line at the attachment point (bottom of the body span, above the first child) — is the control, and NEVER MOVES across the toggle: station identity, K's --takeoff-t discipline promoted to every site.

The GHOST — K's bordered chip on a short ╰ elbow, standing exactly where the first hidden avatar would have stood — appears only when closed and carries the count ("n replies · k new"). The chip loses its ▸ caret (the ⊕ owns the verb; redundant affordance); mark and chip are both click targets.

Applies uniformly: junction, chain-head, fork-tail, tee (mark on the arm, ghost where the block stood), trunk tail. The ⊖/⊕ pair replaces the caret glyph at every fold site.

VISIBILITY, decided [Malo 2026-08-02, "always visible for now"]: marks REST VISIBLE at quiet line ink and brighten with their line per (e-settled) — the fold structure is part of the drawing, not something hover discovers.

CLICK = FOLD [same message]: (h-amend) confirmed as action, not just preview — clicking anywhere on a scope's line/rail performs that scope's fold; mark, line, and ghost chip are one control in three shapes.

MID-RUN MARKS, decided [Malo 2026-08-02, "no mid-run marks for now"]: runs fold only from their chain head; the beads between run posts carry no marks. The m specimen keeps the B+ checkbox (off) as the decision's record.

#### (s-amend, Malo 2026-08-02 atlas review) Tee mark rides mid-arm; the closed line continues to the chip.

The segment fold's mark sits at the CENTER OF THE ARM'S STRAIGHT SPAN (not the corner, not the trunk — which would claim "fold the thread", the round-3 rejection — and not the sub-line, which would spend vertical space the compressed take-off exists to save).

Closed-form law, replacing the "╰ + chip" phrasing: the owner's line CONTINUES from the ⊕ to the ghost chip along its own direction, turning only where geometry demands (r) — a vertical drop ╰s into the chip standing a fork-step right; the horizontal arm runs STRAIGHT into the chip standing where the sub-line was. Same law, two orientations.

TOKEN CORRECTION (mocksync round, measured — this ruling's original "~15px at 34rem" was wrong): the arm's straight span = fork − two elbow radii + line width; at the old narrow fork 1.6rem that is 7.6px — an 11px disc cannot sit on it at all — and the old wide clamp floor 1.85rem left 0.3px of clearance per side across 545–987px viewports. THE FORK FLOOR IS 1.95rem AT EVERY VIEWPORT (narrow token and wide clamp floor alike): one floor, one inequality, ~3.5px clearance per side at 1280px, ~1.1px at 390px. The mark centers on the STRAIGHT SPAN, never on the departure curve.

And RESOLVED [Malo 2026-08-02, "yeah, no j"]: ruling (j)'s direct arm is RETIRED — the uniform take-off applies to single-branch blocks too (one render path; the sub-line materializes even for one branch). With it dies (h-amend)'s only exception: every fold now has a line for the hit strip. (j) may return someday as pure CSS polish; it is history, not law.

#### (s-footer, Malo 2026-08-02 live review) The metadata line is a footer, not a hack.

Every post renders its metadata line even when empty — X's own anatomy: the action row is never absent from a post, and the counts line is its read-only mirror. The fold station rides it, and because the footer is always the card's LAST line, "align to the last line" and "align to the metadata line" are one rule with bead clearance guaranteed by construction.

The rejected alternative — a geometric anchor with fold-owning short cards growing to host their station — was refused on principle: card height must be a function of the POST, never of its role in the tree (two identical posts must not render at different sizes because one has replies).

The deficit note rides ON the footer, at its end ("♥ 1 · 1 reply not available") — it is metadata, so it lives on the metadata line [Malo, same session], which also makes blank footers rarer.

THE EXCEPTION: gaps — not posts, no byline, no footer — keep the atlas's junction-under-the-bead, their card growing only when they own a fold (acceptable for the one element that is a different species).

Implementation note: the empty footer must be RESERVED with min-height — a whitespace-only div collapses to zero and silently un-reserves the line (caught live).

#### (s-q) Reconciliation with the q-family:

with marks always visible, (q-amend)'s reveal clause is obsolete at fold sites — nothing is hidden to reveal.

Keyboard focus = the quiet accent ring around the MARK itself, which is chip-sized by construction, satisfying (q-junction) trivially; the ghost chip rings itself when focused. Hover-revealed caret chips are retired everywhere the ⊖/⊕ mark now stands. NOTHING on the fold question remains open.

### (o-todo) Discharged at unification 2026-08-02:

zero transition/animation declarations remain in K or the atlas — verified by CSSOM walk at unification and re-verified by the red team.

### Row 30 fixed:

the narrow breakpoint is K's actual 34rem; narrow tokens include avatar 28px.

ALIAS MECHANISM, MEASURED (unification round, Chromium 2026-08-02 — corrects this spec's earlier claim and the atlas header's): var() substitutes per-element at computed-value time. An alias on the SAME element as the override tracks it (a `:root` media-query override of --avatar updates `:root`'s `--lane: var(--avatar)` with no re-declaration). But custom properties inherit as computed, already-substituted values — so a DESCENDANT's re-declaration of --avatar never updates an alias declared on an ancestor.

Rule: when an override lives on a descendant scope, re-declare the alias at that same scope. (The atlas's A11 finding was real — it was the descendant case — and was over-generalized to the same-element case.)

### Rows 18+21 merged:

nested-quote overflow and unavailable-quoted post are the same rendered element (quote-card link fallback) in the app.

### K base bugs to fix at unification:

.is-root descendant selectors leak root sizing to every post (child combinators fix); atlas extensions E1-E6 ratified into the base where their exhibits demand.

### A10 relabel:

the depth-floor rendering is a SECOND CANDIDATE for the deferred depth item — distinct from (p)'s parked proposal, which is Malo's re-root idea; v1 keeps current indent behavior per (p).

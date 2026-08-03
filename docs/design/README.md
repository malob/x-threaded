# The avatar-graph design

This directory is the design record for x-threaded's thread view — the
"avatar graph": a way of drawing a reply tree where **the authors' avatars are
the tree's nodes** and a single continuous line runs through them. The line
bends only where the conversation branches, so depth is charged only when
structure demands it, and a long back-and-forth reads as beads on one straight
line instead of a staircase.

The shipped implementation lives in `src/web/` (mainly `styles.css`,
`Thread.tsx`, `PostView.tsx`). These documents are how it got that way.

## The grammar in one breath

Seven marks, and everything on screen is one of them:

1. **Bead** — an avatar on the line; the post itself. Initials disc when the
   image is missing; a dashed circle for a post we never got.
2. **Straight line** — continuation. One reply, no elbow: the next bead sits
   on the same line at the same indent.
3. **Elbow** — a fork. Two or more replies each curve off their parent's
   line; the last one's `╰` ends it.
4. **Trunk** — the thread's own spine. It never bends, and it runs clean past
   every reply block to the next segment bead.
5. **Take-off** — a mid-thread segment's replies bundle onto one arm with
   their own sub-line, so the trunk's continuation is never mistaken for a
   reply. The *final* segment needs no take-off: nothing left to protect, so
   its replies attach directly and the thread visibly opens out.
6. **Fold station** — a small `⊖`/`⊕` disc sitting *on* the line where the
   foldable content attaches. It never moves when toggled; a closed fold
   continues its line into a "ghost chip" (`12 replies · 4 new`) standing
   where the first hidden bead would have been. The whole line is the
   handle: mark, line, and chip are one control.
7. **Ring** — state, never structure. The accent appears only as an unread
   ring on a bead, a focus ring on a control — never as a line.

## The files

| File | What it is |
|---|---|
| `avatar-graph-coherence-spec.md` | The constitution: every rule the drawing obeys, as a **decision log** — each ruling keeps its rationale, its author's words, and its reversals. Start here for *why*. |
| `k-avatar-graph.html` | "K" — the living mockup. The grammar rendered as a self-contained page with extensively annotated CSS; the implementation ported its idioms. **Open it in a browser** — it needs no server or build. |
| `l-state-atlas.html` | The State Atlas — every element × state combination rendered as exhibits (A1–A12): every fold state, cursor overlaps, gaps, a 390px strip. Built to *find* spec bugs by rendering, and it found eleven before any app code existed. |
| `m-fold-marks.html` | The fold-marks decision instrument: three competing fold semantics × two visibility modes, every mark clickable. The fold question was settled by clicking around in this page; the losing options remain as the record. |
| `connector-packet-plan.md` | Historical: the implementation brief the app change was built from. |

The mockups are deliberately self-contained single files — open any of them
directly. Their internal comments are most of the documentation.

## How it happened (short version)

A three-axis exploration (paint × structure × component vocabulary, nine
mockups plus a synthesis — not archived here) established the visual voice
and, more importantly, established that the classic nested-column reading
model should stay. The avatar-graph idea itself came from the project owner
as an ASCII sketch; it went through a formal coherence pass — enumerate every
element × state, render all of it (the atlas), then adversarial review —
before a line of app code changed. The implementation round then went through
a live owner review that produced roughly twenty pixel-level catches, a
systematic visual audit, and two more adversarial code reviews. Several of
the catches (a box-sizing reset that didn't match pseudo-elements, unitless
zeros silently killing `calc()`, inset shadows swallowed by images) are
recorded in the stylesheet's comments where they happened, as warnings to the
next hand.

## Authorship and provenance

These documents, the three mockups, and the shipped implementation were
written by **Claude** (Anthropic's Claude Fable 5, working through Claude
Code) acting as design lead and scribe. The **design decisions were made by
Malo Bourgon**, the project's owner — the quoted verdicts throughout the spec
("Malo, 2026-08-02, …") are his verbatim words, and most rulings exist
because he caught something or called something. The adversarial passes named
in the log were also AI: "the red team" and "the visual audit" were separate
Claude agents attacking the documents and the rendered app respectively, and
"Codex" is OpenAI's model, used for independent code review. In short: human
taste and judgment, machine drafting and verification — the log records
which was which at every step.

## Trust order

Late taste decisions (mono metadata voice, inline SVG metric icons, 1px
lines, zero vertical leads, stations riding the footer line) were made
directly in the app during live review. **Where these documents disagree with
`src/web` on paint numbers, the app is the truth** — the mockups trail it and
await a back-port pass. The *rulings* (the semantic law of the drawing) are
current in the spec.

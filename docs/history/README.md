# History

Records of work that has since been superseded, kept because the reasoning is
worth more than the conclusions. **Nothing in here describes the current code.**
Treat every `file:line` reference as a statement about the commit it names, not
about `main`.

For what is true now, see the [README](../../README.md) (architecture),
[`docs/x-api-notes.md`](../x-api-notes.md) (the X API), and
[`docs/design/`](../design/README.md) (the thread view).

## [`2026-07-30-architecture-review/`](2026-07-30-architecture-review/)

A full architecture review of commit `ed8ea1a`, and the roadmap it produced.
Seven reviewers covered the repo from their own specialty, their findings were
synthesised, and the plan was then stress-tested in a four-round adversarial
dialogue between Claude and Codex before anything was written.
[`00-synthesis.md`](2026-07-30-architecture-review/00-synthesis.md) is the entry
point; the individual reports and the dialogue transcripts sit alongside it.

The roadmap it produced has since shipped in full — stages 0 through 7, every
one of them reviewed at its boundary — which is exactly why the document is
now historical. Whole files it discusses are gone: `store-d1.ts` and
`store-sqlite.ts` became the `SqlDriver` seam in `src/server/db/`, `tree.ts`
became `src/web/thread/model.ts`, and the six migrations it worked against were
folded into one baseline in August 2026.

Two things make it worth keeping anyway. The dialogue transcripts attach a
**"Would change my mind:"** condition to every disputed point, which is a
better record of how a technical disagreement was actually settled than any
summary would be. And the review is candid about what was wrong at the time —
no trust boundary anywhere, a spend meter that provably read low, a test count
of zero — which is the part a reader learns from.

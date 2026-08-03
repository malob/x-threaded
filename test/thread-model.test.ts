/**
 * The thread model, structure by structure.
 *
 * These lock what `buildThread` builds — the spine, the branch decomposition,
 * segment reply blocks, fold ownership and defaults, document order, scopes,
 * gap placement, hidden-reply counts and display text. Every expectation was
 * derived from the behavior of the tree module this replaced (src/web/tree.ts
 * as of Stage 6b-1), including the quirks, which are called out where they
 * appear.
 */
import { describe, expect, it } from "bun:test";
import type { Post } from "../src/shared/types";
import {
  buildThread,
  emptyKeyModel,
  type Branch,
  type Segment,
  type ThreadModel,
  type ThreadNode,
} from "../src/web/thread/model";
import { makePost, snowflakeId } from "./fixtures";

/** A minute apart, so declaration order is chronological unless a spec says otherwise. */
function at(minute: number): string {
  return new Date(Date.parse("2025-03-01T12:00:00.000Z") + minute * 60_000).toISOString();
}

interface Spec {
  readonly name: string;
  /** Author id; doubles as the handle unless `handle` says otherwise. */
  readonly author?: string;
  readonly handle?: string;
  /**
   * Parent's name; omit for the root, or name a `missing` spec for an orphan.
   * Omitting it on a non-root post means a null parentId — the shape X returns
   * when the parent was deleted, which buildThread adopts onto the root.
   */
  readonly parent?: string;
  /** Minutes past the fixture epoch; defaults to the declaration index. */
  readonly minute?: number;
  /** The direct reply count the post declares — what deficits are measured against. */
  readonly replies?: number;
  readonly text?: string;
  /** Referenced as a parent but never returned by the API. */
  readonly missing?: true;
  /** A literal post id, for ids that aren't snowflakes. */
  readonly id?: string;
}

interface Fixture {
  readonly model: ThreadModel;
  readonly id: (name: string) => string;
  readonly name: (id: string) => string;
  readonly names: (ids: readonly string[]) => string[];
  /** Rendered order under `folds`, by fixture name. */
  readonly order: (folds?: ReadonlyMap<string, boolean>) => string[];
  readonly node: (name: string) => ThreadNode;
}

function conversation(specs: readonly Spec[], opts?: { truncated?: boolean }): Fixture {
  const ids = new Map<string, string>();
  const names = new Map<string, string>();
  specs.forEach((spec, i) => {
    const id = spec.id ?? snowflakeId(at(spec.minute ?? i));
    ids.set(spec.name, id);
    names.set(id, spec.name);
  });

  const posts: Post[] = [];
  specs.forEach((spec, i) => {
    if (spec.missing) return;
    const author = spec.author ?? "A";
    posts.push(
      makePost({
        id: ids.get(spec.name)!,
        createdAt: at(spec.minute ?? i),
        authorId: author,
        authorHandle: spec.handle ?? author,
        parentId: spec.parent === undefined ? null : ids.get(spec.parent)!,
        text: spec.text ?? spec.name,
        metrics: {
          likes: 0,
          replies: spec.replies ?? 0,
          reposts: 0,
          quotes: 0,
          bookmarks: 0,
          impressions: 0,
        },
      }),
    );
  });

  const model = buildThread(ids.get(specs[0]!.name)!, posts, opts);
  if (!model) throw new Error("fixture root missing");
  const name = (id: string): string => names.get(id) ?? `?${id}`;
  return {
    model,
    id: (n) => ids.get(n)!,
    name,
    names: (list) => list.map(name),
    order: (folds) => model.visibleIds(folds ?? new Map()).map(name),
    node: (n) => model.byId.get(ids.get(n)!)!,
  };
}

function threadSegments(model: ThreadModel): readonly Segment[] {
  if (model.layout.kind !== "thread") throw new Error("expected a thread layout");
  return model.layout.segments;
}

function rootBranch(model: ThreadModel): Branch {
  if (model.layout.kind !== "branch") throw new Error("expected a branch layout");
  return model.layout.branch;
}

/**
 * The root has three replies, the first of which is a two-post chain. Nobody
 * replies to themselves, so there is no spine and every fold starts open.
 */
const FORK: readonly Spec[] = [
  { name: "root", author: "A" },
  { name: "b1", author: "B", parent: "root" },
  { name: "c1", author: "C", parent: "b1" },
  { name: "b2", author: "C", parent: "root" },
  { name: "b3", author: "D", parent: "root" },
];

/**
 * The root author replying to themselves twice, with other people's replies
 * hanging off the first two segments.
 */
const SPINE: readonly Spec[] = [
  { name: "s1", author: "A" },
  { name: "x1", author: "B", parent: "s1" },
  { name: "y1", author: "C", parent: "x1" },
  { name: "y2", author: "D", parent: "x1" },
  { name: "s2", author: "A", parent: "s1" },
  { name: "x2", author: "B", parent: "s2" },
  { name: "s3", author: "A", parent: "s2" },
];

describe("buildThread", () => {
  it("returns null when the conversation doesn't contain its root", () => {
    expect(buildThread("404", [makePost({ id: snowflakeId(at(0)), createdAt: at(0) })])).toBeNull();
    expect(buildThread("404", [])).toBeNull();
  });

  it("hangs parentless non-root posts off the root", () => {
    // The API returns conversation members whose parent it didn't; a post with
    // no parentId at all is treated as a direct reply to the root.
    const t = conversation([{ name: "root" }, { name: "loose", author: "B" }]);
    expect(t.names(t.model.allOrder)).toEqual(["root", "loose"]);
    expect(t.model.parents.get(t.id("loose"))).toBe(t.id("root"));
  });
});

describe("the spine", () => {
  it("follows the root author's self-replies and stops where they do", () => {
    const t = conversation(SPINE);
    expect(t.names(t.model.spine.map((n) => n.id))).toEqual(["s1", "s2", "s3"]);
    expect(t.model.layout.kind).toBe("thread");
  });

  it("takes the earliest self-reply and leaves later ones as ordinary replies", () => {
    const t = conversation([
      { name: "s1", author: "A", minute: 0 },
      { name: "s2", author: "A", parent: "s1", minute: 2 },
      { name: "also-mine", author: "A", parent: "s1", minute: 3 },
      { name: "other", author: "B", parent: "s1", minute: 4 },
    ]);
    expect(t.names(t.model.spine.map((n) => n.id))).toEqual(["s1", "s2"]);
    // The later self-reply is inside s1's reply block, not a segment of its own.
    expect(t.names(threadSegments(t.model)[0]!.replies.map((r) => r.head.id))).toEqual([
      "also-mine",
      "other",
    ]);
  });

  it("only looks at direct children, so a self-reply one level down doesn't continue it", () => {
    const t = conversation([
      { name: "s1", author: "A" },
      { name: "reply", author: "B", parent: "s1" },
      { name: "mine-again", author: "A", parent: "reply" },
    ]);
    expect(t.names(t.model.spine.map((n) => n.id))).toEqual(["s1"]);
    expect(t.model.layout.kind).toBe("branch");
  });

  it("is length 1 when there is no thread, and then the layout is a plain branch", () => {
    const t = conversation(FORK);
    expect(t.names(t.model.spine.map((n) => n.id))).toEqual(["root"]);
    expect(t.model.layout.kind).toBe("branch");
    expect(t.model.segmentFolds.size).toBe(0);
  });

  /**
   * Conversation 1366577587732979713 (Eliezer Yudkowsky's 2021-03-01
   * wealth-tax thread), the incident this rule exists for: X omits the
   * `replied_to` reference when a post's parent was deleted, so a deep reply
   * of his arrived with no parent and was adopted onto the root. Being ten
   * minutes older than the real continuation, it won the earliest-first rule
   * and the spine followed it off the thread entirely.
   */
  it("doesn't let an adopted post win the spine over a genuine reply to the root", () => {
    const t = conversation([
      { name: "root", author: "A", minute: 0 },
      // Parent deleted: the API returned it with no reference at all.
      { name: "orphan", author: "A", minute: 7 },
      { name: "s2", author: "A", parent: "root", minute: 17 },
      { name: "s3", author: "A", parent: "s2", minute: 27 },
    ]);
    expect(t.names(t.model.spine.map((n) => n.id))).toEqual(["root", "s2", "s3"]);
    // Still held, still visible: an ordinary reply block under the root.
    expect(t.model.parents.get(t.id("orphan"))).toBe(t.id("root"));
    expect(t.names(threadSegments(t.model)[0]!.replies.map((r) => r.head.id))).toEqual(["orphan"]);
    expect(t.names(t.model.allOrder)).toEqual(["root", "orphan", "s2", "s3"]);
  });

  it("stays at the root when the only self-reply below it was adopted", () => {
    const t = conversation([
      { name: "root", author: "A", minute: 0 },
      { name: "orphan", author: "A", minute: 5 },
    ]);
    expect(t.names(t.model.spine.map((n) => n.id))).toEqual(["root"]);
    expect(t.model.layout.kind).toBe("branch");
    expect(t.names(rootBranch(t.model).rest.map((n) => n.id))).toEqual(["orphan"]);
    expect(t.names(t.model.allOrder)).toEqual(["root", "orphan"]);
  });

  it("doesn't follow a self-reply rehomed from an undatable missing parent", () => {
    // A non-snowflake missing id gets no gap, so its replies land on the root
    // (see "gives a non-snowflake missing id no gap at all") — placement
    // again, so the same exclusion applies.
    const t = conversation([
      { name: "root", author: "A", replies: 2, minute: 0 },
      { name: "ghost", missing: true, id: "not-a-snowflake" },
      { name: "orphan", author: "A", parent: "ghost", minute: 5 },
      { name: "s2", author: "A", parent: "root", minute: 9 },
    ]);
    expect(t.names(t.model.spine.map((n) => n.id))).toEqual(["root", "s2"]);
    expect(t.model.parents.get(t.id("orphan"))).toBe(t.id("root"));
  });

  it("never runs through a gap, which has no author to match", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 1 },
      { name: "ghost", missing: true, minute: 3 },
      { name: "orphan", author: "A", parent: "ghost", minute: 5 },
    ]);
    expect(t.names(t.model.spine.map((n) => n.id))).toEqual(["root"]);
  });
});

describe("run flattening", () => {
  it("swallows a single-child chain into one branch and breaks at the forking post", () => {
    const t = conversation([
      { name: "r", author: "A" },
      { name: "a", author: "B", parent: "r" },
      { name: "b", author: "C", parent: "a" },
      { name: "c", author: "B", parent: "b" },
      { name: "d1", author: "C", parent: "c" },
      { name: "d2", author: "D", parent: "c" },
    ]);
    const branch = rootBranch(t.model);
    expect(t.name(branch.head.id)).toBe("r");
    expect(t.names(branch.rest.map((n) => n.id))).toEqual(["a", "b", "c"]);
    // The fork ends the run at the post that forks, not at its replies.
    expect(t.name(branch.tail.id)).toBe("c");
    expect(t.names(branch.forks.map((f) => f.head.id))).toEqual(["d1", "d2"]);
    // The head owns the chain fold, the tail owns the fork fold.
    expect(t.names([...t.model.branchFolds])).toEqual(["r", "c"]);
  });

  it("gives a childless post an empty run whose tail is itself", () => {
    const t = conversation([{ name: "only" }]);
    const branch = rootBranch(t.model);
    expect(branch.rest).toEqual([]);
    expect(branch.tail).toBe(branch.head);
    expect(branch.forks).toEqual([]);
    expect(t.model.branchFolds.size).toBe(0);
    expect(t.model.foldOwners).toEqual([]);
  });

  it("does not start a run at a fork: the head is also the tail", () => {
    const t = conversation(FORK);
    const branch = rootBranch(t.model);
    expect(branch.rest).toEqual([]);
    expect(branch.tail).toBe(branch.head);
    expect(t.names(branch.forks.map((f) => f.head.id))).toEqual(["b1", "b2", "b3"]);
    // b1's chain is its own branch, one post long below the head.
    expect(t.names(branch.forks[0]!.rest.map((n) => n.id))).toEqual(["c1"]);
    expect(t.names([...t.model.branchFolds])).toEqual(["root", "b1"]);
  });
});

describe("segment reply blocks", () => {
  it("excludes the next spine post and nothing else", () => {
    const t = conversation(SPINE);
    const segments = threadSegments(t.model);
    expect(t.names(segments.map((s) => s.node.id))).toEqual(["s1", "s2", "s3"]);
    expect(t.names(segments[0]!.replies.map((r) => r.head.id))).toEqual(["x1"]);
    expect(t.names(segments[1]!.replies.map((r) => r.head.id))).toEqual(["x2"]);
    // The last segment has no successor, so all of its children are replies.
    expect(segments[2]!.replies).toEqual([]);
  });

  it("keeps a segment's non-spine self-reply in its own reply block", () => {
    const t = conversation([
      { name: "s1", author: "A", minute: 0 },
      { name: "s2", author: "A", parent: "s1", minute: 1 },
      { name: "aside", author: "A", parent: "s1", minute: 2 },
      { name: "s3", author: "A", parent: "s2", minute: 3 },
    ]);
    const segments = threadSegments(t.model);
    expect(t.names(segments.map((s) => s.node.id))).toEqual(["s1", "s2", "s3"]);
    expect(t.names(segments[0]!.replies.map((r) => r.head.id))).toEqual(["aside"]);
  });

  it("makes a segment with replies a fold owner that starts closed", () => {
    const t = conversation(SPINE);
    expect(t.names([...t.model.segmentFolds])).toEqual(["s1", "s2"]);
    expect(t.model.isOpen(t.id("s1"), new Map())).toBe(false);
    expect(t.model.isOpen(t.id("s3"), new Map())).toBe(true);
    // Branch folds inside a segment's replies start open.
    expect(t.model.isOpen(t.id("x1"), new Map())).toBe(true);
    // Branch folds come first in foldOwners; the two global fold commands set both.
    expect(t.names(t.model.foldOwners)).toEqual(["x1", "s1", "s2"]);
  });
});

describe("document order", () => {
  it("walks a plain branch head-first, chain then forks", () => {
    const t = conversation(FORK);
    expect(t.names(t.model.allOrder)).toEqual(["root", "b1", "c1", "b2", "b3"]);
    expect(t.order()).toEqual(["root", "b1", "c1", "b2", "b3"]);
  });

  it("starts a thread with the spine alone, because segment folds start closed", () => {
    const t = conversation(SPINE);
    expect(t.names(t.model.allOrder)).toEqual(["s1", "x1", "y1", "y2", "s2", "x2", "s3"]);
    expect(t.order()).toEqual(["s1", "s2", "s3"]);
    expect(t.order(new Map([[t.id("s1"), true]]))).toEqual(["s1", "x1", "y1", "y2", "s2", "s3"]);
  });

  it("hides a chain below its head and a fork below its tail", () => {
    const t = conversation(FORK);
    // The chain fold lives on b1; closing it hides c1 only.
    expect(t.order(new Map([[t.id("b1"), false]]))).toEqual(["root", "b1", "b2", "b3"]);
    // The fork fold lives on the root; closing it hides every reply.
    expect(t.order(new Map([[t.id("root"), false]]))).toEqual(["root"]);
  });

  it("stops at a closed chain even when the run's tail forks below it", () => {
    const t = conversation([
      { name: "r", author: "A" },
      { name: "a", author: "B", parent: "r" },
      { name: "b", author: "C", parent: "a" },
      { name: "c1", author: "B", parent: "b" },
      { name: "c2", author: "D", parent: "b" },
    ]);
    expect(t.names(t.model.allOrder)).toEqual(["r", "a", "b", "c1", "c2"]);
    expect(t.order(new Map([[t.id("r"), false]]))).toEqual(["r"]);
    expect(t.order(new Map([[t.id("b"), false]]))).toEqual(["r", "a", "b"]);
  });

  it("lets an explicit decision override either default, both ways", () => {
    const spine = conversation(SPINE);
    expect(spine.order(new Map([[spine.id("s1"), true]]))).toContain("x1");
    const fork = conversation(FORK);
    expect(fork.order(new Map([[fork.id("root"), true]]))).toEqual([
      "root",
      "b1",
      "c1",
      "b2",
      "b3",
    ]);
  });
});

describe("scopes", () => {
  it("gives an ordinary post its whole subtree", () => {
    const t = conversation(FORK);
    expect(t.names(t.model.scopeIds(t.id("root")))).toEqual(["root", "b1", "c1", "b2", "b3"]);
    expect(t.names(t.model.scopeIds(t.id("b1")))).toEqual(["b1", "c1"]);
    expect(t.names(t.model.scopeIds(t.id("b3")))).toEqual(["b3"]);
  });

  it("stops a spine segment at its own reply blocks, not the segments after it", () => {
    const t = conversation(SPINE);
    expect(t.names(t.model.scopeIds(t.id("s1")))).toEqual(["s1", "x1", "y1", "y2"]);
    expect(t.names(t.model.scopeIds(t.id("s2")))).toEqual(["s2", "x2"]);
    expect(t.names(t.model.scopeIds(t.id("s3")))).toEqual(["s3"]);
    // A post inside a segment's replies is ordinary again.
    expect(t.names(t.model.scopeIds(t.id("x1")))).toEqual(["x1", "y1", "y2"]);
  });

  it("is empty for a post the model doesn't know", () => {
    expect(conversation(FORK).model.scopeIds("nope")).toEqual([]);
  });

  it("agrees with subtreeSize on everything that isn't a segment", () => {
    const t = conversation(FORK);
    for (const id of t.model.allOrder) {
      expect(t.model.subtreeSize(id)).toBe(t.model.scopeIds(id).length);
    }
    expect(t.model.subtreeSize("nope")).toBe(0);
  });
});

describe("gaps", () => {
  it("infers the host when exactly one earlier post has a reply-count deficit", () => {
    const t = conversation([
      // The root's one declared reply is the one we hold, so it has no deficit.
      { name: "root", author: "A", replies: 1, minute: 0 },
      { name: "kid", author: "B", parent: "root", replies: 3, minute: 1 },
      { name: "ghost", missing: true, minute: 3 },
      { name: "orphan", author: "C", parent: "ghost", minute: 5 },
    ]);
    const gap = t.node("ghost");
    expect(gap.kind).toBe("gap");
    if (gap.kind !== "gap") throw new Error("unreachable");
    expect(gap.placementInferred).toBe(true);
    // Dated from its own snowflake, at second resolution.
    expect(gap.createdAt).toBe(at(3));
    expect(t.model.parents.get(gap.id)).toBe(t.id("kid"));
    expect(t.names(gap.children.map((c) => c.id))).toEqual(["orphan"]);
    expect(t.names(t.model.allOrder)).toEqual(["root", "kid", "ghost", "orphan"]);
  });

  it("falls back to the root when nothing has a deficit", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 1, minute: 0 },
      { name: "kid", author: "B", parent: "root", replies: 0, minute: 1 },
      { name: "ghost", missing: true, minute: 3 },
      { name: "orphan", author: "C", parent: "ghost", minute: 5 },
    ]);
    const gap = t.node("ghost");
    if (gap.kind !== "gap") throw new Error("expected a gap");
    expect(gap.placementInferred).toBe(false);
    expect(t.model.parents.get(gap.id)).toBe(t.id("root"));
  });

  it("falls back to the root when several posts could be the host", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 4, minute: 0 },
      { name: "kid", author: "B", parent: "root", replies: 3, minute: 1 },
      { name: "kid2", author: "C", parent: "root", replies: 2, minute: 2 },
      { name: "ghost", missing: true, minute: 4 },
      { name: "orphan", author: "D", parent: "ghost", minute: 6 },
    ]);
    const gap = t.node("ghost");
    if (gap.kind !== "gap") throw new Error("expected a gap");
    expect(gap.placementInferred).toBe(false);
    expect(t.model.parents.get(gap.id)).toBe(t.id("root"));
  });

  it("ignores candidates that postdate the missing post", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 2, minute: 0 },
      { name: "kid", author: "B", parent: "root", replies: 3, minute: 1 },
      // Later than the ghost, so it can't have hosted it — leaving one candidate.
      { name: "kid2", author: "C", parent: "root", replies: 3, minute: 8 },
      { name: "ghost", missing: true, minute: 4 },
      { name: "orphan", author: "D", parent: "ghost", minute: 6 },
    ]);
    const gap = t.node("ghost");
    if (gap.kind !== "gap") throw new Error("expected a gap");
    expect(gap.placementInferred).toBe(true);
    expect(t.model.parents.get(gap.id)).toBe(t.id("kid"));
  });

  it("spends a host's deficit, so a second gap can't reuse an exhausted one", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 1, minute: 0 },
      { name: "kid", author: "B", parent: "root", replies: 1, minute: 1 },
      { name: "g1", missing: true, minute: 3 },
      { name: "g2", missing: true, minute: 4 },
      { name: "o1", author: "C", parent: "g1", minute: 6 },
      { name: "o2", author: "D", parent: "g2", minute: 7 },
    ]);
    const first = t.node("g1");
    const second = t.node("g2");
    if (first.kind !== "gap" || second.kind !== "gap") throw new Error("expected gaps");
    // Gaps are placed oldest first, so g1 takes kid's only hidden reply.
    expect(first.placementInferred).toBe(true);
    expect(t.model.parents.get(first.id)).toBe(t.id("kid"));
    expect(second.placementInferred).toBe(false);
    expect(t.model.parents.get(second.id)).toBe(t.id("root"));
  });

  it("gives a non-snowflake missing id no gap at all: its replies go to the root", () => {
    // Nothing can date it, so a gap would need an invented timestamp.
    const t = conversation([
      { name: "root", author: "A", replies: 2, minute: 0 },
      { name: "kid", author: "B", parent: "root", replies: 3, minute: 1 },
      { name: "ghost", missing: true, id: "not-a-snowflake" },
      { name: "orphan", author: "C", parent: "ghost", minute: 5 },
    ]);
    expect(t.model.byId.has("not-a-snowflake")).toBe(false);
    expect(t.model.parents.get(t.id("orphan"))).toBe(t.id("root"));
    expect(t.names(t.model.allOrder)).toEqual(["root", "kid", "orphan"]);
  });

  it("carries no post: only an id, a date and where we think it hung", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 1, minute: 0 },
      { name: "ghost", missing: true, minute: 3 },
      { name: "orphan", author: "C", parent: "ghost", minute: 5 },
    ]);
    const gap = t.node("ghost");
    expect(Object.keys(gap).sort()).toEqual([
      "children",
      "createdAt",
      "id",
      "kind",
      "placementInferred",
    ]);
  });

  it("sorts a gap among its siblings by the time its id encodes", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 3, minute: 0 },
      { name: "early", author: "B", parent: "root", minute: 1 },
      { name: "late", author: "B", parent: "root", minute: 9 },
      { name: "ghost", missing: true, minute: 5 },
      { name: "orphan", author: "C", parent: "ghost", minute: 7 },
    ]);
    expect(t.names(t.model.allOrder)).toEqual(["root", "early", "ghost", "orphan", "late"]);
  });
});

describe("hidden reply counts", () => {
  it("counts the replies a post declares but the tree doesn't hold", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 3 },
      { name: "kid", author: "B", parent: "root", replies: 2 },
    ]);
    expect(t.model.hiddenReplies.get(t.id("root"))).toBe(2);
    expect(t.model.hiddenReplies.get(t.id("kid"))).toBe(2);
  });

  it("counts a gap as present, since it stands for one hidden reply", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 1, minute: 0 },
      { name: "kid", author: "B", parent: "root", replies: 1, minute: 1 },
      { name: "ghost", missing: true, minute: 3 },
      { name: "orphan", author: "C", parent: "ghost", minute: 5 },
    ]);
    // kid declared one reply and hosts the gap that stands for it.
    expect(t.model.hiddenReplies.has(t.id("kid"))).toBe(false);
    // A gap declares nothing, so it never appears here.
    expect(t.model.hiddenReplies.has(t.id("ghost"))).toBe(false);
  });

  it("is empty when the fetch was truncated, because a deficit means nothing then", () => {
    const specs: Spec[] = [
      { name: "root", author: "A", replies: 3 },
      { name: "kid", author: "B", parent: "root", replies: 2 },
    ];
    expect(conversation(specs, { truncated: true }).model.hiddenReplies.size).toBe(0);
    expect(conversation(specs, { truncated: false }).model.hiddenReplies.size).toBe(2);
  });
});

describe("display text", () => {
  it("strips leading mentions of ancestor authors and anyone mentioned upstream", () => {
    const t = conversation([
      { name: "root", author: "A", handle: "alice", text: "hi @bob and @carol" },
      { name: "r1", author: "B", handle: "bob", parent: "root", text: "@alice @carol yes" },
      { name: "r2", author: "C", handle: "carol", parent: "r1", text: "@alice @bob @dave nope" },
    ]);
    const text = (name: string): string => {
      const node = t.node(name);
      if (node.kind !== "post") throw new Error("expected a post");
      return node.displayText;
    };
    expect(text("root")).toBe("hi @bob and @carol");
    expect(text("r1")).toBe("yes");
    // @dave is nobody upstream, so stripping stops there and keeps the rest.
    expect(text("r2")).toBe("@dave nope");
  });

  it("keeps mid-text mentions, even of an ancestor", () => {
    const t = conversation([
      { name: "root", author: "A", handle: "alice", text: "root" },
      { name: "r1", author: "B", handle: "bob", parent: "root", text: "sure @alice" },
    ]);
    const node = t.node("r1");
    if (node.kind !== "post") throw new Error("expected a post");
    expect(node.displayText).toBe("sure @alice");
  });

  it("falls back to the full text when stripping would leave nothing", () => {
    const t = conversation([
      { name: "root", author: "A", handle: "alice", text: "root" },
      { name: "r1", author: "B", handle: "bob", parent: "root", text: "@alice" },
    ]);
    const node = t.node("r1");
    if (node.kind !== "post") throw new Error("expected a post");
    expect(node.displayText).toBe("@alice");
  });

  it("carries the context down the whole ancestry, not just one level", () => {
    const t = conversation([
      { name: "root", author: "A", handle: "alice", text: "root" },
      { name: "r1", author: "B", handle: "bob", parent: "root", text: "@alice ok" },
      { name: "r2", author: "C", handle: "carol", parent: "r1", text: "@alice @bob sure" },
      { name: "r3", author: "D", handle: "dan", parent: "r2", text: "@alice @bob @carol done" },
    ]);
    const node = t.node("r3");
    if (node.kind !== "post") throw new Error("expected a post");
    expect(node.displayText).toBe("done");
  });

  it("strips a leading @i under a gap — the last trace of the fake placeholder Post", () => {
    // A QUIRK, preserved: the placeholder Post this union replaced carried the
    // handle "i" (x.com's stand-in for an unnamed author), and that handle
    // reached the reply-context set of everything below it.
    const t = conversation([
      { name: "root", author: "A", handle: "alice", replies: 1, minute: 0 },
      { name: "ghost", missing: true, minute: 3 },
      { name: "orphan", author: "C", handle: "carol", parent: "ghost", minute: 5, text: "@i hey" },
    ]);
    const node = t.node("orphan");
    if (node.kind !== "post") throw new Error("expected a post");
    expect(node.displayText).toBe("hey");
  });
});

describe("chronological ordering", () => {
  it("sorts siblings by creation time, not by the order the API returned them", () => {
    const t = conversation([
      { name: "root", author: "A", minute: 0 },
      { name: "late", author: "B", parent: "root", minute: 9 },
      { name: "early", author: "C", parent: "root", minute: 2 },
      { name: "middle", author: "D", parent: "root", minute: 5 },
    ]);
    expect(t.names(t.model.allOrder)).toEqual(["root", "early", "middle", "late"]);
    expect(t.names(t.node("root").children.map((c) => c.id))).toEqual([
      "early",
      "middle",
      "late",
    ]);
  });

  it("resolves the spine through the sort, so declaration order can't pick the segment", () => {
    const t = conversation([
      { name: "s1", author: "A", minute: 0 },
      { name: "later-self", author: "A", parent: "s1", minute: 8 },
      { name: "earlier-self", author: "A", parent: "s1", minute: 3 },
    ]);
    expect(t.names(t.model.spine.map((n) => n.id))).toEqual(["s1", "earlier-self"]);
  });
});

describe("the keyboard model it hands out", () => {
  it("answers the reducer's questions from the same materialized structure", () => {
    const t = conversation(SPINE);
    const unread = new Set([t.id("y1")]);
    const visible = t.model.visibleIds(new Map());
    const key = t.model.keyModel(visible, unread);

    expect(key.rootId).toBe(t.id("s1"));
    expect(t.names([...key.visible])).toEqual(["s1", "s2", "s3"]);
    expect(t.names([...key.allOrder])).toEqual(["s1", "x1", "y1", "y2", "s2", "x2", "s3"]);
    expect(key.unread).toBe(unread);
    expect(t.names([...key.foldOwners])).toEqual(["x1", "s1", "s2"]);
    expect(key.has(t.id("y2"))).toBe(true);
    expect(key.has("nope")).toBe(false);
    expect(key.parentOf(t.id("x1"))).toBe(t.id("s1"));
    expect(key.parentOf(t.id("s1"))).toBeNull();
    expect(key.parentOf("nope")).toBeNull();
    expect(t.names([...key.childrenOf(t.id("x1"))])).toEqual(["y1", "y2"]);
    expect(key.childrenOf("nope")).toEqual([]);
    expect(key.authorHandle(t.id("x1"))).toBe("B");
    expect(key.authorHandle("nope")).toBeUndefined();
    expect(key.isFoldOwner(t.id("s1"))).toBe(true);
    expect(key.isFoldOwner(t.id("y1"))).toBe(false);
    expect(key.startsClosed(t.id("s1"))).toBe(true);
    expect(key.startsClosed(t.id("x1"))).toBe(false);
    expect(t.names([...key.scopeIds(t.id("s1"))])).toEqual(["s1", "x1", "y1", "y2"]);
  });

  it("has no handle for a gap, which is the same link x.com's /i/ path builds", () => {
    const t = conversation([
      { name: "root", author: "A", replies: 1, minute: 0 },
      { name: "ghost", missing: true, minute: 3 },
      { name: "orphan", author: "C", parent: "ghost", minute: 5 },
    ]);
    const key = t.model.keyModel(t.model.allOrder, new Set());
    expect(key.authorHandle(t.id("ghost"))).toBeUndefined();
    expect(key.has(t.id("ghost"))).toBe(true);
  });

  it("hands the keyboard an inert model when there is no conversation to read", () => {
    const key = emptyKeyModel("123");
    expect(key.rootId).toBe("123");
    expect(key.visible).toEqual([]);
    expect(key.allOrder).toEqual([]);
    expect(key.foldOwners).toEqual([]);
    expect(key.has("123")).toBe(false);
    expect(key.parentOf("123")).toBeNull();
    expect(key.childrenOf("123")).toEqual([]);
    expect(key.authorHandle("123")).toBeUndefined();
    expect(key.isFoldOwner("123")).toBe(false);
    expect(key.startsClosed("123")).toBe(false);
    expect(key.scopeIds("123")).toEqual([]);
  });
});

describe("unread counting", () => {
  it("counts a node and its descendants, which is what a fold's badge shows", () => {
    const t = conversation(FORK);
    const unread = new Set([t.id("b1"), t.id("c1"), t.id("b3")]);
    expect(t.model.unreadCount(t.id("root"), unread)).toBe(3);
    expect(t.model.unreadCount(t.id("b1"), unread)).toBe(2);
    expect(t.model.unreadCount(t.id("b2"), unread)).toBe(0);
    expect(t.model.unreadCount("nope", unread)).toBe(0);
  });
});

/**
 * A linear reply chain of `n` posts. Only the root is author A, so nobody
 * replies to themselves: there is no spine, and every post owns its whole
 * subtree — which on this shape is the entire chain below it.
 */
function chain(n: number): { readonly ids: readonly string[]; readonly posts: readonly Post[] } {
  const ids: string[] = [];
  const posts: Post[] = [];
  for (let i = 0; i < n; i++) {
    const createdAt = at(i);
    const id = snowflakeId(createdAt);
    ids.push(id);
    posts.push(
      makePost({
        id,
        createdAt,
        authorId: i === 0 ? "A" : "B",
        authorHandle: i === 0 ? "A" : "B",
        parentId: i === 0 ? null : ids[i - 1]!,
      }),
    );
  }
  return { ids, posts };
}

describe("deep chains", () => {
  it("scopes every post of a long chain to the chain below it", () => {
    const { ids, posts } = chain(200);
    const rootId = ids[0]!;
    const model = buildThread(rootId, posts);
    if (!model) throw new Error("chain root missing");
    const unread = new Set(ids.filter((_, i) => i % 3 === 0));

    expect(model.allOrder).toEqual(ids);
    expect(model.scopeIds(rootId)).toEqual(ids);
    expect(model.scopeIds(ids[120]!)).toEqual(ids.slice(120));
    expect(model.scopeIds(ids[199]!)).toEqual([ids[199]!]);

    // Size, scope and unread count are three readings of one subtree.
    for (const [i, id] of ids.entries()) {
      const below = ids.slice(i);
      expect(model.subtreeSize(id)).toBe(below.length);
      expect(model.scopeIds(id)).toEqual(below);
      expect(model.unreadCount(id, unread)).toBe(below.filter((m) => unread.has(m)).length);
    }
  });

  /**
   * A complexity lock, not a benchmark. Subtrees were once stored per node, so
   * a chain cost the sum of its suffixes — 10,000 posts took ~640ms and ~160MB
   * retained, against ~13ms and nothing measurable for the one-pass range
   * representation. The bound sits far from both numbers on purpose: it has to
   * fail on a quadratic build and pass on any machine running a linear one, so
   * what it pins is the shape of the curve, not the constant.
   */
  it("builds a 10,000-post chain in linear time", () => {
    const { ids, posts } = chain(10_000);
    const started = performance.now();
    const model = buildThread(ids[0]!, posts);
    const elapsed = performance.now() - started;

    expect(model?.subtreeSize(ids[0]!)).toBe(10_000);
    expect(model?.allOrder.length).toBe(10_000);
    expect(elapsed).toBeLessThan(300);
  });
});

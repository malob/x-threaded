/**
 * The keyboard layer, key by key.
 *
 * These lock the behavior of the vim bindings: what each key does, what it
 * refuses to do, and the commands it hands back to the caller. The model under
 * test is the one the view builds (thread/model.ts), so a test agreeing with
 * the reducer but not with the app is not possible.
 *
 * Where a test pins a decision rather than a mechanism — the cursor is never
 * invisible, Escape always means cancel, a reveal opens every ancestor —
 * the comment on that test says which decision it is pinning.
 */
import { describe, expect, it } from "bun:test";
import type { Post } from "../src/shared/types";
import { HELP, KEYMAP } from "../src/web/thread/keymap";
import {
  applyKey,
  isModifierKey,
  normalizeKey,
  type Command,
  type KeyModel,
  type KeyResult,
  type KeyState,
} from "../src/web/thread/keys";
import { buildThread } from "../src/web/thread/model";
import { makePost } from "./fixtures";

const HANDLES: Record<string, string> = { A: "alice", B: "bob", C: "carol", D: "dave" };

/** name, author, parent name (null for the root). */
type Spec = readonly [string, string, string | null];

/** A minute apart in declaration order, so declaration order is tree order. */
function at(minute: number): string {
  return new Date(Date.parse("2025-03-01T12:00:00.000Z") + minute * 60_000).toISOString();
}

interface Thread {
  /** Post ID by fixture name. */
  readonly id: (name: string) => string;
  readonly start: KeyState;
  /** The model the view would build for this state. */
  readonly modelFor: (state: KeyState) => KeyModel;
  /** Feed keys in one at a time, rebuilding the model between them. */
  readonly press: (state: KeyState, ...keys: string[]) => KeyResult;
  /** Post names in rendered order under the state's folds. */
  readonly visible: (state: KeyState) => string[];
}

function thread(specs: readonly Spec[], unreadNames: readonly string[] = []): Thread {
  const ids = new Map<string, string>();
  const names = new Map<string, string>();
  const posts: Post[] = [];
  specs.forEach(([name, author, parent], i) => {
    const post = makePost({
      createdAt: at(i),
      authorId: author,
      authorHandle: HANDLES[author] ?? author,
      parentId: parent === null ? null : (ids.get(parent) ?? null),
      text: name,
    });
    ids.set(name, post.id);
    names.set(post.id, name);
    posts.push(post);
  });

  const rootId = ids.get(specs[0]![0])!;
  const model = buildThread(rootId, posts)!;
  const unread = new Set(unreadNames.map((name) => ids.get(name)!));

  const modelFor = (state: KeyState): KeyModel =>
    model.keyModel(model.visibleIds(state.folds), unread);

  return {
    id: (name) => ids.get(name)!,
    start: { cursorId: rootId, folds: new Map(), pending: null, helpOpen: false },
    modelFor,
    press: (state, ...keys) => {
      let result: KeyResult = { state, commands: [], handled: false };
      for (const key of keys) result = applyKey(result.state, modelFor(result.state), key);
      return result;
    },
    visible: (state) => modelFor(state).visible.map((id) => names.get(id)!),
  };
}

/**
 * A fork: the root has three replies, the first of which is a two-post chain.
 * Nobody replies to themselves, so there is no thread spine and everything
 * starts open. Fold owners: root (the fork) and b1 (the chain).
 */
const FORK: readonly Spec[] = [
  ["root", "A", null],
  ["b1", "B", "root"],
  ["c1", "C", "b1"],
  ["b2", "C", "root"],
  ["b3", "D", "root"],
];

/**
 * A thread spine: the root author replying to themselves twice, with other
 * people's replies hanging off the first two segments. Segment folds start
 * closed, so only the three spine posts are visible to begin with.
 */
const SPINE: readonly Spec[] = [
  ["s1", "A", null],
  ["x1", "B", "s1"],
  ["y1", "C", "x1"],
  ["y2", "D", "x1"],
  ["s2", "A", "s1"],
  ["x2", "B", "s2"],
  ["s3", "A", "s2"],
];

/**
 * A chain that ends in a fork: root → b1 → c1, and c1 has two replies. The
 * fold owners are root (which collapses the chain) and c1 (which collapses the
 * fork); b1 owns no fold, which is what makes it the post the fold map must
 * never mention.
 */
const DEEP: readonly Spec[] = [
  ["root", "A", null],
  ["b1", "B", "root"],
  ["c1", "C", "b1"],
  ["d1", "D", "c1"],
  ["d2", "B", "c1"],
];

const scrollNearest: Command = { kind: "scroll-to-cursor", mode: "nearest", force: false };
const scrollCenter: Command = { kind: "scroll-to-cursor", mode: "center", force: true };
/** Fold entries, sorted so a map's insertion order doesn't matter. */
const foldEntries = (state: KeyState): [string, boolean][] => [...state.folds.entries()].sort();

describe("key normalization", () => {
  it("folds shift into the character, so R and zC are one table entry each", () => {
    expect(normalizeKey("r", true)).toBe("R");
    expect(normalizeKey("R", true)).toBe("R");
    expect(normalizeKey("c", true)).toBe("C");
    expect(normalizeKey("r", false)).toBe("r");
  });

  it("spells shift-slash as ?", () => {
    expect(normalizeKey("/", true)).toBe("?");
    expect(normalizeKey("/", false)).toBe("/");
  });

  it("leaves named keys alone, shift or not", () => {
    expect(normalizeKey("ArrowDown", true)).toBe("ArrowDown");
    expect(normalizeKey("Enter", false)).toBe("Enter");
    expect(normalizeKey("{", true)).toBe("{");
  });

  it("knows the bare modifier presses that never reach the keymap", () => {
    for (const key of ["Shift", "Meta", "Control", "Alt"]) expect(isModifierKey(key)).toBe(true);
    for (const key of ["j", "Enter", "ArrowDown"]) expect(isModifierKey(key)).toBe(false);
  });
});

describe("j / k", () => {
  const t = thread(FORK);

  it("walks the visible order and asks to scroll the cursor into view", () => {
    const down = t.press(t.start, "j");
    expect(down.state.cursorId).toBe(t.id("b1"));
    expect(down.commands).toEqual([scrollNearest]);
    expect(down.handled).toBe(true);
    expect(t.press(t.start, "j", "j").state.cursorId).toBe(t.id("c1"));
    expect(t.press(t.start, "j", "j", "j").state.cursorId).toBe(t.id("b2"));
  });

  it("stops at the ends of the list without touching the state", () => {
    const last = t.press(t.start, "j", "j", "j", "j").state;
    expect(last.cursorId).toBe(t.id("b3"));
    const past = t.press(last, "j");
    expect(past.state.cursorId).toBe(t.id("b3"));
    expect(past.commands).toEqual([scrollNearest]);

    // The cursor is re-set to where it already was: no state change, but the
    // scroll request still goes out, so a k at the top nudges the view up.
    const first = t.press(t.start, "k");
    expect(first.state).toBe(t.start);
    expect(first.commands).toEqual([scrollNearest]);
    expect(first.handled).toBe(true);
  });

  it("treats the arrows as the same two commands", () => {
    expect(t.press(t.start, "ArrowDown").state.cursorId).toBe(t.id("b1"));
    expect(t.press(t.start, "ArrowDown", "ArrowUp").state.cursorId).toBe(t.id("root"));
  });

  it("has a visible cursor to move from after a fold closes over it", () => {
    // Decision: the cursor is never invisible. za on b2 closes the root's fork
    // block, which would hide b2 — so the close takes the cursor with it, and
    // j and k start from a post that is actually on screen.
    const closed = t.press(t.start, "j", "j", "j", "z", "a").state;
    expect(closed.cursorId).toBe(t.id("root"));
    expect(t.visible(closed)).toEqual(["root"]);
    expect(t.press(closed, "j").state.cursorId).toBe(t.id("root"));
    expect(t.press(closed, "k").state.cursorId).toBe(t.id("root"));
  });

  it("re-anchors to the nearest visible ancestor when the cursor is off the list", () => {
    // Decision: the cursor is never invisible — and when something outside the
    // reducer makes it so anyway (a mouse click on a rail is the only way
    // left), the next motion walks it back into view instead of teleporting to
    // the top of the thread. This is that state, spelled out: b1's chain
    // closed with the cursor still on c1 inside it.
    const hidden: KeyState = {
      ...t.start,
      cursorId: t.id("c1"),
      folds: new Map([[t.id("b1"), false]]),
    };
    expect(t.visible(hidden)).toEqual(["root", "b1", "b2", "b3"]);

    // The keypress re-anchors onto b1; it does not also advance to b2.
    const down = t.press(hidden, "j");
    expect(down.state.cursorId).toBe(t.id("b1"));
    expect(down.commands).toEqual([scrollNearest]);
    const up = t.press(hidden, "k");
    expect(up.state.cursorId).toBe(t.id("b1"));
    expect(up.commands).toEqual([scrollNearest]);

    // From there, motion is ordinary again.
    expect(t.press(down.state, "j").state.cursorId).toBe(t.id("b2"));
    expect(t.press(up.state, "k").state.cursorId).toBe(t.id("root"));

    // Only the relative motions re-anchor: gg and G name a post outright, and
    // an off-list cursor is nothing to them.
    expect(t.press(hidden, "G").state.cursorId).toBe(t.id("b3"));
    expect(t.press(hidden, "g", "g").state.cursorId).toBe(t.id("root"));
  });
});

describe("h / l", () => {
  const t = thread(FORK);

  it("h climbs to the parent and stops at the root", () => {
    const onC1 = t.press(t.start, "j", "j").state;
    expect(t.press(onC1, "h").state.cursorId).toBe(t.id("b1"));
    expect(t.press(onC1, "h", "h").state.cursorId).toBe(t.id("root"));
    const atRoot = t.press(onC1, "h", "h").state;
    expect(t.press(atRoot, "h").state).toBe(atRoot);
    expect(t.press(atRoot, "ArrowLeft").handled).toBe(true);
  });

  it("l descends to the first reply and does nothing on a leaf", () => {
    expect(t.press(t.start, "l").state.cursorId).toBe(t.id("b1"));
    const onB3 = t.press(t.start, "j", "j", "j", "j").state;
    const leaf = t.press(onB3, "l");
    expect(leaf.state).toBe(onB3);
    expect(leaf.handled).toBe(true);
  });

  it("opens the ancestry when the first reply is hidden behind a closed fold", () => {
    // Close b1's chain from b1 itself, then descend into it anyway.
    const folded = t.press(t.start, "j", "z", "a").state;
    expect(t.visible(folded)).toEqual(["root", "b1", "b2", "b3"]);
    const opened = t.press(folded, "l");
    expect(opened.state.cursorId).toBe(t.id("c1"));
    expect(t.visible(opened.state)).toEqual(["root", "b1", "c1", "b2", "b3"]);
    expect(opened.commands).toEqual([scrollNearest]);
  });
});

describe("{ / }", () => {
  const t = thread(FORK);

  it("moves between siblings", () => {
    const onB2 = t.press(t.start, "j", "j", "j").state;
    expect(t.press(onB2, "}").state.cursorId).toBe(t.id("b3"));
    expect(t.press(onB2, "{").state.cursorId).toBe(t.id("b1"));
  });

  it("bubbles out to an ancestor's sibling when the cursor has none", () => {
    const onC1 = t.press(t.start, "j", "j").state;
    // c1 is an only child, so } finds b1's next sibling instead.
    expect(t.press(onC1, "}").state.cursorId).toBe(t.id("b2"));
  });

  it("does nothing when the search runs out of ancestors", () => {
    const onC1 = t.press(t.start, "j", "j").state;
    const back = t.press(onC1, "{");
    expect(back.state).toBe(onC1);
    expect(back.handled).toBe(true);
    const onB3 = t.press(t.start, "j", "j", "j", "j").state;
    expect(t.press(onB3, "}").state).toBe(onB3);
    expect(t.press(t.start, "}").state).toBe(t.start);
  });
});

describe("gg / G", () => {
  const t = thread(FORK);

  it("goes to the first and last visible posts", () => {
    const onB2 = t.press(t.start, "j", "j", "j").state;
    expect(t.press(onB2, "g", "g").state.cursorId).toBe(t.id("root"));
    expect(t.press(t.start, "G").state.cursorId).toBe(t.id("b3"));
  });

  it("counts only what is visible", () => {
    // With the root's fork closed, the last post is the root itself.
    const closed = t.press(t.start, "z", "a").state;
    expect(t.press(closed, "G").state.cursorId).toBe(t.id("root"));
  });
});

describe("n / N", () => {
  const t = thread(SPINE, ["y1", "x2"]);

  it("jumps to the next unread, opens its ancestry, centers it, and marks it read", () => {
    const jump = t.press(t.start, "n");
    expect(jump.state.cursorId).toBe(t.id("y1"));
    expect(t.visible(jump.state)).toEqual(["s1", "x1", "y1", "y2", "s2", "s3"]);
    expect(jump.commands).toEqual([
      scrollCenter,
      { kind: "set-read", ids: [t.id("y1")], read: true },
    ]);
  });

  it("walks unread posts in document order, folds and all", () => {
    const second = t.press(t.start, "n", "n");
    expect(second.state.cursorId).toBe(t.id("x2"));
    expect(t.visible(second.state)).toContain("x2");
  });

  it("wraps around the end of the conversation", () => {
    // The set-read commands are only requests here, so both posts stay unread
    // in the model and the third jump comes back around to the first.
    const third = t.press(t.start, "n", "n", "n");
    expect(third.state.cursorId).toBe(t.id("y1"));
  });

  it("N searches backwards, wrapping the other way", () => {
    expect(t.press(t.start, "N").state.cursorId).toBe(t.id("x2"));
    expect(t.press(t.start, "N", "N").state.cursorId).toBe(t.id("y1"));
  });

  it("does nothing at all when there is nothing unread, but still eats the key", () => {
    const quiet = thread(SPINE);
    const result = quiet.press(quiet.start, "n");
    expect(result.state).toBe(quiet.start);
    expect(result.commands).toEqual([]);
    expect(result.handled).toBe(true);
    expect(quiet.press(quiet.start, "N").state).toBe(quiet.start);
  });
});

describe("pending key sequences", () => {
  const t = thread(FORK);

  it("holds the prefix without disturbing anything else", () => {
    const pending = t.press(t.start, "z");
    expect(pending.state.pending).toBe("z");
    expect(pending.state.cursorId).toBe(t.start.cursorId);
    expect(pending.state.folds).toBe(t.start.folds);
    expect(pending.commands).toEqual([]);
    expect(pending.handled).toBe(true);
    expect(t.press(t.start, "g").state.pending).toBe("g");
    expect(t.press(t.start, "y").state.pending).toBe("y");
  });

  it("gx opens the post on x.com", () => {
    const result = t.press(t.start, "g", "x");
    expect(result.commands).toEqual([
      { kind: "open-url", url: `https://x.com/alice/status/${t.id("root")}` },
    ]);
    expect(result.handled).toBe(true);
  });

  it("yy copies the x.com link, Y copies the app path", () => {
    expect(t.press(t.start, "y", "y").commands).toEqual([
      { kind: "copy", text: `https://x.com/alice/status/${t.id("root")}` },
    ]);
    expect(t.press(t.start, "Y").commands).toEqual([
      { kind: "copy-app-link", path: `/alice/status/${t.id("root")}` },
    ]);
  });

  it("leaves gx and yy to the browser when there is no cursor", () => {
    // The two link commands are the only ones that report "not handled" for a
    // missing cursor; zO and friends swallow the key regardless.
    const nowhere: KeyState = { ...t.start, cursorId: null };
    const gx = t.press(nowhere, "g", "x");
    expect(gx.commands).toEqual([]);
    expect(gx.handled).toBe(false);
    expect(t.press(nowhere, "y", "y").handled).toBe(false);
    expect(t.press(nowhere, "z", "O").handled).toBe(true);
  });

  it("consumes the pending prefix on any key, matching or not", () => {
    // z then j is not a j: the sequence is dropped whole.
    const missed = t.press(t.start, "z", "j");
    expect(missed.state.cursorId).toBe(t.id("root"));
    expect(missed.state.pending).toBeNull();
    expect(missed.commands).toEqual([]);
    expect(missed.handled).toBe(false);
    // The key after that is read fresh.
    expect(t.press(missed.state, "j").state.cursorId).toBe(t.id("b1"));

    expect(t.press(t.start, "g", "z", "z").state.pending).toBe("z");
    expect(t.press(t.start, "y", "q").state.pending).toBeNull();

    // Decision: Escape always means cancel. It is the one key a pending prefix
    // does not get to swallow — it drops the prefix and stays handled (what it
    // does to the help overlay is locked under "help overlay").
    const escaped = t.press(t.start, "z", "Escape");
    expect(escaped.state.pending).toBeNull();
    expect(escaped.handled).toBe(true);
  });
});

describe("z folds", () => {
  const t = thread(FORK);

  it("resolves the owning fold when the cursor is not an owner", () => {
    // b2 owns nothing; the fold that hides it belongs to the root. Closing it
    // takes the cursor out to that owner (decision: the cursor is never
    // invisible), which is where the second za reopens the block from.
    const closed = t.press(t.start, "j", "j", "j", "z", "a");
    expect(t.visible(closed.state)).toEqual(["root"]);
    expect(closed.state.cursorId).toBe(t.id("root"));
    expect(closed.commands).toEqual([scrollNearest]);
    expect(t.visible(t.press(closed.state, "z", "a").state)).toEqual([
      "root",
      "b1",
      "c1",
      "b2",
      "b3",
    ]);
  });

  it("zo only opens, and Enter toggles exactly like za", () => {
    const closed = t.press(t.start, "z", "a").state;
    expect(t.visible(t.press(closed, "z", "o").state)).toEqual(["root", "b1", "c1", "b2", "b3"]);
    expect(t.visible(t.press(closed, "z", "o", "z", "o").state)).toEqual([
      "root",
      "b1",
      "c1",
      "b2",
      "b3",
    ]);
    expect(t.press(t.start, "Enter").state.folds).toEqual(t.press(t.start, "z", "a").state.folds);
    expect(t.press(t.start, "Enter").commands).toEqual([scrollNearest]);
  });

  it("Enter closing a fold re-homes the cursor exactly as za does", () => {
    // Enter and za are one command, so the re-home lives in the command rather
    // than in the key: from c1, either one closes b1's chain and lands on b1.
    const onC1 = t.press(t.start, "j", "j").state;
    const viaEnter = t.press(onC1, "Enter");
    const viaZa = t.press(onC1, "z", "a");
    expect(viaEnter.state.cursorId).toBe(t.id("b1"));
    expect(viaZa.state.cursorId).toBe(t.id("b1"));
    expect(viaEnter.state.folds).toEqual(viaZa.state.folds);
    expect(viaEnter.commands).toEqual([scrollNearest]);
    expect(t.visible(viaEnter.state)).toEqual(["root", "b1", "b2", "b3"]);
  });

  it("zc closes the owning fold and brings the cursor to the owner", () => {
    const result = t.press(t.start, "j", "j", "z", "c");
    expect(result.state.cursorId).toBe(t.id("b1"));
    expect(t.visible(result.state)).toEqual(["root", "b1", "b2", "b3"]);
    expect(result.commands).toEqual([scrollNearest]);
  });

  it("zO and zC work on the cursor's scope", () => {
    const collapsed = t.press(t.start, "z", "C");
    expect(t.visible(collapsed.state)).toEqual(["root"]);
    expect(foldEntries(collapsed.state)).toEqual(
      ([
        [t.id("root"), false],
        [t.id("b1"), false],
      ] as [string, boolean][]).sort(),
    );
    expect(collapsed.commands).toEqual([scrollNearest]);
    expect(t.visible(t.press(collapsed.state, "z", "O").state)).toEqual([
      "root",
      "b1",
      "c1",
      "b2",
      "b3",
    ]);
  });

  it("scopes zC to the cursor's own subtree, not the whole conversation", () => {
    // From b1 only b1's chain closes; the root's fork block stays open.
    const result = t.press(t.start, "j", "z", "C");
    expect(t.visible(result.state)).toEqual(["root", "b1", "b2", "b3"]);
    expect([...result.state.folds.keys()]).toEqual([t.id("b1")]);
  });

  it("zR and zM set every fold, and zM re-homes the cursor to the root", () => {
    const onB2 = t.press(t.start, "j", "j", "j").state;
    const all = t.press(onB2, "z", "M");
    expect(all.state.cursorId).toBe(t.id("root"));
    expect(t.visible(all.state)).toEqual(["root"]);
    expect(all.commands).toEqual([scrollNearest, scrollNearest]);
    const reopened = t.press(all.state, "z", "R");
    expect(t.visible(reopened.state)).toEqual(["root", "b1", "c1", "b2", "b3"]);
    expect(reopened.state.cursorId).toBe(t.id("root"));
    expect(reopened.commands).toEqual([scrollNearest]);
  });

  it("zM writes exactly one entry per fold owner, replacing whatever was there", () => {
    const stale = t.press(t.start, "z", "M").state;
    expect([...stale.folds.keys()].sort()).toEqual([t.id("root"), t.id("b1")].sort());
  });

  it("zz asks for an immediate centering scroll of the cursor's post", () => {
    const result = t.press(t.start, "z", "z");
    expect(result.commands).toEqual([
      { kind: "scroll-to-post", postId: t.id("root"), mode: "center" },
    ]);
    expect(result.state.folds).toBe(t.start.folds);
  });

  it("does nothing when no ancestor of the cursor owns a fold", () => {
    // A conversation of one post has no folds at all.
    const lonely = thread([["only", "A", null]]);
    const result = lonely.press(lonely.start, "z", "a");
    expect(result.state.folds.size).toBe(0);
    expect(result.commands).toEqual([]);
    expect(result.handled).toBe(true);
  });
});

describe("z folds on a thread spine", () => {
  const t = thread(SPINE);

  it("starts with segment replies collapsed and branch folds open", () => {
    expect(t.visible(t.start)).toEqual(["s1", "s2", "s3"]);
  });

  it("opens one segment's replies with za", () => {
    const opened = t.press(t.start, "z", "a").state;
    expect(t.visible(opened)).toEqual(["s1", "x1", "y1", "y2", "s2", "s3"]);
  });

  it("keeps zC inside the segment: the following segments are not its subtree", () => {
    const opened = t.press(t.start, "z", "a").state;
    const closed = t.press(opened, "z", "C");
    expect(foldEntries(closed.state)).toEqual(
      ([
        [t.id("s1"), false],
        [t.id("x1"), false],
      ] as [string, boolean][]).sort(),
    );
    expect(t.visible(closed.state)).toEqual(["s1", "s2", "s3"]);
  });

  it("opening someone else's fold leaves the cursor where it is", () => {
    // The re-home is a closing rule only. s3 owns no fold, so za opens s2's
    // reply block above it — which hides nothing, so nothing moves.
    const onS3 = t.press(t.start, "j", "j").state;
    const opened = t.press(onS3, "z", "a");
    expect(opened.state.cursorId).toBe(t.id("s3"));
    expect(t.visible(opened.state)).toEqual(["s1", "s2", "x2", "s3"]);
  });

  it("zR opens every fold in the conversation, spine segments included", () => {
    expect(t.visible(t.press(t.start, "z", "R").state)).toEqual([
      "s1",
      "x1",
      "y1",
      "y2",
      "s2",
      "x2",
      "s3",
    ]);
  });
});

describe("r / R", () => {
  const fork = thread(FORK);
  const spine = thread(SPINE);

  it("marks just the cursor's post when it is open", () => {
    expect(fork.press(fork.start, "r").commands).toEqual([
      { kind: "set-read", ids: [fork.id("root")], read: true },
    ]);
    const onB2 = fork.press(fork.start, "j", "j", "j").state;
    expect(fork.press(onB2, "r").commands).toEqual([
      { kind: "set-read", ids: [fork.id("b2")], read: true },
    ]);
  });

  it("marks everything a closed fold hides when the cursor owns it", () => {
    const closed = fork.press(fork.start, "z", "a").state;
    expect(fork.press(closed, "r").commands).toEqual([
      {
        kind: "set-read",
        ids: [fork.id("root"), fork.id("b1"), fork.id("c1"), fork.id("b2"), fork.id("b3")],
        read: true,
      },
    ]);
  });

  it("is not fooled by a closed fold the cursor merely sits inside", () => {
    // c1 is hidden by b1's fold but owns nothing, so r marks only c1.
    const closed = fork.press(fork.start, "j", "z", "a").state;
    const onC1: KeyState = { ...closed, cursorId: fork.id("c1") };
    expect(fork.press(onC1, "r").commands).toEqual([
      { kind: "set-read", ids: [fork.id("c1")], read: true },
    ]);
  });

  it("stops a fold-scoped mark at the end of a spine segment", () => {
    // s1's segment fold starts closed, so r marks s1 and its reply block —
    // never the segments that follow, which are its tree descendants.
    expect(spine.press(spine.start, "r").commands).toEqual([
      {
        kind: "set-read",
        ids: [spine.id("s1"), spine.id("x1"), spine.id("y1"), spine.id("y2")],
        read: true,
      },
    ]);
  });

  it("R unmarks the cursor's whole subtree, open or closed", () => {
    const onB1 = fork.press(fork.start, "j").state;
    expect(fork.press(onB1, "R").commands).toEqual([
      { kind: "set-read", ids: [fork.id("b1"), fork.id("c1")], read: false },
    ]);
    expect(spine.press(spine.start, "R").commands).toEqual([
      {
        kind: "set-read",
        ids: [spine.id("s1"), spine.id("x1"), spine.id("y1"), spine.id("y2")],
        read: false,
      },
    ]);
  });

  it("does nothing without a cursor", () => {
    const nowhere: KeyState = { ...fork.start, cursorId: null };
    expect(fork.press(nowhere, "r").commands).toEqual([]);
    expect(fork.press(nowhere, "R").commands).toEqual([]);
    expect(fork.press(nowhere, "r").handled).toBe(true);
  });
});

describe("help overlay", () => {
  const t = thread(FORK);

  it("? toggles and Escape closes", () => {
    const open = t.press(t.start, "?");
    expect(open.state.helpOpen).toBe(true);
    expect(t.press(open.state, "?").state.helpOpen).toBe(false);
    expect(t.press(open.state, "Escape").state.helpOpen).toBe(false);
    const closed = t.press(t.start, "Escape");
    expect(closed.state.helpOpen).toBe(false);
    expect(closed.handled).toBe(true);
  });

  it("Escape closes the overlay from inside a half-typed sequence", () => {
    // Decision: Escape always means cancel. The pending prefix does not get to
    // swallow it, so one press drops the prefix and closes the overlay.
    const help = t.press(t.start, "?").state;
    const escaped = t.press(help, "z", "Escape");
    expect(escaped.state.helpOpen).toBe(false);
    expect(escaped.state.pending).toBeNull();
    expect(escaped.handled).toBe(true);
  });

  it("Escape with nothing pending and nothing open leaves the state alone", () => {
    const quiet = t.press(t.start, "Escape");
    expect(quiet.state).toBe(t.start);
    expect(quiet.commands).toEqual([]);
    expect(quiet.handled).toBe(true);
  });
});

describe("the fold map", () => {
  const t = thread(DEEP, ["d1"]);

  it("writes every ancestor on a reveal, fold owner or not", () => {
    // Decision (reversed once, deliberately): opening a post's ancestry
    // writes EVERY ancestor, including b1, which owns no fold in this model.
    // Ownership is not stable across model rebuilds — a resume can turn a
    // plain ancestor into a closed-by-default segment fold, and the entry
    // written now is what keeps the revealed post visible then. An owner-only
    // version of this rule shipped in 7fa77ae and made deep-linked posts
    // vanish when a resume changed the topology (Codex review, finding 1).
    const jump = t.press(t.start, "n");
    expect(jump.state.cursorId).toBe(t.id("d1"));
    expect(foldEntries(jump.state)).toEqual(
      (
        [
          [t.id("root"), true],
          [t.id("b1"), true],
          [t.id("c1"), true],
        ] as [string, boolean][]
      ).sort(),
    );

    // l opens the ancestry by the same rule when it descends into a fold it
    // just closed.
    const onC1 = t.press(t.start, "j", "j").state;
    const reopened = t.press(onC1, "z", "a", "l");
    expect(reopened.state.cursorId).toBe(t.id("d1"));
    expect([...reopened.state.folds.keys()].sort()).toEqual(
      [t.id("root"), t.id("b1"), t.id("c1")].sort(),
    );
  });
});

describe("reveal and focus (zv / zx)", () => {
  const t = thread(SPINE);

  it("zv opens every ancestor of a hidden cursor and touches nothing else", () => {
    // A deep link can land the cursor behind a default-closed segment fold —
    // exactly what zv exists for.
    const hidden: KeyState = { ...t.start, cursorId: t.id("y1") };
    const result = t.press(hidden, "z", "v");
    expect(result.state.cursorId).toBe(t.id("y1"));
    expect(foldEntries(result.state)).toEqual(
      [
        [t.id("s1"), true],
        [t.id("x1"), true],
      ].sort() as [string, boolean][],
    );
    expect(t.visible(result.state)).toContain("y1");
    expect(t.visible(result.state)).not.toContain("x2");
    expect(result.commands).toEqual([scrollNearest]);
  });

  it("zx folds everything but the cursor's ancestry, in one atomic step", () => {
    // Both segment blocks open, cursor deep in the first.
    const open: KeyState = {
      ...t.start,
      cursorId: t.id("y1"),
      folds: new Map([
        [t.id("s1"), true],
        [t.id("s2"), true],
      ]),
    };
    const result = t.press(open, "z", "x");
    // The killer assertion: zM alone would re-home the cursor to the root;
    // zx must not, because the end state has the cursor visible.
    expect(result.state.cursorId).toBe(t.id("y1"));
    expect(t.visible(result.state)).toEqual(["s1", "x1", "y1", "y2", "s2", "s3"]);
    expect(foldEntries(result.state)).toEqual(
      [
        [t.id("s1"), true],
        [t.id("x1"), true],
        [t.id("s2"), false],
      ].sort() as [string, boolean][],
    );
    expect(result.commands).toEqual([scrollNearest, scrollCenter]);
  });

  it("both are quiet no-ops without a cursor", () => {
    const bare: KeyState = { ...t.start, cursorId: null };
    expect(foldEntries(t.press(bare, "z", "v").state)).toEqual([]);
    expect(foldEntries(t.press(bare, "z", "x").state)).toEqual([]);
  });
});

describe("purity", () => {
  it("never writes to the state it was handed", () => {
    const t = thread(FORK);
    const folds = t.start.folds;
    t.press(t.start, "z", "a");
    t.press(t.start, "j", "l");
    t.press(t.start, "z", "M");
    t.press(t.start, "n");
    expect(folds.size).toBe(0);
    expect(t.start.cursorId).toBe(t.id("root"));
    expect(t.start.helpOpen).toBe(false);
  });
});

describe("keys outside the map", () => {
  const t = thread(FORK);

  it("are left alone entirely", () => {
    for (const key of ["q", "1", "Tab", "F5", "/"]) {
      const result = t.press(t.start, key);
      expect(result.state).toBe(t.start);
      expect(result.commands).toEqual([]);
      expect(result.handled).toBe(false);
    }
  });
});

describe("the keymap and the help it generates", () => {
  const tokens = (keys: string): string[] =>
    keys
      .split(/\s*\/\s*|,\s*|\s{2,}/)
      .map((token) => token.trim())
      .filter((token) => token !== "");

  it("still reads exactly as the hand-written overlay did", () => {
    expect(HELP).toEqual([
      { keys: "j / k, ↓ / ↑", desc: "next / previous post" },
      { keys: "h / l, ← / →", desc: "parent / first reply" },
      { keys: "{ / }", desc: "previous / next sibling branch" },
      { keys: "n / N", desc: "next / previous unread (marks read)" },
      { keys: "r / R", desc: "mark read (fold-scoped) / mark unread + subtree" },
      { keys: "za  zo  zc", desc: "toggle / open / close fold" },
      { keys: "zO / zC", desc: "open / close subtree recursively" },
      { keys: "zR / zM", desc: "open / close all folds" },
      { keys: "zv / zx", desc: "reveal cursor's path / fold all but it" },
      { keys: "enter", desc: "toggle fold" },
      { keys: "gg / G", desc: "first / last post" },
      { keys: "zz", desc: "center current post" },
      { keys: "gx", desc: "open post on x.com" },
      { keys: "yy / Y", desc: "copy x.com link / app deep link" },
      { keys: "?", desc: "toggle this help" },
    ]);
  });

  it("lists every binding that claims a help row", () => {
    const listed = new Set(HELP.flatMap((row) => tokens(row.keys)));
    for (const binding of KEYMAP) {
      if (binding.help) expect(listed).toContain(binding.help.label);
    }
  });

  it("lists nothing the table does not bind", () => {
    const labels = new Set(KEYMAP.flatMap((binding) => (binding.help ? [binding.help.label] : [])));
    for (const row of HELP) {
      expect(row.keys).not.toBe("");
      for (const token of tokens(row.keys)) expect(labels).toContain(token);
    }
  });

  it("binds each sequence once, and never shadows a prefix with a plain key", () => {
    const seqs = KEYMAP.map((binding) => binding.seq.join(" "));
    expect(new Set(seqs).size).toBe(seqs.length);
    const prefixes = new Set(
      KEYMAP.filter((binding) => binding.seq.length === 2).map((binding) => binding.seq[0]),
    );
    for (const binding of KEYMAP) {
      if (binding.seq.length === 1) expect(prefixes).not.toContain(binding.seq[0]);
    }
  });
});

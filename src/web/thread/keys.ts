/**
 * The keyboard layer as a pure function.
 *
 * `applyKey` takes the keyboard state, a read-only view of the conversation,
 * and one normalized key, and returns the next state plus the side effects the
 * caller should perform. Nothing here touches the DOM, React, the clipboard or
 * the network — which is what makes the whole vim layer testable in plain
 * bun:test, and what keeps Thread.tsx down to a listener and a switch.
 */
import { appPath, xPostUrl } from "../../shared/urls";
import { isPrefix, lookup } from "./keymap";

/** The keyboard state the view renders from. */
export interface ViewState {
  readonly cursorId: string | null;
  /** Explicit fold decisions; absent means "whatever this post defaults to". */
  readonly folds: ReadonlyMap<string, boolean>;
  readonly helpOpen: boolean;
}

/** ViewState plus the half-typed key sequence, which nothing renders. */
export interface KeyState extends ViewState {
  readonly pending: string | null;
}

/**
 * Everything the reducer needs to know about the conversation, and nothing
 * else. Deliberately stated as lookups over post IDs rather than as the tree
 * itself: the render layer's memo soup satisfies this today (see
 * tree-model.ts) and a single-pass model can satisfy it tomorrow without the
 * keyboard layer noticing.
 */
export interface KeyModel {
  /** The conversation's root post — where `zM` sends the cursor. */
  readonly rootId: string;
  /** Post IDs in rendered order, with the contents of closed folds omitted. */
  readonly visible: readonly string[];
  /** Post IDs in rendered order as if every fold were open. */
  readonly allOrder: readonly string[];
  readonly unread: ReadonlySet<string>;
  /** All fold owners, for the two global fold commands. */
  readonly foldOwners: readonly string[];
  /** Whether the model knows this post at all. */
  has(id: string): boolean;
  /** The tree parent, or null for the root and for unknown posts. */
  parentOf(id: string): string | null;
  childrenOf(id: string): readonly string[];
  /** The author's handle, for building links. */
  authorHandle(id: string): string | undefined;
  /** Whether this post owns a fold (a chain head, fork tail, or segment). */
  isFoldOwner(id: string): boolean;
  /** Whether this post's fold starts closed (thread spine segments do). */
  startsClosed(id: string): boolean;
  /**
   * The IDs a post owns for scoped operations: its subtree, except that a
   * spine segment owns only itself and its reply blocks.
   */
  scopeIds(id: string): readonly string[];
}

export type ScrollMode = "center" | "nearest";

/**
 * A side effect for the caller to perform. `scroll-to-cursor` is a request
 * honored after the cursor moves and folds settle, not an immediate scroll;
 * `force` distinguishes the unread jump (which insists on centering) from
 * ordinary motion (which only asks if nothing louder already did).
 */
export type Command =
  | { readonly kind: "scroll-to-cursor"; readonly mode: ScrollMode; readonly force: boolean }
  | { readonly kind: "scroll-to-post"; readonly postId: string; readonly mode: ScrollMode }
  | { readonly kind: "set-read"; readonly ids: readonly string[]; readonly read: boolean }
  | { readonly kind: "copy"; readonly text: string }
  /** Copy a link to this app; the caller supplies the origin it is served from. */
  | { readonly kind: "copy-app-link"; readonly path: string }
  | { readonly kind: "open-url"; readonly url: string };

export interface KeyResult {
  readonly state: KeyState;
  readonly commands: readonly Command[];
  /** The key belonged to the keymap, so the caller suppresses the default. */
  readonly handled: boolean;
}

/** Bare modifier presses are not keys; they never reach the keymap. */
export function isModifierKey(key: string): boolean {
  return key === "Shift" || key === "Meta" || key === "Control" || key === "Alt";
}

/**
 * A KeyboardEvent's key as the keymap spells it. Shift is folded into the
 * character so `R` and `zC` are single table entries: browsers already report
 * the shifted character, but layouts and synthetic events don't always.
 */
export function normalizeKey(key: string, shiftKey: boolean): string {
  if (key === "/" && shiftKey) return "?";
  if (key.length === 1 && shiftKey && key >= "a" && key <= "z") return key.toUpperCase();
  return key;
}

export function applyKey(state: KeyState, model: KeyModel, key: string): KeyResult {
  // Every keystroke consumes any half-typed sequence, matching or not: `zj` is
  // not a `j`, it is nothing at all. Cancel is the one key that outranks the
  // sequence it interrupts, and looking it up with no prefix is what makes it
  // one: `z` then Escape is an Escape, not a dropped `z`.
  const pending = state.pending;
  const command = lookup(null, key) === "cancel" ? "cancel" : lookup(pending, key);
  if (command === null) {
    if (pending === null && isPrefix(key)) {
      return { state: { ...state, pending: key }, commands: [], handled: true };
    }
    const cleared = settle(state, state.cursorId, state.folds, state.helpOpen);
    return { state: cleared, commands: [], handled: false };
  }

  let cursorId = state.cursorId;
  let folds = state.folds;
  let helpOpen = state.helpOpen;
  const commands: Command[] = [];
  let handled = true;

  const cursor = cursorId !== null && model.has(cursorId) ? cursorId : null;
  const visIdx = cursorId === null ? -1 : model.visible.indexOf(cursorId);

  const isOpen = (id: string): boolean => folds.get(id) ?? !model.startsClosed(id);
  /** The fold that hides a post: itself if it owns one, else the nearest ancestor's. */
  const ownedBy = (id: string): string | null => {
    let current: string | null = id;
    while (current !== null) {
      if (model.isFoldOwner(current)) return current;
      current = model.parentOf(current);
    }
    return null;
  };
  const requestScroll = (mode: ScrollMode, force = false): void => {
    commands.push({ kind: "scroll-to-cursor", mode, force });
  };
  const moveCursor = (id: string | undefined): void => {
    if (!id) return;
    requestScroll("nearest");
    cursorId = id;
  };
  const setFold = (id: string, open: boolean): void => {
    folds = new Map(folds).set(id, open);
  };
  // The two halves of a fold from the keyboard. Both scroll the cursor into
  // view — mouse fold changes never scroll — and they part ways on the cursor:
  // opening reveals posts and moves nothing.
  const openFold = (id: string): void => {
    requestScroll("nearest");
    setFold(id, true);
  };
  /**
   * Close a fold and take the cursor with it. A fold hides its contents but
   * never its owner, so the owner is where the cursor can still be seen —
   * vim's rule that a line folding away leaves the cursor on the fold line.
   * Every keyboard close goes through here, so none of them can strand the
   * cursor on a post nobody can see.
   */
  const closeFold = (id: string): void => {
    setFold(id, false);
    moveCursor(id);
  };
  /**
   * Open every fold between a post and the root, so the post is on screen.
   *
   * EVERY ancestor is written, owner of a fold today or not. Ownership is not
   * stable over the map's lifetime: this model is one snapshot of a
   * conversation that can gain posts, and a resume that materializes a
   * missing spine post turns a plain ancestor into a segment fold that
   * defaults closed. The entry written here is what keeps the revealed post
   * visible through that transition — an owner-only "hygiene" version of this
   * loop shipped once and made deep-linked posts vanish on resume (Codex
   * review of 7fa77ae, finding 1). An entry for a post that never becomes an
   * owner is never read; that is the cheap side of this trade.
   */
  const openAncestors = (id: string): void => {
    const next = new Map(folds);
    let current = model.parentOf(id);
    while (current !== null) {
      next.set(current, true);
      current = model.parentOf(current);
    }
    folds = next;
  };
  const jumpUnread = (dir: 1 | -1): void => {
    if (model.unread.size === 0 || model.allOrder.length === 0) return;
    const idx = cursorId === null ? -1 : model.allOrder.indexOf(cursorId);
    for (let step = 1; step <= model.allOrder.length; step++) {
      const i = (idx + dir * step + model.allOrder.length * step) % model.allOrder.length;
      const id = model.allOrder[i]!;
      if (model.unread.has(id)) {
        openAncestors(id);
        requestScroll("center", true);
        cursorId = id;
        commands.push({ kind: "set-read", ids: [id], read: true });
        return;
      }
    }
  };
  /**
   * Every fold in the cursor's scope, at once. Closing one cannot hide the
   * cursor: every fold this touches is the cursor's own or a descendant's, and
   * a fold hides its contents but never its owner.
   */
  const foldScope = (open: boolean): void => {
    if (cursor === null) return;
    requestScroll("nearest");
    const next = new Map(folds);
    for (const id of model.scopeIds(cursor)) {
      if (model.isFoldOwner(id)) next.set(id, open);
    }
    folds = next;
  };
  const foldAll = (open: boolean): void => {
    requestScroll("nearest");
    folds = new Map(model.foldOwners.map((id) => [id, open]));
  };
  /**
   * The nearest ancestor of a post that is on screen — the post itself when it
   * already is. The root is always visible, so this answers for every post the
   * model knows.
   */
  const nearestVisible = (id: string): string | undefined => {
    let current: string | null = id;
    while (current !== null) {
      if (model.visible.includes(current)) return current;
      current = model.parentOf(current);
    }
    return undefined;
  };
  /**
   * Where a j or k lands: one step along the visible order, clamped at both
   * ends — the clamp is why a j at the bottom still nudges the scroll.
   *
   * Unless the cursor is not on that list at all, which happens when something
   * closed a fold over it. Then the keypress only re-anchors: it lands on the
   * nearest ancestor still on screen and does not also advance, so the first
   * key after a cursor goes behind a fold is a step back into view rather than
   * a jump to the top of the thread.
   */
  const lineStep = (dir: 1 | -1): string | undefined => {
    if (cursor !== null && visIdx === -1) return nearestVisible(cursor);
    return model.visible[Math.min(Math.max(visIdx + dir, 0), model.visible.length - 1)];
  };
  /** Walk out through ancestors until one of them has a sibling in `dir`. */
  const siblingCursor = (dir: 1 | -1): void => {
    let current = cursorId;
    while (current !== null) {
      const parentId = model.parentOf(current);
      const siblings = parentId === null ? [] : model.childrenOf(parentId);
      const sibling = siblings[siblings.indexOf(current) + dir];
      if (sibling !== undefined) {
        moveCursor(sibling);
        return;
      }
      current = parentId;
    }
  };

  switch (command) {
    case "cursor-next":
      moveCursor(lineStep(1));
      break;
    case "cursor-prev":
      moveCursor(lineStep(-1));
      break;
    case "cursor-parent": {
      const parent = cursorId === null ? null : model.parentOf(cursorId);
      if (parent) moveCursor(parent);
      break;
    }
    case "cursor-child": {
      const target = cursorId === null ? undefined : model.childrenOf(cursorId)[0];
      if (!target) break;
      if (!model.visible.includes(target)) openAncestors(target);
      moveCursor(target);
      break;
    }
    case "cursor-sibling-prev":
      siblingCursor(-1);
      break;
    case "cursor-sibling-next":
      siblingCursor(1);
      break;
    case "cursor-first":
      moveCursor(model.visible[0]);
      break;
    case "cursor-last":
      moveCursor(model.visible[model.visible.length - 1]);
      break;
    case "unread-next":
      jumpUnread(1);
      break;
    case "unread-prev":
      jumpUnread(-1);
      break;
    case "mark-read": {
      if (cursor === null) break;
      // A closed fold's owner stands for everything it hides, so marking it
      // read marks the whole scope; an open post speaks only for itself.
      const folded = !isOpen(cursor) && model.isFoldOwner(cursor);
      const ids = folded ? model.scopeIds(cursor) : [cursor];
      commands.push({ kind: "set-read", ids, read: true });
      break;
    }
    case "mark-unread":
      if (cursor !== null) {
        commands.push({ kind: "set-read", ids: model.scopeIds(cursor), read: false });
      }
      break;
    case "fold-toggle": {
      const owner = cursorId === null ? null : ownedBy(cursorId);
      if (owner === null) break;
      if (isOpen(owner)) closeFold(owner);
      else openFold(owner);
      break;
    }
    case "fold-open": {
      const owner = cursorId === null ? null : ownedBy(cursorId);
      if (owner) openFold(owner);
      break;
    }
    case "fold-close": {
      const owner = cursorId === null ? null : ownedBy(cursorId);
      if (owner) closeFold(owner);
      break;
    }
    case "fold-open-subtree":
      foldScope(true);
      break;
    case "fold-close-subtree":
      foldScope(false);
      break;
    case "fold-open-all":
      foldAll(true);
      break;
    case "fold-close-all":
      foldAll(false);
      // Everything else just went behind a fold; only the root is left to sit on.
      moveCursor(model.rootId);
      break;
    case "center-cursor":
      if (cursorId !== null) {
        commands.push({ kind: "scroll-to-post", postId: cursorId, mode: "center" });
      }
      break;
    case "open-on-x":
      // With no cursor there is nothing to open, and the key stays the
      // browser's — as it has always been for the two link commands.
      if (cursor === null) handled = false;
      else commands.push({ kind: "open-url", url: xPostUrl(model.authorHandle(cursor), cursor) });
      break;
    case "copy-x-link":
      if (cursor === null) handled = false;
      else commands.push({ kind: "copy", text: xPostUrl(model.authorHandle(cursor), cursor) });
      break;
    case "copy-app-link":
      if (cursor !== null) {
        commands.push({ kind: "copy-app-link", path: appPath(model.authorHandle(cursor), cursor) });
      }
      break;
    case "help-toggle":
      helpOpen = !helpOpen;
      break;
    case "cancel":
      // Whatever is half-typed is already dropped by the time we get here (the
      // state settles with no pending key), so cancelling is just this.
      helpOpen = false;
      break;
    default:
      // A binding whose command has no case here is a type error, not a key
      // that quietly does nothing.
      return assertNever(command);
  }

  return { state: settle(state, cursorId, folds, helpOpen), commands, handled };
}

function assertNever(value: never): never {
  throw new Error(`unhandled command: ${String(value)}`);
}

/**
 * Reuse the previous state when nothing moved. Identity is the signal the view
 * re-renders on, and a keystroke that did nothing must not re-render a
 * thousand posts.
 */
function settle(
  previous: KeyState,
  cursorId: string | null,
  folds: ReadonlyMap<string, boolean>,
  helpOpen: boolean,
): KeyState {
  if (
    previous.pending === null &&
    previous.cursorId === cursorId &&
    previous.folds === folds &&
    previous.helpOpen === helpOpen
  ) {
    return previous;
  }
  return { cursorId, folds, helpOpen, pending: null };
}

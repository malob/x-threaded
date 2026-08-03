import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConversationResponse, Post } from "../shared/types";
import { PostView } from "./PostView";
import { formatUsd } from "../shared/pricing";
import { xPostUrl } from "../shared/urls";
import { HELP } from "./thread/keymap";
import { applyKey, isModifierKey, normalizeKey, type Command, type ViewState } from "./thread/keys";
import {
  buildThread,
  emptyKeyModel,
  type Branch,
  type GapNode,
  type PostNode,
  type Segment,
  type ThreadModel,
  type ThreadNode,
} from "./thread/model";

/**
 * Everything a card needs that does not change while a conversation is open:
 * the built model, the posts it quotes, and handlers whose identity is fixed
 * for the life of the mount. Kept apart from the view state below on purpose —
 * a context re-renders every consumer when its value changes, so anything that
 * changes per keystroke living in here would make the memoized cards useless.
 */
interface ThreadCtx {
  readonly model: ThreadModel;
  readonly quoted: Record<string, Post>;
  readonly setFold: (id: string, open: boolean) => void;
  readonly setCursor: (id: string) => void;
  /** Write a fold-owner id here from a control's event handler to move
      keyboard focus to that fold's mark after the next fold-state commit —
      the pressed control unmounts when its subtree flips form, and without
      this the SECOND Enter lands on the document and runs the global
      fold-toggle instead (Codex delta review, finding 2). A raw ref because
      the hooks compiler only permits ref writes inside event handlers. */
  readonly focusFoldRef: { current: string | null };
}

/** The parts that do change: where the cursor is, what is unread, what is folded. */
interface ViewCtx {
  readonly cursorId: string | null;
  readonly unread: ReadonlySet<string>;
  readonly isOpen: (id: string) => boolean;
}

const ThreadContext = createContext<ThreadCtx | null>(null);
const ViewContext = createContext<ViewCtx | null>(null);

function useThread(): ThreadCtx {
  const ctx = useContext(ThreadContext);
  if (!ctx) throw new Error("thread card rendered outside a Thread");
  return ctx;
}

function useView(): ViewCtx {
  const ctx = useContext(ViewContext);
  if (!ctx) throw new Error("thread card rendered outside a Thread");
  return ctx;
}

/** Unread posts in the subtrees of a set of siblings — what a fold hides. */
function unreadUnder(
  nodes: readonly ThreadNode[],
  model: ThreadModel,
  unread: ReadonlySet<string>,
): number {
  return nodes.reduce((sum, node) => sum + model.unreadCount(node.id, unread), 0);
}

function NewBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="new-badge"> · {count} new</span>;
}

/**
 * A post we never got: its ID is real, so x.com can still resolve it.
 *
 * The bead is the notice (l): a dashed disc stands in the lane where the node
 * would be, so the line arrives at something and the reader can see what is
 * missing. It carries no unread ring — there is nothing to read — but the
 * cursor may rest here (m), which the shared `.post` bed handles for free.
 *
 * Memoized, like every card: `node` is stable for the life of the model, so a
 * gap only re-renders when the cursor arrives at it or leaves it.
 */
const GapCard = memo(function GapCard({ node, cursor }: { node: GapNode; cursor: boolean }) {
  const { setCursor } = useThread();
  return (
    <div
      id={`post-${node.id}`}
      className={cursor ? "post placeholder-post cursor" : "post placeholder-post"}
      title={
        node.placementInferred
          ? "Position inferred from reply counts"
          : "Replied somewhere in this conversation; exact position unknown"
      }
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a, button")) setCursor(node.id);
      }}
    >
      <div className="post-lane">
        <span className="bead-gap" />
      </div>
      <div className="post-body">
        unavailable post (deleted or private) ·{" "}
        <a href={xPostUrl(undefined, node.id)} target="_blank" rel="noopener noreferrer">
          view on x.com ↗
        </a>
      </div>
    </div>
  );
});

/**
 * The expensive component in the app, and the one the memo boundary exists
 * for: everything below it — text with entities, media, quote cards, the
 * clamp measurement — is skipped entirely unless one of these three props
 * changed. `node` comes from the model, which is built once per conversation.
 */
const RealPostCard = memo(function RealPostCard({
  node,
  cursor,
  unread,
}: {
  node: PostNode;
  cursor: boolean;
  unread: boolean;
}) {
  const { model, quoted, setCursor } = useThread();
  const { post } = node;
  const hidden = model.hiddenReplies.get(post.id) ?? 0;
  return (
    <PostView
      post={post}
      quoted={quoted}
      displayText={node.displayText}
      id={`post-${post.id}`}
      className={cursor ? "post cursor" : "post"}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a, button")) setCursor(post.id);
      }}
      unread={unread}
      /**
       * The deficit note is prose (k) and it is METADATA, so it rides the end
       * of the footer line (owner ruling, s-footer) — never a block between
       * the post and its children, where it would open a hole in the line.
       */
      footerNote={
        hidden > 0 ? (
          <span
            className="hidden-replies"
            title="Deleted, from a private account, or not returned by the API"
          >
            {hidden} {hidden === 1 ? "reply" : "replies"} not available
          </span>
        ) : undefined
      }
    />
  );
});

/**
 * Where the view state meets a card. This is the only thing a cursor move
 * re-renders per post, and it is three lines: it reads the changing context
 * and turns "where the cursor is" into "is it me", which is a boolean the
 * memoized card below can compare. Two of those booleans flip per keystroke,
 * so two cards render and the rest bail out.
 */
function PostCard({ node }: { node: ThreadNode }) {
  const { cursorId, unread } = useView();
  return node.kind === "gap" ? (
    <GapCard node={node} cursor={node.id === cursorId} />
  ) : (
    <RealPostCard node={node} cursor={node.id === cursorId} unread={unread.has(node.id)} />
  );
}

/**
 * Where a limb sits on the line it hangs from, which is the only thing the
 * connector needs a component to tell it: a fork child elbows back one fork
 * step to its parent's line, a fork child with siblings below it also carries
 * that line down past its own subtree, a run child continues straight, and a
 * root starts one.
 */
type Place = "root" | "fork" | "through" | "run";

const LIMB: Record<Place, string> = {
  root: "limb",
  fork: "limb is-fork",
  through: "limb is-fork is-through",
  run: "limb is-run",
};

/**
 * `drops` means the line goes on below this post's bead — because a block
 * hangs there, open or folded. It is the one thing a limb knows that CSS
 * cannot ask, since the answer is about the post's children, not its box.
 */
function limbClass(place: Place, drops: boolean): string {
  return drops ? `${LIMB[place]} drops` : LIMB[place];
}

/**
 * The ⊖/⊕ disc standing ON the owner's line, at the station where the content
 * it hides attaches (s). It never moves across the toggle: open and closed
 * derive the same anchor from the same tokens, so pressing it does not make
 * the eye re-find it.
 */
function FoldMark({
  open,
  owner,
  onToggle,
}: {
  open: boolean;
  owner: string;
  onToggle: () => void;
}) {
  const { focusFoldRef } = useThread();
  const label = open ? "Collapse replies" : "Expand replies";
  return (
    <button
      className="mark"
      data-fold={owner}
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={() => {
        focusFoldRef.current = owner;
        onToggle();
      }}
    >
      <span className={open ? "mk" : "mk plus"} />
    </button>
  );
}

/**
 * (h-amend) The scope's own line is the handle's extended body: a widened
 * invisible strip laid along it, because a 2px line is a target only in
 * principle. It is the mark's control reached by a second hand — same handler,
 * never a second code path — and it stays out of the tab order, so one fold is
 * one tab stop. A button because the row's click-to-select guard reads
 * `closest("a, button")`.
 */
function LineGrab({
  onToggle,
  reach,
  tail,
}: {
  onToggle: () => void;
  reach?: boolean;
  tail?: boolean;
}) {
  const cls = tail ? "line-grab lg-reach lg-tail" : reach ? "line-grab lg-reach" : "line-grab";
  return <button className={cls} tabIndex={-1} aria-hidden="true" onClick={onToggle} />;
}

/**
 * The ghost (s): the count standing exactly where the first hidden avatar
 * would have stood, at the end of the line that continues past the ⊕. No
 * caret — the mark owns the verb — and no "· k new" when there is none.
 */
function GhostChip({
  n,
  k,
  owner,
  onToggle,
}: {
  n: number;
  k: number;
  owner: string;
  onToggle: () => void;
}) {
  const { focusFoldRef } = useThread();
  return (
    <button
      className="chip"
      tabIndex={-1}
      aria-hidden="true"
      onClick={() => {
        focusFoldRef.current = owner;
        onToggle();
      }}
    >
      {/* One text run inside, so the count keeps its own spacing: as separate
          flex items the space before the separator is eaten and "3 replies ·
          1 new" reads "3 replies ·1 new". */}
      <span>
        {n} {n === 1 ? "reply" : "replies"}
        <NewBadge count={k} />
      </span>
    </button>
  );
}

/**
 * A folded block: the mark at its station and the ghost beside it, with the
 * owner's line running from the block's top past the ⊕ and turning into the
 * chip's seat. `run` picks the station a chain head has — a run's line is
 * short, so its mark sits in the middle of that shorter stretch.
 */
function FoldStub({
  n,
  k,
  owner,
  run,
  onToggle,
}: {
  n: number;
  k: number;
  owner: string;
  run?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={run ? "kids stub owns-run" : "kids stub"}>
      <FoldMark open={false} owner={owner} onToggle={onToggle} />
      <GhostChip n={n} k={k} owner={owner} onToggle={onToggle} />
    </div>
  );
}

/**
 * A branch as the model decomposed it: a run of single-child posts drawn as
 * beads on one straight line under the head, then the fork that ended the run
 * rendered as one collapsible block. Fold state lives in the view context,
 * keyed by the owning post: the chain's head, the fork's tail.
 *
 * The forks hang inside the last run post's limb rather than beside the run,
 * because that is where they hang in the tree — and it is what makes the
 * drawing come out with no measurement: every line is either a limb's own
 * elbow or its parent's, and both are written against the same bead centre.
 */
function BranchView({ branch, place }: { branch: Branch; place: Place }) {
  const { model, setFold } = useThread();
  const { unread, isOpen } = useView();
  const { head, rest, tail, forks } = branch;
  const branches = forks.length > 0 && <CollapsibleChildren ownerId={tail.id} branches={forks} />;
  const limb = limbClass(place, rest.length > 0 || forks.length > 0);
  /* The drop beside the owner's OWN body — bead's 6 o'clock down to where the
     block begins — is the same handle as the block's line (h-amend), but the
     block's strip cannot reach above its own box. The reach strip covers it
     (owner caught the dead stretch live). */
  const reach = (id: string) => (
    <LineGrab reach onToggle={() => setFold(id, !isOpen(id))} />
  );

  if (rest.length === 0) {
    return (
      <div className={limb}>
        {forks.length > 0 && reach(tail.id)}
        <PostCard node={head} />
        {branches}
      </div>
    );
  }
  if (!isOpen(head.id)) {
    return (
      <div className={limb}>
        {reach(head.id)}
        <PostCard node={head} />
        <FoldStub
          run
          owner={head.id}
          n={model.subtreeSize(head.id) - 1}
          k={unreadUnder(head.children, model, unread)}
          onToggle={() => setFold(head.id, true)}
        />
      </div>
    );
  }
  return (
    <div className={limb}>
      {reach(head.id)}
      <PostCard node={head} />
      <div className="kids run">
        <FoldMark open owner={head.id} onToggle={() => setFold(head.id, false)} />
        <LineGrab onToggle={() => setFold(head.id, false)} />
        {rest.map((node, i) => {
          const last = i === rest.length - 1;
          const feedsForks = last && forks.length > 0;
          return (
            <div key={node.id} className={limbClass("run", !last || forks.length > 0)}>
              {/* The run's line is one handle end to end (h-amend): every
                  inter-bead stretch carries its own strip segment, all hands
                  of the head's fold (Codex packet review, finding 2) — and
                  each bead's body-side drop likewise, except the tail's,
                  whose drop feeds the FORK block and is that fold's hand. */}
              <LineGrab onToggle={() => setFold(head.id, false)} />
              {feedsForks ? (
                <LineGrab reach tail onToggle={() => setFold(tail.id, !isOpen(tail.id))} />
              ) : (
                !last && <LineGrab reach onToggle={() => setFold(head.id, false)} />
              )}
              <PostCard node={node} />
              {last && branches}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A post's replies as one block on a single line: the ⊖ at the station under
 * the owner's bead folds the whole block, and so does the line itself.
 * Children elbow off that line, the last one's ╰ ends it. Nested reply blocks
 * get their own station one fork step right.
 */
function CollapsibleChildren({
  ownerId,
  branches,
}: {
  ownerId: string;
  branches: readonly Branch[];
}) {
  const { model, setFold } = useThread();
  const { unread, isOpen } = useView();
  const open = isOpen(ownerId);
  const toggle = () => setFold(ownerId, !open);
  if (!open) {
    return (
      <FoldStub
        owner={ownerId}
        n={branches.reduce((sum, branch) => sum + model.subtreeSize(branch.head.id), 0)}
        k={unreadUnder(branches.map((branch) => branch.head), model, unread)}
        onToggle={toggle}
      />
    );
  }
  return (
    <div className="kids fork">
      <FoldMark open owner={ownerId} onToggle={toggle} />
      <LineGrab onToggle={toggle} />
      {branches.map((branch, i) => (
        <BranchView
          key={branch.head.id}
          branch={branch}
          place={i < branches.length - 1 ? "through" : "fork"}
        />
      ))}
    </div>
  );
}

/**
 * A spine segment's replies.
 *
 * MID-THREAD they bundle onto a take-off (i, i-why): the trunk sprouts one
 * arm, a sub-line drops from it one fork step right, and the replies elbow off
 * THAT — so the trunk runs clean and unbroken past the whole block to the next
 * segment bead, and "thread, or reply?" never has to be read. The station is
 * the arm, because that is where the foldable content attaches; closed, the
 * arm runs straight on into the ghost standing where the sub-line was
 * (s-amend). One render path: a single-branch block bundles too.
 *
 * The FINAL segment has no continuation to protect (i-amend), so its replies
 * attach directly and the last ╰ ends the trunk — which is exactly an ordinary
 * fork tail's block, and is rendered as one.
 */
function SegmentReplies({ segment, final }: { segment: Segment; final: boolean }) {
  const { model, setFold } = useThread();
  const { unread, isOpen } = useView();
  const ownerId = segment.node.id;
  if (final) return <CollapsibleChildren ownerId={ownerId} branches={segment.replies} />;
  const open = isOpen(ownerId);
  const toggle = () => setFold(ownerId, !open);
  if (!open) {
    return (
      <div className="kids takeoff is-collapsed">
        <FoldMark open={false} owner={ownerId} onToggle={toggle} />
        <GhostChip
          n={segment.replies.reduce((sum, reply) => sum + model.subtreeSize(reply.head.id), 0)}
          k={unreadUnder(segment.replies.map((reply) => reply.head), model, unread)}
          owner={ownerId}
          onToggle={toggle}
        />
      </div>
    );
  }
  return (
    <div className="kids takeoff">
      <span className="tee" aria-hidden="true">
        <span className="tee-arc" />
      </span>
      <FoldMark open owner={ownerId} onToggle={toggle} />
      <LineGrab onToggle={toggle} />
      {segment.replies.map((reply, i) => (
        <BranchView
          key={reply.head.id}
          branch={reply}
          place={i < segment.replies.length - 1 ? "through" : "fork"}
        />
      ))}
    </div>
  );
}

interface ThreadProps {
  conversation: ConversationResponse;
  refreshing: boolean;
  resuming: boolean;
  newCount: number | null;
  onRefresh: () => void;
  onResume: () => void;
  onSetRead: (ids: string[], read: boolean) => void;
  onMarkAllRead: () => void;
}

export function Thread({
  conversation,
  refreshing,
  resuming,
  newCount,
  onRefresh,
  onResume,
  onSetRead,
  onMarkAllRead,
}: ThreadProps) {
  /**
   * The whole conversation, built once. Everything the view and the keyboard
   * need is materialized in here; the only things derived per render are the
   * two that depend on state the model doesn't own — the fold-dependent
   * visible order, and the keyboard's read-only view of it.
   */
  const model = useMemo(
    () =>
      buildThread(conversation.rootId, conversation.posts, {
        // Reply-count deficits are meaningless when the fetch was capped.
        truncated: conversation.truncated,
      }),
    [conversation.rootId, conversation.posts, conversation.truncated],
  );

  /**
   * Cursor, folds and help live together because the keyboard reducer moves
   * them together (src/web/thread/keys.ts). The half-typed key sequence stays
   * out: it is keyboard state, but nothing renders it, and routing it through
   * setState would re-render every post the moment you press `z`.
   */
  const [view, setView] = useState<ViewState>(() => ({
    cursorId: null,
    folds: new Map(),
    helpOpen: false,
  }));
  const { cursorId, folds, helpOpen } = view;
  const pendingRef = useRef<string | null>(null);
  /**
   * Scroll-to-cursor happens only when something explicitly requests it
   * (keyboard motions, unread jumps, deep-link focus) — never as a side
   * effect of fold or cursor state changing, so mouse clicks don't yank the
   * viewport back to the cursor.
   */
  const scrollRequestRef = useRef<ScrollLogicalPosition | null>(null);

  useEffect(() => {
    // A deep-linked focus post may sit behind closed folds; open its ancestry.
    // EVERY ancestor is written, fold owner or not, same rule as the
    // keyboard's openAncestors (thread/keys.ts): ownership is not stable
    // across model rebuilds — a resume can turn a plain ancestor into a
    // closed-by-default segment fold, and the entry written now is what keeps
    // the focus visible then (Codex review of 7fa77ae, finding 1).
    const opened = new Map<string, boolean>();
    if (conversation.focusId) {
      let current = model?.parents.get(conversation.focusId) ?? null;
      while (current !== null) {
        opened.set(current, true);
        current = model?.parents.get(current) ?? null;
      }
      scrollRequestRef.current = "center";
    }
    // A navigation also discards any half-typed key sequence: a `z` pressed
    // before following a link must not turn the first keystroke afterwards
    // into `za` (Codex review of 7fa77ae, finding 2).
    pendingRef.current = null;
    // Resetting the view is the whole point of this effect: a different
    // conversation must start from its own folds and cursor. The rule wants
    // that expressed as a remount key, which is the caller's decision to make,
    // not ours.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView((prev) => ({
      ...prev,
      folds: opened,
      cursorId: conversation.focusId ?? conversation.rootId,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.rootId, conversation.focusId]);

  useEffect(() => {
    // A refresh can rebuild the model so the post under the cursor lands
    // inside a closed-by-default fold — e.g. an adopted orphan that held a
    // spine seat in the cached model loses it when the genuine continuation
    // arrives, and drops into the root segment's closed reply block (Codex
    // review of the adoption fix, finding 1 — the same temporal-ownership
    // class as 7fa77ae). Same remedy as a deep link: open EVERY ancestor of
    // the cursor, owner or not, so the cursor is never invisible.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView((prev) => {
      if (!model || !prev.cursorId) return prev;
      if (model.visibleIds(prev.folds).includes(prev.cursorId)) return prev;
      const folds = new Map(prev.folds);
      let current = model.parents.get(prev.cursorId) ?? null;
      while (current !== null) {
        folds.set(current, true);
        current = model.parents.get(current) ?? null;
      }
      return { ...prev, folds };
    });
  }, [model]);

  /* STALE-HOVER PARKING. Browsers keep :hover flags on elements that move
     under a stationary pointer until the next real pointer event — so after
     a click-fold, surviving elements can keep painting fragments of the
     preview ink with the mouse over nothing (owner caught it). On every fold
     commit the thread parks its hover ink (CSS: .hover-parked resolves the
     preview ink to rest ink); the first real pointer move unparks, which is
     also exactly when the browser recomputes hover for real. */
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.classList.add("hover-parked");
    const unpark = () => el.classList.remove("hover-parked");
    window.addEventListener("pointermove", unpark, { once: true });
    return () => window.removeEventListener("pointermove", unpark);
  }, [folds]);

  /* Focus follows the fold: the control the reader pressed unmounts when its
     subtree flips open/closed, so after the commit, focus lands on the new
     mark at the same station — before paint, so nothing flashes. preventScroll
     honors the mouse-never-scrolls discipline. */
  useLayoutEffect(() => {
    const id = focusFoldRef.current;
    if (!id) return;
    focusFoldRef.current = null;
    document
      .querySelector<HTMLButtonElement>(`button.mark[data-fold="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true });
  }, [folds]);

  useEffect(() => {
    const mode = scrollRequestRef.current;
    if (!mode || !cursorId) return;
    scrollRequestRef.current = null;
    document
      .getElementById(`post-${cursorId}`)
      ?.scrollIntoView({ block: mode, behavior: "auto" });
  }, [cursorId, folds]);

  const unread = useMemo(() => new Set(conversation.unreadIds), [conversation.unreadIds]);

  // A snapshot for the console, taken after the render it describes.
  useEffect(() => {
    if (!import.meta.env.DEV && !localStorage.getItem("xdbg")) return;
    (window as { __xdbg?: unknown }).__xdbg = {
      cursorId,
      spine: model?.spine.map((segment) => segment.id) ?? [],
      segmentFolds: [...(model?.segmentFolds ?? [])],
      branchFolds: [...(model?.branchFolds ?? [])],
      folds: [...folds.entries()],
    };
  }, [cursorId, model, folds]);

  const visible = useMemo(() => model?.visibleIds(folds) ?? [], [model, folds]);

  /**
   * Stable for the life of the mount — they only ever call the state updater
   * with a function, so they need nothing from the render that created them.
   * That is what keeps the context below from changing, and the cards from
   * re-rendering when it would have.
   */
  const setCursor = useCallback((id: string) => {
    setView((prev) => ({ ...prev, cursorId: id }));
  }, []);
  const toggleHelp = () => {
    setView((prev) => ({ ...prev, helpOpen: !prev.helpOpen }));
  };

  const keyModel = useMemo(
    () => model?.keyModel(visible, unread) ?? emptyKeyModel(conversation.rootId),
    [model, visible, unread, conversation.rootId],
  );

  /**
   * The keydown listener is registered once and reads the current render
   * through this ref, instead of being torn down and re-registered on every
   * render — which used to include every keystroke. A layout effect refreshes
   * it, so it is current before anything can be typed.
   */
  const latest = useRef({ view, model: keyModel, onSetRead });
  useLayoutEffect(() => {
    latest.current = { view, model: keyModel, onSetRead };
  });

  useEffect(() => {
    const execute = (command: Command, setRead: (ids: string[], read: boolean) => void): void => {
      switch (command.kind) {
        case "scroll-to-cursor":
          // A request, honored once the cursor and folds have settled. Only an
          // insistent one (the unread jump) overrides a request already made.
          if (command.force) scrollRequestRef.current = command.mode;
          else scrollRequestRef.current ??= command.mode;
          break;
        case "scroll-to-post":
          document
            .getElementById(`post-${command.postId}`)
            ?.scrollIntoView({ block: command.mode });
          break;
        case "set-read":
          setRead([...command.ids], command.read);
          break;
        case "copy":
          void navigator.clipboard.writeText(command.text);
          break;
        case "copy-app-link":
          void navigator.clipboard.writeText(`${location.origin}${command.path}`);
          break;
        case "open-url":
          window.open(command.url, "_blank", "noopener");
          break;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      // A key aimed at a form control is that control's, not ours. Targets are
      // only Elements when the event came from the document's tree: a keydown
      // dispatched on `window` carries a non-Element target, which is simply
      // not inside an input rather than a reason to give up on the event.
      const target = e.target;
      const typing = target instanceof Element && target.closest("input, textarea, select") !== null;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isModifierKey(e.key)) return;
      // A focused control keeps its native activation: Enter on a tabbed-to
      // fold mark must press THAT mark, and Enter on a tabbed-to link must
      // FOLLOW it (Codex packet review + delta review) — not run the
      // cursor's fold-toggle. Space stays button-only: on a link, native
      // Space scrolls, and that should keep working. Every other key stays
      // global — focus sitting on a control is no reason for j/k to die.
      const focused = document.activeElement;
      if (
        (e.key === "Enter" &&
          (focused instanceof HTMLButtonElement || focused instanceof HTMLAnchorElement)) ||
        (e.key === " " && focused instanceof HTMLButtonElement)
      )
        return;
      const { view: current, model, onSetRead: setRead } = latest.current;
      const { state, commands, handled } = applyKey(
        { ...current, pending: pendingRef.current },
        model,
        normalizeKey(e.key, e.shiftKey),
      );
      pendingRef.current = state.pending;
      if (
        state.cursorId !== current.cursorId ||
        state.folds !== current.folds ||
        state.helpOpen !== current.helpOpen
      ) {
        setView({ cursorId: state.cursorId, folds: state.folds, helpOpen: state.helpOpen });
      }
      for (const command of commands) execute(command, setRead);
      if (handled) e.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* See ThreadCtx.focusFold. A ref, not state: recording intent must not
     render anything. */
  const focusFoldRef = useRef<string | null>(null);

  const setFold = useCallback((id: string, open: boolean) => {
    setView((prev) => {
      // A closing fold hides everything inside it. When that includes the
      // cursor, the cursor comes out to the fold's owner — which stays
      // visible; when it doesn't, the cursor stays where the reader left it,
      // because collapsing an unrelated branch is not a statement about where
      // you are. Scope membership is read through the `latest` ref (declared
      // above; the hooks compiler requires
      // the ref to exist before a callback captures it), so this stays
      // dependency-free and the stable context stays stable. No scroll
      // request either way; mouse actions never move the viewport.
      const hidden =
        !open &&
        prev.cursorId !== null &&
        prev.cursorId !== id &&
        latest.current.model.scopeIds(id).includes(prev.cursorId);
      return {
        ...prev,
        folds: new Map(prev.folds).set(id, open),
        cursorId: hidden ? id : prev.cursorId,
      };
    });
  }, []);

  /**
   * Two contexts, split by how often they change. The stable half is what
   * makes `React.memo` on the cards mean anything: if the handlers or the
   * model moved with the cursor, every card would re-render as a context
   * consumer no matter what its props said.
   */
  const ctx = useMemo(
    () => model && { model, quoted: conversation.quoted, setFold, setCursor, focusFoldRef },
    [model, conversation.quoted, setFold, setCursor],
  );
  const viewCtx = useMemo(
    () => model && { cursorId, unread, isOpen: (id: string) => model.isOpen(id, folds) },
    [model, cursorId, unread, folds],
  );

  if (!model) return <p className="error">Root post missing from data.</p>;
  const { layout } = model;

  // Refresh and resume share one lock per conversation upstream (see
  // queries/conversation.ts), so while either is in flight the other's click
  // would be refused anyway. Only the writer that holds the lock says so.
  const writing = refreshing || resuming;

  return (
    <ThreadContext value={ctx}>
      <ViewContext value={viewCtx}>
        <div>
          <p className="notice">
            {conversation.posts.length} posts
            {conversation.cost &&
              (conversation.cost.billable > 0 ? (
                <> · cost {formatUsd(conversation.cost.usd, false)}</>
              ) : (
                <> · free (already read today)</>
              ))}
            {conversation.truncated && (
              <>
                {" · "}
                <span title="A fetch stopped before the whole conversation was read">
                  older replies missing
                </span>
                {" · "}
                <button className="notice-btn" onClick={onResume} disabled={writing}>
                  {resuming ? "loading older…" : "load older replies"}
                </button>
              </>
            )}
            {unread.size > 0 && (
              <>
                <span className="new-badge"> · {unread.size} unread</span> ·{" "}
                <button className="notice-btn" onClick={onMarkAllRead}>
                  mark all read
                </button>
              </>
            )}
            {" · "}
            <button className="notice-btn" onClick={onRefresh} disabled={writing}>
              {refreshing ? "refreshing…" : "refresh"}
            </button>
            {!refreshing && newCount !== null && (
              <span className={newCount > 0 ? "new-badge" : undefined}>
                {" "}
                {newCount > 0 ? `+${newCount} new` : "· up to date"}
              </span>
            )}
            {" · "}
            <button className="notice-btn" onClick={toggleHelp}>
              ? keys
            </button>
          </p>
          {layout.kind === "thread" ? (
            /*
             * The trunk: one straight line through every segment bead, which
             * never bends. A segment limb draws the stretch above its own bead
             * (`is-run`) and, when anything follows, the stretch below it
             * (`drops`) — and a take-off block draws the trunk running clean
             * past its whole reply bundle.
             */
            <div className="thread" ref={threadRef}>
              {layout.segments.map((segment, i) => {
                const final = i === layout.segments.length - 1;
                const replies = segment.replies.length > 0;
                return (
                  <div
                    key={segment.node.id}
                    className={[
                      "limb is-seg",
                      i > 0 ? " is-run" : "",
                      replies || !final ? " drops" : "",
                    ].join("")}
                  >
                    {/* Only the FINAL segment's body-side drop is a handle:
                        the trunk ends there and the drop is its block's line
                        (i-amend). Beside a mid-thread segment the trunk just
                        goes on, and the trunk folds nothing (h). */}
                    {replies && final && (
                      <LineGrab
                        reach
                        onToggle={() =>
                          setFold(segment.node.id, !model.isOpen(segment.node.id, folds))
                        }
                      />
                    )}
                    <PostCard node={segment.node} />
                    {replies && <SegmentReplies segment={segment} final={final} />}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="thread" ref={threadRef}>
              <BranchView branch={layout.branch} place="root" />
            </div>
          )}
          {helpOpen && (
            <div className="help-overlay">
              {HELP.map((row) => (
                <div key={row.keys} className="help-row">
                  <span className="help-keys">{row.keys}</span>
                  <span>{row.desc}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </ViewContext>
    </ThreadContext>
  );
}

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
  readonly setRead: (ids: string[], read: boolean) => void;
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
        if (!(e.target as HTMLElement).closest("a")) setCursor(node.id);
      }}
    >
      unavailable post (deleted or private) ·{" "}
      <a href={xPostUrl(undefined, node.id)} target="_blank" rel="noopener noreferrer">
        view on x.com ↗
      </a>
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
  const { model, quoted, setCursor, setRead } = useThread();
  const { post } = node;
  const hidden = model.hiddenReplies.get(post.id) ?? 0;
  return (
    <>
      <PostView
        post={post}
        quoted={quoted}
        displayText={node.displayText}
        id={`post-${post.id}`}
        className={cursor ? "post cursor" : "post"}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("a, button")) setCursor(post.id);
        }}
        leading={
          unread ? (
            <button
              className="unread-dot"
              title="Mark as read"
              aria-label="Mark as read"
              onClick={() => setRead([post.id], true)}
            />
          ) : undefined
        }
      />
      {hidden > 0 && (
        <div
          className="hidden-replies"
          title="Deleted, from a private account, or not returned by the API"
        >
          {hidden} {hidden === 1 ? "reply" : "replies"} not available
        </div>
      )}
    </>
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
 * A branch as the model decomposed it: a run of single-child posts hanging off
 * a connected rail under the head, then the fork that ended the run rendered
 * as one collapsible block. Fold state lives in the view context, keyed by the
 * owning post: the chain's head, the fork's tail.
 */
function BranchView({ branch }: { branch: Branch }) {
  const { model, setFold } = useThread();
  const { unread, isOpen } = useView();
  const { head, rest, tail, forks } = branch;
  const branches = forks.length > 0 && <CollapsibleChildren ownerId={tail.id} branches={forks} />;

  if (rest.length === 0) {
    return (
      <div>
        <PostCard node={head} />
        {branches}
      </div>
    );
  }
  if (!isOpen(head.id)) {
    const n = model.subtreeSize(head.id) - 1;
    return (
      <div>
        <PostCard node={head} />
        <button className="collapse-stub" onClick={() => setFold(head.id, true)}>
          ▸ {n} {n === 1 ? "reply" : "replies"} hidden
          <NewBadge count={unreadUnder(head.children, model, unread)} />
        </button>
      </div>
    );
  }
  return (
    <div>
      <PostCard node={head} />
      <div className="run">
        <div className="run-chain">
          <button
            className="run-rail"
            aria-label="Collapse chain"
            title="Collapse chain"
            onClick={() => setFold(head.id, false)}
          />
          {rest.map((n, i) => (
            <div key={n.id} className={i === rest.length - 1 ? "run-post run-post-last" : "run-post"}>
              <PostCard node={n} />
            </div>
          ))}
        </div>
        {branches && <div className="run-branches">{branches}</div>}
      </div>
    </div>
  );
}

/**
 * A post's replies as one block behind a single rail: clicking the rail
 * collapses the whole block. Nested reply blocks get their own rails.
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
  if (!isOpen(ownerId)) {
    const n = branches.reduce((sum, branch) => sum + model.subtreeSize(branch.head.id), 0);
    return (
      <button className="collapse-stub" onClick={() => setFold(ownerId, true)}>
        ▸ {n} {n === 1 ? "reply" : "replies"} hidden
        <NewBadge count={unreadUnder(branches.map((branch) => branch.head), model, unread)} />
      </button>
    );
  }
  return (
    <div className="children">
      <button
        className="rail"
        aria-label="Collapse replies"
        title="Collapse replies"
        onClick={() => setFold(ownerId, false)}
      />
      <div>
        {branches.map((branch) => (
          <BranchView key={branch.head.id} branch={branch} />
        ))}
      </div>
    </div>
  );
}

function SegmentReplies({ segment }: { segment: Segment }) {
  const { model, setFold } = useThread();
  const { unread, isOpen } = useView();
  const expanded = isOpen(segment.node.id);
  const count = segment.replies.reduce((sum, reply) => sum + model.subtreeSize(reply.head.id), 0);
  return (
    <div>
      <button className="collapse-stub" onClick={() => setFold(segment.node.id, !expanded)}>
        {expanded ? "▾" : "▸"} {count} {count === 1 ? "reply" : "replies"}
        {!expanded && (
          <NewBadge
            count={unreadUnder(segment.replies.map((reply) => reply.head), model, unread)}
          />
        )}
      </button>
      {expanded && (
        <div className="segment-replies">
          <div className="children">
            <button
              className="rail"
              aria-label="Collapse replies"
              title="Collapse replies"
              onClick={() => setFold(segment.node.id, false)}
            />
            <div>
              {segment.replies.map((reply) => (
                <BranchView key={reply.head.id} branch={reply} />
              ))}
            </div>
          </div>
        </div>
      )}
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
    const opened = new Map<string, boolean>();
    if (conversation.focusId) {
      let current = model?.parents.get(conversation.focusId) ?? null;
      while (current !== null) {
        opened.set(current, true);
        current = model?.parents.get(current) ?? null;
      }
      scrollRequestRef.current = "center";
    }
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
  const setFold = useCallback((id: string, open: boolean) => {
    setView((prev) => ({ ...prev, folds: new Map(prev.folds).set(id, open) }));
  }, []);
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
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isModifierKey(e.key)) return;
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

  /**
   * Read through the same ref the keyboard uses, so the handler a card holds
   * never changes identity even though the prop behind it is a fresh closure
   * on every render of App.
   */
  const setRead = useCallback((ids: string[], read: boolean) => {
    latest.current.onSetRead(ids, read);
  }, []);

  /**
   * Two contexts, split by how often they change. The stable half is what
   * makes `React.memo` on the cards mean anything: if the handlers or the
   * model moved with the cursor, every card would re-render as a context
   * consumer no matter what its props said.
   */
  const ctx = useMemo(
    () => model && { model, quoted: conversation.quoted, setFold, setCursor, setRead },
    [model, conversation.quoted, setFold, setCursor, setRead],
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
            <div className="spine">
              {layout.segments.map((segment) => (
                <div key={segment.node.id}>
                  <PostCard node={segment.node} />
                  {segment.replies.length > 0 && <SegmentReplies segment={segment} />}
                </div>
              ))}
            </div>
          ) : (
            <BranchView branch={layout.branch} />
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

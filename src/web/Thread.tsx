import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConversationResponse, Post } from "../shared/types";
import {
  buildTree,
  collectRun,
  countDescendants,
  documentOrder,
  foldOwnerIds,
  hiddenReplyCounts,
  parentIds,
  subtreeSize,
  threadSpine,
  type TreeNode,
} from "./tree";
import { PostView } from "./PostView";
import { formatUsd } from "../shared/pricing";
import { xPostUrl } from "../shared/urls";
import { HELP } from "./thread/keymap";
import { applyKey, isModifierKey, normalizeKey, type Command, type ViewState } from "./thread/keys";
import { keyModelOf } from "./thread/tree-model";

interface Ctx {
  cursorId: string | null;
  quoted: Record<string, Post>;
  unread: Set<string>;
  /** Direct replies each post declares but the tree doesn't contain. */
  hiddenReplies: Map<string, number>;
  isOpen: (id: string) => boolean;
  setFold: (id: string, open: boolean) => void;
  setCursor: (id: string) => void;
  setRead: (ids: string[], read: boolean) => void;
}

function unreadIn(node: TreeNode, unread: Set<string>): number {
  return (
    (unread.has(node.post.id) ? 1 : 0) +
    node.children.reduce((sum, child) => sum + unreadIn(child, unread), 0)
  );
}

function unreadInAll(nodes: TreeNode[], unread: Set<string>): number {
  return nodes.reduce((sum, node) => sum + unreadIn(node, unread), 0);
}

function NewBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="new-badge"> · {count} new</span>;
}

function PostCard({ node, ctx }: { node: TreeNode; ctx: Ctx }) {
  const { post } = node;
  if (node.placeholder) {
    return (
      <div
        id={`post-${post.id}`}
        className={post.id === ctx.cursorId ? "post placeholder-post cursor" : "post placeholder-post"}
        title={
          node.placementInferred
            ? "Position inferred from reply counts"
            : "Replied somewhere in this conversation; exact position unknown"
        }
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("a")) ctx.setCursor(post.id);
        }}
      >
        unavailable post (deleted or private) ·{" "}
        <a href={xPostUrl(undefined, post.id)} target="_blank" rel="noopener noreferrer">
          view on x.com ↗
        </a>
      </div>
    );
  }
  const isUnread = ctx.unread.has(post.id);
  const hidden = ctx.hiddenReplies.get(post.id) ?? 0;
  return (
    <>
      <PostView
        post={post}
        quoted={ctx.quoted}
        displayText={node.displayText}
        id={`post-${post.id}`}
        className={post.id === ctx.cursorId ? "post cursor" : "post"}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("a, button")) ctx.setCursor(post.id);
        }}
        leading={
          isUnread ? (
            <button
              className="unread-dot"
              title="Mark as read"
              aria-label="Mark as read"
              onClick={() => ctx.setRead([post.id], true)}
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
}

/**
 * A branch starts with a run: the maximal single-child chain from its head.
 * Continuations hang off a connected rail under the head. A fork (2+ replies)
 * ends the run and its replies render as one collapsible block. Fold state
 * lives in ctx, keyed by the owning post: the chain's head, the fork's tail.
 */
function Branch({ node, ctx }: { node: TreeNode; ctx: Ctx }) {
  const run = collectRun(node);
  const [head, ...rest] = run;
  const tail = run[run.length - 1]!;
  const branches = tail.children.length > 1 && (
    <CollapsibleChildren ownerId={tail.post.id} nodes={tail.children} ctx={ctx} />
  );

  if (rest.length === 0) {
    return (
      <div>
        <PostCard node={head!} ctx={ctx} />
        {branches}
      </div>
    );
  }
  if (!ctx.isOpen(head!.post.id)) {
    const n = countDescendants(head!);
    return (
      <div>
        <PostCard node={head!} ctx={ctx} />
        <button className="collapse-stub" onClick={() => ctx.setFold(head!.post.id, true)}>
          ▸ {n} {n === 1 ? "reply" : "replies"} hidden
          <NewBadge count={unreadInAll(head!.children, ctx.unread)} />
        </button>
      </div>
    );
  }
  return (
    <div>
      <PostCard node={head!} ctx={ctx} />
      <div className="run">
        <div className="run-chain">
          <button
            className="run-rail"
            aria-label="Collapse chain"
            title="Collapse chain"
            onClick={() => ctx.setFold(head!.post.id, false)}
          />
          {rest.map((n, i) => (
            <div
              key={n.post.id}
              className={i === rest.length - 1 ? "run-post run-post-last" : "run-post"}
            >
              <PostCard node={n} ctx={ctx} />
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
  nodes,
  ctx,
}: {
  ownerId: string;
  nodes: TreeNode[];
  ctx: Ctx;
}) {
  if (!ctx.isOpen(ownerId)) {
    const n = nodes.reduce((sum, node) => sum + subtreeSize(node), 0);
    return (
      <button className="collapse-stub" onClick={() => ctx.setFold(ownerId, true)}>
        ▸ {n} {n === 1 ? "reply" : "replies"} hidden
        <NewBadge count={unreadInAll(nodes, ctx.unread)} />
      </button>
    );
  }
  return (
    <div className="children">
      <button
        className="rail"
        aria-label="Collapse replies"
        title="Collapse replies"
        onClick={() => ctx.setFold(ownerId, false)}
      />
      <div>
        {nodes.map((node) => (
          <Branch key={node.post.id} node={node} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

function SegmentReplies({ segment, replies, ctx }: { segment: TreeNode; replies: TreeNode[]; ctx: Ctx }) {
  const expanded = ctx.isOpen(segment.post.id);
  const count = replies.reduce((sum, r) => sum + subtreeSize(r), 0);
  return (
    <div>
      <button
        className="collapse-stub"
        onClick={() => ctx.setFold(segment.post.id, !expanded)}
      >
        {expanded ? "▾" : "▸"} {count} {count === 1 ? "reply" : "replies"}
        {!expanded && <NewBadge count={unreadInAll(replies, ctx.unread)} />}
      </button>
      {expanded && (
        <div className="segment-replies">
          <div className="children">
            <button
              className="rail"
              aria-label="Collapse replies"
              title="Collapse replies"
              onClick={() => ctx.setFold(segment.post.id, false)}
            />
            <div>
              {replies.map((r) => (
                <Branch key={r.post.id} node={r} ctx={ctx} />
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
  const root = useMemo(
    () => buildTree(conversation.rootId, conversation.posts),
    [conversation.rootId, conversation.posts],
  );
  const spine = useMemo(() => (root ? threadSpine(root) : []), [root]);
  const owners = useMemo(
    () => (root ? foldOwnerIds(root, spine) : { branchFolds: new Set<string>(), segmentFolds: new Set<string>() }),
    [root, spine],
  );
  const parents = useMemo(() => (root ? parentIds(root) : new Map<string, string | null>()), [root]);
  const byId = useMemo(() => {
    const map = new Map<string, TreeNode>();
    if (root) for (const node of documentOrder(root, spine)) map.set(node.post.id, node);
    return map;
  }, [root, spine]);

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
      let current = parents.get(conversation.focusId) ?? null;
      while (current !== null) {
        opened.set(current, true);
        current = parents.get(current) ?? null;
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

  const isOpen = (id: string): boolean => folds.get(id) ?? !owners.segmentFolds.has(id);
  const unread = useMemo(() => new Set(conversation.unreadIds), [conversation.unreadIds]);
  // Reply-count deficits are meaningless when the fetch was capped.
  const hiddenReplies = useMemo(
    () => (root && !conversation.truncated ? hiddenReplyCounts(root) : new Map<string, number>()),
    [root, conversation.truncated],
  );

  // A snapshot for the console, taken after the render it describes.
  useEffect(() => {
    if (!import.meta.env.DEV && !localStorage.getItem("xdbg")) return;
    (window as { __xdbg?: unknown }).__xdbg = {
      cursorId,
      spine: spine.map((s) => s.post.id),
      segmentFolds: [...owners.segmentFolds],
      branchFolds: [...owners.branchFolds],
      folds: [...folds.entries()],
    };
  }, [cursorId, spine, owners, folds]);

  const visible = useMemo(() => {
    const open = (id: string): boolean => folds.get(id) ?? !owners.segmentFolds.has(id);
    return root ? documentOrder(root, spine, open) : [];
  }, [root, spine, folds, owners]);
  const allOrder = useMemo(() => (root ? documentOrder(root, spine) : []), [root, spine]);

  const setFold = (id: string, open: boolean) => {
    setView((prev) => ({ ...prev, folds: new Map(prev.folds).set(id, open) }));
  };
  const setCursor = (id: string) => {
    setView((prev) => ({ ...prev, cursorId: id }));
  };
  const toggleHelp = () => {
    setView((prev) => ({ ...prev, helpOpen: !prev.helpOpen }));
  };

  const keyModel = useMemo(
    () =>
      keyModelOf({
        rootId: conversation.rootId,
        spine,
        owners,
        parents,
        byId,
        visible,
        allOrder,
        unread,
      }),
    [conversation.rootId, spine, owners, parents, byId, visible, allOrder, unread],
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

  if (!root) return <p className="error">Root post missing from data.</p>;

  const ctx: Ctx = {
    cursorId,
    quoted: conversation.quoted,
    unread,
    hiddenReplies,
    isOpen,
    setFold,
    setCursor,
    setRead: onSetRead,
  };

  // Refresh and resume share one lock per conversation upstream (see
  // queries/conversation.ts), so while either is in flight the other's click
  // would be refused anyway. Only the writer that holds the lock says so.
  const writing = refreshing || resuming;

  return (
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
      {spine.length > 1 ? (
        <div className="spine">
          {spine.map((segment, i) => {
            const next = spine[i + 1];
            const replies = segment.children.filter((c) => c !== next);
            return (
              <div key={segment.post.id}>
                <PostCard node={segment} ctx={ctx} />
                {replies.length > 0 && (
                  <SegmentReplies segment={segment} replies={replies} ctx={ctx} />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <Branch node={root} ctx={ctx} />
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
  );
}

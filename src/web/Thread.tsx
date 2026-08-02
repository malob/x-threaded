import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

interface Ctx {
  model: ThreadModel;
  cursorId: string | null;
  quoted: Record<string, Post>;
  unread: Set<string>;
  isOpen: (id: string) => boolean;
  setFold: (id: string, open: boolean) => void;
  setCursor: (id: string) => void;
  setRead: (ids: string[], read: boolean) => void;
}

/** Unread posts in the subtrees of a set of siblings — what a fold hides. */
function unreadUnder(nodes: readonly ThreadNode[], ctx: Ctx): number {
  return nodes.reduce((sum, node) => sum + ctx.model.unreadCount(node.id, ctx.unread), 0);
}

function NewBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="new-badge"> · {count} new</span>;
}

/** A post we never got: its ID is real, so x.com can still resolve it. */
function GapCard({ node, ctx }: { node: GapNode; ctx: Ctx }) {
  return (
    <div
      id={`post-${node.id}`}
      className={node.id === ctx.cursorId ? "post placeholder-post cursor" : "post placeholder-post"}
      title={
        node.placementInferred
          ? "Position inferred from reply counts"
          : "Replied somewhere in this conversation; exact position unknown"
      }
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a")) ctx.setCursor(node.id);
      }}
    >
      unavailable post (deleted or private) ·{" "}
      <a href={xPostUrl(undefined, node.id)} target="_blank" rel="noopener noreferrer">
        view on x.com ↗
      </a>
    </div>
  );
}

function RealPostCard({ node, ctx }: { node: PostNode; ctx: Ctx }) {
  const { post } = node;
  const isUnread = ctx.unread.has(post.id);
  const hidden = ctx.model.hiddenReplies.get(post.id) ?? 0;
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

function PostCard({ node, ctx }: { node: ThreadNode; ctx: Ctx }) {
  return node.kind === "gap" ? (
    <GapCard node={node} ctx={ctx} />
  ) : (
    <RealPostCard node={node} ctx={ctx} />
  );
}

/**
 * A branch as the model decomposed it: a run of single-child posts hanging off
 * a connected rail under the head, then the fork that ended the run rendered
 * as one collapsible block. Fold state lives in ctx, keyed by the owning post:
 * the chain's head, the fork's tail.
 */
function BranchView({ branch, ctx }: { branch: Branch; ctx: Ctx }) {
  const { head, rest, tail, forks } = branch;
  const branches = forks.length > 0 && (
    <CollapsibleChildren ownerId={tail.id} branches={forks} ctx={ctx} />
  );

  if (rest.length === 0) {
    return (
      <div>
        <PostCard node={head} ctx={ctx} />
        {branches}
      </div>
    );
  }
  if (!ctx.isOpen(head.id)) {
    const n = ctx.model.subtreeSize(head.id) - 1;
    return (
      <div>
        <PostCard node={head} ctx={ctx} />
        <button className="collapse-stub" onClick={() => ctx.setFold(head.id, true)}>
          ▸ {n} {n === 1 ? "reply" : "replies"} hidden
          <NewBadge count={unreadUnder(head.children, ctx)} />
        </button>
      </div>
    );
  }
  return (
    <div>
      <PostCard node={head} ctx={ctx} />
      <div className="run">
        <div className="run-chain">
          <button
            className="run-rail"
            aria-label="Collapse chain"
            title="Collapse chain"
            onClick={() => ctx.setFold(head.id, false)}
          />
          {rest.map((n, i) => (
            <div key={n.id} className={i === rest.length - 1 ? "run-post run-post-last" : "run-post"}>
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
  branches,
  ctx,
}: {
  ownerId: string;
  branches: readonly Branch[];
  ctx: Ctx;
}) {
  if (!ctx.isOpen(ownerId)) {
    const n = branches.reduce((sum, branch) => sum + ctx.model.subtreeSize(branch.head.id), 0);
    return (
      <button className="collapse-stub" onClick={() => ctx.setFold(ownerId, true)}>
        ▸ {n} {n === 1 ? "reply" : "replies"} hidden
        <NewBadge count={unreadUnder(branches.map((branch) => branch.head), ctx)} />
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
        {branches.map((branch) => (
          <BranchView key={branch.head.id} branch={branch} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

function SegmentReplies({ segment, ctx }: { segment: Segment; ctx: Ctx }) {
  const expanded = ctx.isOpen(segment.node.id);
  const count = segment.replies.reduce(
    (sum, reply) => sum + ctx.model.subtreeSize(reply.head.id),
    0,
  );
  return (
    <div>
      <button
        className="collapse-stub"
        onClick={() => ctx.setFold(segment.node.id, !expanded)}
      >
        {expanded ? "▾" : "▸"} {count} {count === 1 ? "reply" : "replies"}
        {!expanded && (
          <NewBadge count={unreadUnder(segment.replies.map((reply) => reply.head), ctx)} />
        )}
      </button>
      {expanded && (
        <div className="segment-replies">
          <div className="children">
            <button
              className="rail"
              aria-label="Collapse replies"
              title="Collapse replies"
              onClick={() => ctx.setFold(segment.node.id, false)}
            />
            <div>
              {segment.replies.map((reply) => (
                <BranchView key={reply.head.id} branch={reply} ctx={ctx} />
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

  if (!model) return <p className="error">Root post missing from data.</p>;

  const ctx: Ctx = {
    model,
    cursorId,
    quoted: conversation.quoted,
    unread,
    isOpen: (id) => model.isOpen(id, folds),
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
      {model.layout.kind === "thread" ? (
        <div className="spine">
          {model.layout.segments.map((segment) => (
            <div key={segment.node.id}>
              <PostCard node={segment.node} ctx={ctx} />
              {segment.replies.length > 0 && <SegmentReplies segment={segment} ctx={ctx} />}
            </div>
          ))}
        </div>
      ) : (
        <BranchView branch={model.layout.branch} ctx={ctx} />
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

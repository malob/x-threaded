import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationResponse, Post } from "../shared/types";
import {
  buildTree,
  collectRun,
  countDescendants,
  documentOrder,
  foldOwnerIds,
  hiddenReplyCounts,
  parentIds,
  scopeIds,
  subtreeSize,
  threadSpine,
  type TreeNode,
} from "./tree";
import { PostView } from "./PostView";
import { formatUsd } from "../shared/pricing";
import { appPath, xPostUrl } from "../shared/urls";

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

const HELP: [string, string][] = [
  ["j / k, ↓ / ↑", "next / previous post"],
  ["h / l, ← / →", "parent / first reply"],
  ["{ / }", "previous / next sibling branch"],
  ["n / N", "next / previous unread (marks read)"],
  ["r / R", "mark read (fold-scoped) / mark unread + subtree"],
  ["za  zo  zc", "toggle / open / close fold"],
  ["zO / zC", "open / close subtree recursively"],
  ["zR / zM", "open / close all folds"],
  ["enter", "toggle fold"],
  ["gg / G", "first / last post"],
  ["zz", "center current post"],
  ["gx", "open post on x.com"],
  ["yy / Y", "copy x.com link / app deep link"],
  ["?", "toggle this help"],
];

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

  const [folds, setFolds] = useState<Map<string, boolean>>(new Map());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
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
    setFolds(opened);
    setCursorId(conversation.focusId ?? conversation.rootId);
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

  if (import.meta.env.DEV || localStorage.getItem("xdbg")) {
    // Lint is right that writing to window during render is impure. Moving it
    // into an effect is already on the plan (2026-07-30 synthesis); doing it
    // here would change when the snapshot is taken, so it waits for that stage.
    // eslint-disable-next-line react-hooks/immutability
    (window as { __xdbg?: unknown }).__xdbg = {
      cursorId,
      spine: spine.map((s) => s.post.id),
      segmentFolds: [...owners.segmentFolds],
      branchFolds: [...owners.branchFolds],
      folds: [...folds.entries()],
    };
  }

  const visible = useMemo(
    () => (root ? documentOrder(root, spine, isOpen) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, spine, folds, owners],
  );
  const allOrder = useMemo(() => (root ? documentOrder(root, spine) : []), [root, spine]);

  const setFold = (id: string, open: boolean) => {
    setFolds((prev) => new Map(prev).set(id, open));
  };

  useEffect(() => {
    const allOwnerIds = [...owners.branchFolds, ...owners.segmentFolds];
    const ownedBy = (id: string): string | null => {
      let current: string | null = id;
      while (current !== null) {
        if (owners.branchFolds.has(current) || owners.segmentFolds.has(current)) return current;
        current = parents.get(current) ?? null;
      }
      return null;
    };
    const moveCursor = (id: string | undefined) => {
      if (!id) return;
      scrollRequestRef.current ??= "nearest";
      setCursorId(id);
    };
    const openAncestors = (id: string) => {
      setFolds((prev) => {
        const next = new Map(prev);
        let current = parents.get(id) ?? null;
        while (current !== null) {
          next.set(current, true);
          current = parents.get(current) ?? null;
        }
        return next;
      });
    };
    const jumpUnread = (dir: 1 | -1) => {
      if (unread.size === 0 || allOrder.length === 0) return;
      const idx = allOrder.findIndex((n) => n.post.id === cursorId);
      for (let step = 1; step <= allOrder.length; step++) {
        const i = (idx + dir * step + allOrder.length * step) % allOrder.length;
        const node = allOrder[i]!;
        if (unread.has(node.post.id)) {
          openAncestors(node.post.id);
          scrollRequestRef.current = "center";
          setCursorId(node.post.id);
          onSetRead([node.post.id], true);
          return;
        }
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") return;
      let key = e.key;
      if (key === "/" && e.shiftKey) key = "?";
      else if (key.length === 1 && e.shiftKey && key >= "a" && key <= "z") key = key.toUpperCase();
      const cursor = cursorId ? byId.get(cursorId) : undefined;
      const visIdx = visible.findIndex((n) => n.post.id === cursorId);
      const pending = pendingRef.current;
      pendingRef.current = null;
      let handled = true;

      if (pending === "g") {
        if (key === "g") moveCursor(visible[0]?.post.id);
        else if (key === "x" && cursor) {
          window.open(xPostUrl(cursor.post.authorHandle, cursor.post.id), "_blank", "noopener");
        } else handled = false;
      } else if (pending === "y") {
        if (key === "y" && cursor) {
          void navigator.clipboard.writeText(xPostUrl(cursor.post.authorHandle, cursor.post.id));
        } else handled = false;
      } else if (pending === "z") {
        const owner = cursorId ? ownedBy(cursorId) : null;
        // Keyboard fold changes keep the cursor in view; mouse ones don't.
        const foldAndFollow = (id: string, open: boolean) => {
          scrollRequestRef.current ??= "nearest";
          setFold(id, open);
        };
        switch (key) {
          case "a":
            if (owner) foldAndFollow(owner, !isOpen(owner));
            break;
          case "o":
            if (owner) foldAndFollow(owner, true);
            break;
          case "c":
            if (owner) {
              setFold(owner, false);
              moveCursor(owner);
            }
            break;
          case "O":
          case "C": {
            if (!cursor) break;
            const open = key === "O";
            scrollRequestRef.current ??= "nearest";
            setFolds((prev) => {
              const next = new Map(prev);
              for (const id of scopeIds(cursor, spine)) {
                if (owners.branchFolds.has(id) || owners.segmentFolds.has(id)) next.set(id, open);
              }
              return next;
            });
            break;
          }
          case "R":
          case "M": {
            const open = key === "R";
            scrollRequestRef.current ??= "nearest";
            setFolds(new Map(allOwnerIds.map((id) => [id, open])));
            if (key === "M") moveCursor(conversation.rootId);
            break;
          }
          case "z":
            if (cursorId) {
              document
                .getElementById(`post-${cursorId}`)
                ?.scrollIntoView({ block: "center" });
            }
            break;
          default:
            handled = false;
        }
      } else {
        switch (key) {
          case "j":
          case "ArrowDown":
            moveCursor(visible[Math.min(visIdx + 1, visible.length - 1)]?.post.id);
            break;
          case "k":
          case "ArrowUp":
            moveCursor(visible[Math.max(visIdx - 1, 0)]?.post.id);
            break;
          case "h":
          case "ArrowLeft": {
            const parent = cursorId ? parents.get(cursorId) : null;
            if (parent) moveCursor(parent);
            break;
          }
          case "l":
          case "ArrowRight": {
            const target = cursor?.children[0]?.post.id;
            if (!target) break;
            if (!visible.some((n) => n.post.id === target)) openAncestors(target);
            moveCursor(target);
            break;
          }
          case "{":
          case "}": {
            const dir = key === "}" ? 1 : -1;
            let current: string | null = cursorId;
            while (current !== null) {
              const parentId = parents.get(current) ?? null;
              const siblings: TreeNode[] = parentId
                ? (byId.get(parentId)?.children ?? [])
                : [];
              const i = siblings.findIndex((s) => s.post.id === current);
              const sibling = siblings[i + dir];
              if (sibling) {
                moveCursor(sibling.post.id);
                break;
              }
              current = parentId;
            }
            break;
          }
          case "G":
            moveCursor(visible[visible.length - 1]?.post.id);
            break;
          case "n":
            jumpUnread(1);
            break;
          case "N":
            jumpUnread(-1);
            break;
          case "r": {
            if (!cursor) break;
            const folded = !isOpen(cursor.post.id) &&
              (owners.branchFolds.has(cursor.post.id) || owners.segmentFolds.has(cursor.post.id));
            onSetRead(folded ? scopeIds(cursor, spine) : [cursor.post.id], true);
            break;
          }
          case "R":
            if (cursor) onSetRead(scopeIds(cursor, spine), false);
            break;
          case "Y":
            if (cursor) {
              void navigator.clipboard.writeText(
                `${location.origin}${appPath(cursor.post.authorHandle, cursor.post.id)}`,
              );
            }
            break;
          case "Enter": {
            const owner = cursorId ? ownedBy(cursorId) : null;
            if (owner) {
              scrollRequestRef.current ??= "nearest";
              setFold(owner, !isOpen(owner));
            }
            break;
          }
          case "g":
          case "z":
          case "y":
            pendingRef.current = key;
            break;
          case "?":
            setHelpOpen((prev) => !prev);
            break;
          case "Escape":
            setHelpOpen(false);
            break;
          default:
            handled = false;
        }
      }
      if (handled) e.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!root) return <p className="error">Root post missing from data.</p>;

  const ctx: Ctx = {
    cursorId,
    quoted: conversation.quoted,
    unread,
    hiddenReplies,
    isOpen,
    setFold,
    setCursor: setCursorId,
    setRead: onSetRead,
  };

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
            <button className="notice-btn" onClick={onResume} disabled={resuming}>
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
        <button className="notice-btn" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "refreshing…" : "refresh"}
        </button>
        {!refreshing && newCount !== null && (
          <span className={newCount > 0 ? "new-badge" : undefined}>
            {" "}
            {newCount > 0 ? `+${newCount} new` : "· up to date"}
          </span>
        )}
        {" · "}
        <button className="notice-btn" onClick={() => setHelpOpen((prev) => !prev)}>
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
          {HELP.map(([keys, desc]) => (
            <div key={keys} className="help-row">
              <span className="help-keys">{keys}</span>
              <span>{desc}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

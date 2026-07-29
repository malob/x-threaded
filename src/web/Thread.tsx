import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConversationResponse, Post } from "../shared/types";
import {
  buildTree,
  collectRun,
  countDescendants,
  documentOrder,
  foldOwnerIds,
  parentIds,
  scopeIds,
  subtreeSize,
  threadSpine,
  type TreeNode,
} from "./tree";
import { PostText } from "./PostText";

interface Ctx {
  cursorId: string | null;
  quoted: Record<string, Post>;
  unread: Set<string>;
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const scaled = n < 1_000_000 ? n / 1000 : n / 1_000_000;
  const suffix = n < 1_000_000 ? "k" : "M";
  return scaled.toFixed(1).replace(/\.0$/, "") + suffix;
}

function postUrl(post: Post): string {
  return `https://x.com/${post.authorHandle}/status/${post.id}`;
}

function MetaCounts({ post }: { post: Post }) {
  const m = post.metrics;
  const items: { key: string; node: ReactNode }[] = [];
  if (m.likes > 0) items.push({ key: "likes", node: <>♥ {formatCount(m.likes)}</> });
  if (m.reposts > 0) {
    items.push({
      key: "reposts",
      node: (
        <a href={`${postUrl(post)}/retweets`} target="_blank" rel="noopener noreferrer">
          ↻ {formatCount(m.reposts)}
        </a>
      ),
    });
  }
  if (m.quotes > 0) {
    items.push({
      key: "quotes",
      node: (
        <a href={`${postUrl(post)}/quotes`} target="_blank" rel="noopener noreferrer">
          ❝ {formatCount(m.quotes)}
        </a>
      ),
    });
  }
  if (m.bookmarks > 0) items.push({ key: "bookmarks", node: <>⚑ {formatCount(m.bookmarks)}</> });
  if (m.impressions > 0) {
    items.push({ key: "views", node: <>{formatCount(m.impressions)} views</> });
  }
  if (items.length === 0) return null;
  return (
    <div className="post-counts">
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && " · "}
          {item.node}
        </Fragment>
      ))}
    </div>
  );
}

function Avatar({ url, small }: { url: string | null; small?: boolean }) {
  if (!url) return null;
  return (
    <img
      className={small ? "avatar avatar-small" : "avatar"}
      src={url}
      alt=""
      loading="lazy"
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
    />
  );
}

function MediaGrid({ post }: { post: Post }) {
  if (!post.media?.length) return null;
  return (
    <div className="post-media">
      {post.media.map((m, i) => {
        const src = m.url ?? m.previewImageUrl;
        if (!src) return null;
        const href = m.type === "photo" ? `${postUrl(post)}/photo/${i + 1}` : postUrl(post);
        return (
          <a key={m.mediaKey} href={href} target="_blank" rel="noopener noreferrer">
            <img src={src} alt={m.type === "photo" ? "attached image" : `${m.type} preview`} loading="lazy" />
            {m.type !== "photo" && (
              <span className="media-badge">{m.type === "animated_gif" ? "GIF" : "video"} ↗</span>
            )}
          </a>
        );
      })}
    </div>
  );
}

function QuoteCard({ quotedId, ctx, depth }: { quotedId: string; ctx: Ctx; depth: number }) {
  const post = ctx.quoted[quotedId];
  if (!post || depth > 2) {
    return (
      <a
        className="quote-card quote-card-link"
        href={`https://x.com/i/status/${quotedId}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        quoted post on x.com ↗
      </a>
    );
  }
  return (
    <div className="quote-card">
      <div className="post-meta">
        <Avatar url={post.authorAvatarUrl} small />
        <span className="name">{post.authorName}</span> @{post.authorHandle} ·{" "}
        {formatTime(post.createdAt)}
        <a
          className="quote-open"
          href={postUrl(post)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open on x.com"
        >
          ↗
        </a>
      </div>
      <div className="post-text">
        <PostText text={post.text} post={post} />
      </div>
      <MediaGrid post={post} />
      {post.quotedPostId && <QuoteCard quotedId={post.quotedPostId} ctx={ctx} depth={depth + 1} />}
    </div>
  );
}

function PostCard({ node, ctx }: { node: TreeNode; ctx: Ctx }) {
  const { post, orphaned } = node;
  const isUnread = ctx.unread.has(post.id);
  return (
    <div
      id={`post-${post.id}`}
      className={post.id === ctx.cursorId ? "post cursor" : "post"}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a, button")) ctx.setCursor(post.id);
      }}
    >
      <div className="post-meta">
        {isUnread && (
          <button
            className="unread-dot"
            title="Mark as read"
            aria-label="Mark as read"
            onClick={() => ctx.setRead([post.id], true)}
          />
        )}
        <Avatar url={post.authorAvatarUrl} />
        <span className="name">{post.authorName}</span> @{post.authorHandle} ·{" "}
        {formatTime(post.createdAt)}
        {orphaned && <span className="orphan-badge">parent unavailable</span>}
      </div>
      <div className="post-text">
        <PostText text={node.displayText} post={post} />
      </div>
      <MediaGrid post={post} />
      {post.quotedPostId && <QuoteCard quotedId={post.quotedPostId} ctx={ctx} depth={1} />}
      <MetaCounts post={post} />
    </div>
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
  ["yy", "copy post link"],
  ["?", "toggle this help"],
];

interface ThreadProps {
  conversation: ConversationResponse;
  refreshing: boolean;
  newCount: number | null;
  onRefresh: () => void;
  onSetRead: (ids: string[], read: boolean) => void;
  onMarkAllRead: () => void;
}

export function Thread({
  conversation,
  refreshing,
  newCount,
  onRefresh,
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
  const scrollModeRef = useRef<ScrollLogicalPosition>("nearest");

  useEffect(() => {
    setFolds(new Map());
    setCursorId(conversation.focusId ?? conversation.rootId);
    if (conversation.focusId) scrollModeRef.current = "center";
  }, [conversation.rootId, conversation.focusId]);

  useEffect(() => {
    if (!cursorId) return;
    document
      .getElementById(`post-${cursorId}`)
      ?.scrollIntoView({ block: scrollModeRef.current, behavior: "auto" });
    scrollModeRef.current = "nearest";
  }, [cursorId, folds]);

  const isOpen = (id: string): boolean => folds.get(id) ?? !owners.segmentFolds.has(id);
  const unread = useMemo(() => new Set(conversation.unreadIds), [conversation.unreadIds]);

  if (import.meta.env.DEV || localStorage.getItem("xdbg")) {
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
      if (id) setCursorId(id);
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
          scrollModeRef.current = "center";
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
        else if (key === "x" && cursor) window.open(postUrl(cursor.post), "_blank", "noopener");
        else handled = false;
      } else if (pending === "y") {
        if (key === "y" && cursor) void navigator.clipboard.writeText(postUrl(cursor.post));
        else handled = false;
      } else if (pending === "z") {
        const owner = cursorId ? ownedBy(cursorId) : null;
        switch (key) {
          case "a":
            if (owner) setFold(owner, !isOpen(owner));
            break;
          case "o":
            if (owner) setFold(owner, true);
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
            setFolds(new Map(allOwnerIds.map((id) => [id, open])));
            if (key === "M") moveCursor(conversation.rootId);
            break;
          }
          case "z":
            if (cursorId) {
              scrollModeRef.current = "center";
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
          case "Enter": {
            const owner = cursorId ? ownedBy(cursorId) : null;
            if (owner) setFold(owner, !isOpen(owner));
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
    isOpen,
    setFold,
    setCursor: setCursorId,
    setRead: onSetRead,
  };

  return (
    <div>
      <p className="notice">
        {conversation.posts.length} posts
        {conversation.truncated && " · truncated at fetch cap"}
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

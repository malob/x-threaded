import { Fragment, useState, type ReactNode } from "react";
import type { ConversationResponse, Post } from "../shared/types";
import { buildTree, countDescendants, subtreeSize, threadSpine, type TreeNode } from "./tree";
import { PostText } from "./PostText";

interface Ctx {
  focusId: string | null;
  quoted: Record<string, Post>;
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

function MetaCounts({ post }: { post: Post }) {
  const m = post.metrics;
  const statusUrl = `https://x.com/${post.authorHandle}/status/${post.id}`;
  const items: { key: string; node: ReactNode }[] = [];
  if (m.likes > 0) items.push({ key: "likes", node: <>♥ {formatCount(m.likes)}</> });
  if (m.reposts > 0) {
    items.push({
      key: "reposts",
      node: (
        <a href={`${statusUrl}/retweets`} target="_blank" rel="noopener noreferrer">
          ↻ {formatCount(m.reposts)}
        </a>
      ),
    });
  }
  if (m.quotes > 0) {
    items.push({
      key: "quotes",
      node: (
        <a href={`${statusUrl}/quotes`} target="_blank" rel="noopener noreferrer">
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
        const href =
          m.type === "photo"
            ? `https://x.com/${post.authorHandle}/status/${post.id}/photo/${i + 1}`
            : `https://x.com/${post.authorHandle}/status/${post.id}`;
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
          href={`https://x.com/${post.authorHandle}/status/${post.id}`}
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
  return (
    <div className={post.id === ctx.focusId ? "post focused" : "post"}>
      <div className="post-meta">
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
 * Continuations hang off a connected rail under the head (git-graph style).
 * A fork (2+ replies) ends the run and each branch below it indents once,
 * individually collapsible.
 */
function Branch({ node, ctx }: { node: TreeNode; ctx: Ctx }) {
  const [chainCollapsed, setChainCollapsed] = useState(false);
  const run: TreeNode[] = [node];
  let tail = node;
  while (tail.children.length === 1) {
    tail = tail.children[0]!;
    run.push(tail);
  }
  const [head, ...rest] = run;
  const branches = tail.children.length > 1 && (
    <CollapsibleChildren nodes={tail.children} ctx={ctx} />
  );

  if (rest.length === 0) {
    return (
      <div>
        <PostCard node={head!} ctx={ctx} />
        {branches}
      </div>
    );
  }
  if (chainCollapsed) {
    const n = countDescendants(head!);
    return (
      <div>
        <PostCard node={head!} ctx={ctx} />
        <button className="collapse-stub" onClick={() => setChainCollapsed(false)}>
          ▸ {n} {n === 1 ? "reply" : "replies"} hidden
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
            onClick={() => setChainCollapsed(true)}
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
  nodes,
  ctx,
  onCollapse,
}: {
  nodes: TreeNode[];
  ctx: Ctx;
  onCollapse?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    const n = nodes.reduce((sum, node) => sum + subtreeSize(node), 0);
    return (
      <button className="collapse-stub" onClick={() => setCollapsed(false)}>
        ▸ {n} {n === 1 ? "reply" : "replies"} hidden
      </button>
    );
  }
  return (
    <div className="children">
      <button
        className="rail"
        aria-label="Collapse replies"
        title="Collapse replies"
        onClick={onCollapse ?? (() => setCollapsed(true))}
      />
      <div>
        {nodes.map((node) => (
          <Branch key={node.post.id} node={node} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

function SegmentReplies({ replies, ctx }: { replies: TreeNode[]; ctx: Ctx }) {
  const [expanded, setExpanded] = useState(false);
  const count = replies.reduce((sum, r) => sum + subtreeSize(r), 0);
  return (
    <div>
      <button className="collapse-stub" onClick={() => setExpanded(!expanded)}>
        {expanded ? "▾" : "▸"} {count} {count === 1 ? "reply" : "replies"}
      </button>
      {expanded && (
        <div className="segment-replies">
          <CollapsibleChildren nodes={replies} ctx={ctx} onCollapse={() => setExpanded(false)} />
        </div>
      )}
    </div>
  );
}

export function Thread({ conversation }: { conversation: ConversationResponse }) {
  const root = buildTree(conversation.rootId, conversation.posts);
  if (!root) return <p className="error">Root post missing from data.</p>;
  const ctx: Ctx = { focusId: conversation.focusId, quoted: conversation.quoted };
  const spine = threadSpine(root);

  return (
    <div>
      <p className="notice">
        {conversation.posts.length} posts
        {conversation.fromCache ? " · from cache" : " · fetched from X"}
        {conversation.truncated && " · truncated at fetch cap"}
      </p>
      {spine.length > 1 ? (
        <div className="spine">
          {spine.map((segment, i) => {
            const next = spine[i + 1];
            const replies = segment.children.filter((c) => c !== next);
            return (
              <div key={segment.post.id}>
                <PostCard node={segment} ctx={ctx} />
                {replies.length > 0 && <SegmentReplies replies={replies} ctx={ctx} />}
              </div>
            );
          })}
        </div>
      ) : (
        <Branch node={root} ctx={ctx} />
      )}
    </div>
  );
}

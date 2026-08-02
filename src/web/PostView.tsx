import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import type { Post } from "../shared/types";
import { xPostUrl } from "../shared/urls";
import { PostText } from "./PostText";

/**
 * One ResizeObserver for every clamped block on the page.
 *
 * A big conversation is hundreds of them, and an observer each would be
 * hundreds of separate observation lists for the browser to walk each frame,
 * to answer the same question. One observer, one callback per element.
 */
const sizeCallbacks = new WeakMap<Element, () => void>();
let sizeObserver: ResizeObserver | null = null;

function observeSize(el: Element, onResize: () => void): () => void {
  sizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) sizeCallbacks.get(entry.target)?.();
  });
  sizeCallbacks.set(el, onResize);
  sizeObserver.observe(el);
  return () => {
    sizeCallbacks.delete(el);
    sizeObserver?.unobserve(el);
  };
}

/**
 * Post text clamped to a few lines with a "Show more" toggle, X-style.
 * Clamping is visual (line-clamp) so entity links never get cut mid-token.
 *
 * Whether it overflows is a question about a laid-out box, and it is asked
 * only when the answer can have changed: once for each piece of content, and
 * again whenever the box is resized — expanding it, collapsing it, or the
 * window changing width. It used to be asked after every render, because the
 * effect depended on `children` and that is a fresh element each time; on a
 * conversation of five hundred posts that was five hundred forced layouts for
 * every keystroke, all of them to re-confirm what was already on screen.
 */
function ClampedText({
  lines,
  contentKey,
  children,
}: {
  lines: number;
  /** Identifies the text being clamped: new content, new measurement. */
  contentKey: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    return observeSize(el, measure);
  }, [contentKey]);
  return (
    <>
      <div
        ref={ref}
        className={expanded ? "post-text" : "post-text clamped"}
        style={expanded ? undefined : { WebkitLineClamp: lines }}
      >
        {children}
      </div>
      {(overflows || expanded) && (
        <button className="show-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

function postUrl(post: Post): string {
  return xPostUrl(post.authorHandle, post.id);
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
            <img
              src={src}
              alt={m.type === "photo" ? "attached image" : `${m.type} preview`}
              loading="lazy"
              onError={(e) => {
                const anchor = e.currentTarget.closest("a");
                if (anchor) anchor.style.display = "none";
              }}
            />
            {m.type !== "photo" && (
              <span className="media-badge">{m.type === "animated_gif" ? "GIF" : "video"} ↗</span>
            )}
          </a>
        );
      })}
    </div>
  );
}

function QuoteCard({
  quotedId,
  quoted,
  depth,
}: {
  quotedId: string;
  quoted: Record<string, Post>;
  depth: number;
}) {
  const post = quoted[quotedId];
  if (!post || depth > 2) {
    return (
      <a
        className="quote-card quote-card-link"
        href={xPostUrl(undefined, quotedId)}
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
      <ClampedText lines={4} contentKey={post.text}>
        <PostText text={post.text} post={post} />
      </ClampedText>
      <MediaGrid post={post} />
      {post.quotedPostId && <QuoteCard quotedId={post.quotedPostId} quoted={quoted} depth={depth + 1} />}
    </div>
  );
}

/**
 * A fully rendered post: header, text with entities, media, quote card, and
 * metric counts. Used by the thread view and the inbox alike.
 */
export function PostView({
  post,
  quoted,
  displayText,
  id,
  className,
  onClick,
  leading,
}: {
  post: Post;
  quoted: Record<string, Post>;
  /** Text with reply-context mentions stripped; defaults to the raw text. */
  displayText?: string;
  id?: string;
  className?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  /** Rendered before the avatar in the header (e.g. an unread dot). */
  leading?: ReactNode;
}) {
  return (
    <div id={id} className={className ?? "post"} onClick={onClick}>
      <div className="post-meta">
        {leading}
        <Avatar url={post.authorAvatarUrl} />
        <span className="name">{post.authorName}</span> @{post.authorHandle} ·{" "}
        {formatTime(post.createdAt)}
      </div>
      <ClampedText lines={6} contentKey={displayText ?? post.text}>
        <PostText text={displayText ?? post.text} post={post} />
      </ClampedText>
      <MediaGrid post={post} />
      {post.quotedPostId && <QuoteCard quotedId={post.quotedPostId} quoted={quoted} depth={1} />}
      <MetaCounts post={post} />
    </div>
  );
}

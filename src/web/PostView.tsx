import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import type { MediaItem, Post } from "../shared/types";
import { xPostUrl, xProfileUrl } from "../shared/urls";
import { PostText } from "./PostText";
import { mediaSourceVisible } from "./media-state";

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

/* Metric icons: inline SVG in currentColor, because font glyphs (\u2665 \u21bb
   \u275d \u2691) render through per-character fallback in the mono stack and come
   out ragged — and Unicode has no quiet bookmark at all (owner, both). */
function MetricIcon({ d }: { d: string }) {
  return (
    <svg className="mi" viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const MI = {
  like: "M12 21C7 16.6 4 13.4 4 9.9 4 7.2 6 5 8.6 5c1.4 0 2.6.7 3.4 1.8C12.8 5.7 14 5 15.4 5 18 5 20 7.2 20 9.9c0 3.5-3 6.7-8 11.1z",
  repost: "M7 7h8v3l4-4-4-4v3H5v6h2V7zm10 10H9v-3l-4 4 4 4v-3h10v-6h-2v4z",
  quote: "M6 17h3l2-4V7H5v6h3l-2 4zm8 0h3l2-4V7h-6v6h3l-2 4z",
  bookmark: "M6 3h12v18l-6-4.4L6 21V3z",
};

function MetaCounts({ post, footerNote }: { post: Post; footerNote?: ReactNode }) {
  const m = post.metrics;
  const items: { key: string; node: ReactNode }[] = [];
  if (m.likes > 0)
    items.push({ key: "likes", node: <><MetricIcon d={MI.like} /> {formatCount(m.likes)}</> });
  if (m.reposts > 0) {
    items.push({
      key: "reposts",
      node: (
        <a href={`${postUrl(post)}/retweets`} target="_blank" rel="noopener noreferrer">
          <MetricIcon d={MI.repost} /> {formatCount(m.reposts)}
        </a>
      ),
    });
  }
  if (m.quotes > 0) {
    items.push({
      key: "quotes",
      node: (
        <a href={`${postUrl(post)}/quotes`} target="_blank" rel="noopener noreferrer">
          <MetricIcon d={MI.quote} /> {formatCount(m.quotes)}
        </a>
      ),
    });
  }
  if (m.bookmarks > 0)
    items.push({ key: "bookmarks", node: <><MetricIcon d={MI.bookmark} /> {formatCount(m.bookmarks)}</> });
  if (m.impressions > 0) {
    items.push({ key: "views", node: <>{formatCount(m.impressions)} views</> });
  }
  /* Always rendered, even empty: the counts row is the post's last line and
     the fold station aligns to its middle — a post without metrics still
     reserves the line so every mark has its anchor and the rhythm holds
     (owner ruling). */
  return (
    <div className="post-counts">
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && " · "}
          {item.node}
        </Fragment>
      ))}
      {footerNote != null && (
        <>
          {items.length > 0 && " · "}
          {footerNote}
        </>
      )}
    </div>
  );
}

/** Up to two initials, as the disc a missing avatar falls back to. */
function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0] ?? "")
    .join("");
  return letters === "" ? "?" : letters.toUpperCase();
}

/**
 * The node itself: every post in the thread is a bead on the line, so an
 * avatar that is missing or fails to load still has to draw something the
 * same size — hence the initials disc rather than the old `display: none`,
 * which left a hole where the graph expected a node.
 *
 * The failure is state, not a DOM mutation: the old handler hid the element
 * behind React's back, so a re-render with the same src un-hid a broken image.
 * Remembering WHICH url broke is what resets it when the post changes.
 */
function Avatar({
  url,
  name,
  small,
  unread,
}: {
  url: string | null;
  name: string;
  small?: boolean;
  unread?: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const className = [
    small ? "avatar avatar-small" : "avatar",
    unread ? "is-unread" : "",
  ]
    .join(" ")
    .trimEnd();
  if (!url || broken === url) {
    return (
      <span className={`${className} avatar-fallback`} aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return (
    <img
      className={className}
      src={url}
      alt=""
      loading="lazy"
      onError={() => setBroken(url)}
    />
  );
}

function MediaAttachment({ post, media, index }: { post: Post; media: MediaItem; index: number }) {
  const src = media.url ?? media.previewImageUrl;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!mediaSourceVisible(src, failedSrc)) return null;
  const href = media.type === "photo" ? `${postUrl(post)}/photo/${index + 1}` : postUrl(post);
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      <img
        src={src}
        alt={media.type === "photo" ? "attached image" : `${media.type} preview`}
        loading="lazy"
        onError={() => setFailedSrc(src)}
      />
      {media.type !== "photo" && (
        <span className="media-badge">
          {media.type === "animated_gif" ? "GIF" : "video"} ↗
        </span>
      )}
    </a>
  );
}

function MediaGrid({ post }: { post: Post }) {
  if (!post.media?.length) return null;
  return (
    <div className="post-media">
      {post.media.map((media, index) => (
        <MediaAttachment key={media.mediaKey} post={post} media={media} index={index} />
      ))}
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
        <Avatar url={post.authorAvatarUrl} name={post.authorName} small />
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
  unread,
  footerNote,
}: {
  post: Post;
  quoted: Record<string, Post>;
  /** Text with reply-context mentions stripped; defaults to the raw text. */
  displayText?: string;
  id?: string;
  className?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  /** Unread posts wear an accent ring on the node, not a dot in the byline. */
  unread?: boolean;
  /** Rendered at the end of the footer line (e.g. the hidden-reply note —
      it is metadata, so it rides the metadata line; owner ruling). */
  footerNote?: ReactNode;
}) {
  return (
    <div id={id} className={className ?? "post"} onClick={onClick}>
      {/*
        Two columns: the LANE, which is the line's own column and holds the
        node, and the BODY, which holds everything the post says. The lane is
        why the connector can be drawn with no measurement — a bead's centre is
        the post's own top padding plus half an avatar, at every depth.
      */}
      <div className="post-lane">
        <Avatar url={post.authorAvatarUrl} name={post.authorName} unread={unread} />
      </div>
      <div className="post-body">
        <div className="post-meta">
          <span className="name">{post.authorName}</span>{" "}
          {post.authorHandle === "unknown" ? (
            /* The ingestion sentinel for a missing author (xapi.ts): not an
               identity, so no link — x.com/unknown is somebody else. */
            <>@{post.authorHandle}</>
          ) : (
            <a href={xProfileUrl(post.authorHandle)} target="_blank" rel="noopener noreferrer">
              @{post.authorHandle}
            </a>
          )}{" "}
          · {formatTime(post.createdAt)}
        </div>
        <ClampedText lines={6} contentKey={displayText ?? post.text}>
          <PostText text={displayText ?? post.text} post={post} />
        </ClampedText>
        <MediaGrid post={post} />
        {post.quotedPostId && <QuoteCard quotedId={post.quotedPostId} quoted={quoted} depth={1} />}
        <MetaCounts post={post} footerNote={footerNote} />
      </div>
    </div>
  );
}

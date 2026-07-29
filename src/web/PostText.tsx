import type { ReactNode } from "react";
import type { Post, UrlEntity } from "../shared/types";

const MENTION = /@(\w{1,15})/g;

function linkifyMentions(chunk: string, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of chunk.matchAll(MENTION)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(chunk.slice(last, index));
    parts.push(
      <a
        key={`${keyBase}-m${i++}`}
        href={`https://x.com/${match[1]}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        @{match[1]}
      </a>,
    );
    last = index + match[0].length;
  }
  if (last < chunk.length) parts.push(chunk.slice(last));
  return parts;
}

function trimTrailingText(nodes: ReactNode[]): ReactNode[] {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (typeof node !== "string") break;
    const trimmed = node.trimEnd();
    if (trimmed === "") {
      nodes.pop();
      continue;
    }
    nodes[i] = trimmed;
    break;
  }
  return nodes;
}

/**
 * Render post text with t.co URLs replaced by their real destinations and
 * @mentions linked to x.com. Hidden from the text: the t.co link for a quoted
 * post (the quote card renders it) and t.co links for attached media (the
 * media renders inline).
 */
export function PostText({ text, post }: { text: string; post: Post }) {
  const urls = post.entities?.urls ?? [];
  const hidden = new Set(
    urls
      .filter(
        (u) =>
          (post.quotedPostId !== null && u.expanded_url.includes(`/status/${post.quotedPostId}`)) ||
          (post.media !== null && u.expanded_url.includes(`/status/${post.id}/`)),
      )
      .map((u) => u.url),
  );

  const nodes: ReactNode[] = [];
  let rest = text;
  let k = 0;
  for (;;) {
    let bestIndex = -1;
    let best: UrlEntity | null = null;
    for (const u of urls) {
      const index = rest.indexOf(u.url);
      if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
        bestIndex = index;
        best = u;
      }
    }
    if (!best) break;
    if (bestIndex > 0) nodes.push(...linkifyMentions(rest.slice(0, bestIndex), `s${k}`));
    if (!hidden.has(best.url)) {
      nodes.push(
        <a key={`u${k}`} href={best.expanded_url} target="_blank" rel="noopener noreferrer">
          {best.display_url}
        </a>,
      );
    }
    rest = rest.slice(bestIndex + best.url.length);
    k++;
  }
  nodes.push(...linkifyMentions(rest, `s${k}`));
  return <>{trimTrailingText(nodes)}</>;
}

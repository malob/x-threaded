import { snowflakeMs } from "../shared/snowflake";
import type { Post } from "../shared/types";

// Re-exported: the definition moved to shared/ once the server needed to date
// a conversation from its root ID, and this module's importers predate that.
export { snowflakeMs };

export interface TreeNode {
  post: Post;
  children: TreeNode[];
  /**
   * Synthetic stand-in for a post the API wouldn't return (deleted, or from a
   * private/suspended account). Its id is the real missing post's ID; replies
   * to it nest underneath.
   */
  placeholder: boolean;
  /**
   * For placeholders: the parent was identified via the reply-count deficit
   * heuristic (see attachPlaceholders) rather than defaulting to the root.
   */
  placementInferred?: boolean;
  /** Post text with reply-context @mentions stripped from the front. */
  displayText: string;
}

/** Stand-in Post for a missing parent; handle "i" makes x.com/i/status/<id> links work. */
function placeholderPost(id: string, conversationId: string, createdAt: string): Post {
  return {
    id,
    conversationId,
    parentId: null,
    authorId: "",
    authorHandle: "i",
    authorName: "",
    authorAvatarUrl: null,
    text: "",
    createdAt,
    metrics: { likes: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: 0, impressions: 0 },
    entities: null,
    quotedPostId: null,
    media: null,
    fetchedAt: "",
  };
}

const LEADING_MENTION = /^@(\w{1,15})(?:\s+|$)/;
const ANY_MENTION = /@(\w{1,15})/g;

/**
 * Strip the leading run of @mentions that are reply-context noise: handles of
 * ancestor authors and anyone mentioned upstream (X pre-fills these when
 * replying, and x.com hides them behind "Replying to …"). Mentions of anyone
 * else, and mid-text mentions, are real content and stay. Falls back to the
 * full text when stripping would leave nothing.
 */
function stripContextMentions(text: string, context: Set<string>): string {
  let rest = text;
  let match: RegExpMatchArray | null;
  while ((match = rest.match(LEADING_MENTION)) && context.has(match[1]!.toLowerCase())) {
    rest = rest.slice(match[0].length);
  }
  const trimmed = rest.trim();
  return trimmed === "" ? text : trimmed;
}

function computeDisplayText(node: TreeNode, context: Set<string>): void {
  node.displayText = stripContextMentions(node.post.text, context);
  const childContext = new Set(context);
  childContext.add(node.post.authorHandle.toLowerCase());
  for (const mention of node.post.text.matchAll(ANY_MENTION)) {
    childContext.add(mention[1]!.toLowerCase());
  }
  for (const child of node.children) {
    computeDisplayText(child, childContext);
  }
}

export function countDescendants(node: TreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

export function subtreeSize(node: TreeNode): number {
  return 1 + countDescendants(node);
}

export function subtreeIds(node: TreeNode): string[] {
  const ids: string[] = [];
  const walk = (n: TreeNode) => {
    ids.push(n.post.id);
    n.children.forEach(walk);
  };
  walk(node);
  return ids;
}

/**
 * IDs a post "owns" for scoped operations (mark read/unread, recursive folds):
 * its whole subtree — except a thread spine segment, which owns only itself
 * and its reply blocks. The following segments are technically its
 * descendants (each segment replies to the previous), but visually they are
 * siblings in the thread column, not children.
 */
export function scopeIds(node: TreeNode, spine: TreeNode[]): string[] {
  const i = spine.indexOf(node);
  if (i === -1) return subtreeIds(node);
  const next = spine[i + 1];
  const replies = node.children.filter((c) => c !== next);
  return [node.post.id, ...replies.flatMap(subtreeIds)];
}

/** The maximal single-child chain starting at a branch head. */
export function collectRun(node: TreeNode): TreeNode[] {
  const run = [node];
  let tail = node;
  while (tail.children.length === 1) {
    tail = tail.children[0]!;
    run.push(tail);
  }
  return run;
}

export type IsOpen = (id: string) => boolean;

/**
 * Posts in rendered document order. Folds closed under `isOpen` hide their
 * contents; omit it to treat every fold as open.
 */
export function documentOrder(root: TreeNode, spine: TreeNode[], isOpen?: IsOpen): TreeNode[] {
  const open = isOpen ?? (() => true);
  const out: TreeNode[] = [];
  const walkBranch = (node: TreeNode): void => {
    const run = collectRun(node);
    const head = run[0]!;
    const tail = run[run.length - 1]!;
    out.push(head);
    if (run.length > 1) {
      if (!open(head.post.id)) return;
      for (const n of run.slice(1)) out.push(n);
    }
    if (tail.children.length > 1) {
      if (!open(tail.post.id)) return;
      for (const child of tail.children) walkBranch(child);
    }
  };
  if (spine.length > 1) {
    for (let i = 0; i < spine.length; i++) {
      const segment = spine[i]!;
      out.push(segment);
      const replies = segment.children.filter((c) => c !== spine[i + 1]);
      if (replies.length > 0 && open(segment.post.id)) {
        for (const reply of replies) walkBranch(reply);
      }
    }
  } else {
    walkBranch(root);
  }
  return out;
}

/**
 * Posts that own a fold: chain heads and fork tails (open by default), and
 * spine segments with replies (closed by default).
 */
export function foldOwnerIds(
  root: TreeNode,
  spine: TreeNode[],
): { branchFolds: Set<string>; segmentFolds: Set<string> } {
  const branchFolds = new Set<string>();
  const segmentFolds = new Set<string>();
  const walkBranch = (node: TreeNode): void => {
    const run = collectRun(node);
    const head = run[0]!;
    const tail = run[run.length - 1]!;
    if (run.length > 1) branchFolds.add(head.post.id);
    if (tail.children.length > 1) {
      branchFolds.add(tail.post.id);
      for (const child of tail.children) walkBranch(child);
    }
  };
  if (spine.length > 1) {
    for (let i = 0; i < spine.length; i++) {
      const segment = spine[i]!;
      const replies = segment.children.filter((c) => c !== spine[i + 1]);
      if (replies.length > 0) segmentFolds.add(segment.post.id);
      for (const reply of replies) walkBranch(reply);
    }
  } else {
    walkBranch(root);
  }
  return { branchFolds, segmentFolds };
}

/** Map of post ID → tree parent (orphans point at the root they were attached to). */
export function parentIds(root: TreeNode): Map<string, string | null> {
  const parents = new Map<string, string | null>([[root.post.id, null]]);
  const walk = (node: TreeNode) => {
    for (const child of node.children) {
      parents.set(child.post.id, node.post.id);
      walk(child);
    }
  };
  walk(root);
  return parents;
}

/**
 * The thread spine: the chain of the root author replying to their own posts,
 * starting at the root. Children are sorted chronologically, so a forked
 * self-reply resolves to the earliest one; later self-replies render as
 * ordinary replies. A result of length 1 means there is no thread.
 */
export function threadSpine(root: TreeNode): TreeNode[] {
  const spine = [root];
  let current = root;
  for (;;) {
    const next = current.children.find((c) => c.post.authorId === root.post.authorId);
    if (!next) break;
    spine.push(next);
    current = next;
  }
  return spine;
}

export function buildTree(rootId: string, posts: Post[]): TreeNode | null {
  const nodes = new Map<string, TreeNode>(
    posts.map((post) => [
      post.id,
      { post, children: [], placeholder: false, displayText: post.text },
    ]),
  );
  const root = nodes.get(rootId);
  if (!root) return null;

  const orphansByParent = new Map<string, TreeNode[]>();
  for (const node of nodes.values()) {
    if (node.post.id === rootId) continue;
    const parent = node.post.parentId ? nodes.get(node.post.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else if (node.post.parentId) {
      const group = orphansByParent.get(node.post.parentId) ?? [];
      group.push(node);
      orphansByParent.set(node.post.parentId, group);
    } else {
      root.children.push(node);
    }
  }

  attachPlaceholders(root, nodes, orphansByParent);

  for (const node of nodes.values()) {
    node.children.sort(byDate);
  }
  root.children.sort(byDate);
  computeDisplayText(root, new Set());
  return root;
}

const byDate = (a: TreeNode, b: TreeNode) => a.post.createdAt.localeCompare(b.post.createdAt);

/**
 * Attach a synthetic placeholder node for each missing parent.
 *
 * Placement: the API only exposes child→parent edges, so a missing post's
 * true parent is unknowable directly. But every post declares its direct
 * reply count, and hidden replies show up as a deficit against the children
 * we can see. If exactly one post has such a deficit and predates the
 * missing post (its ID encodes its creation time), the missing post must be
 * one of that post's hidden replies, so the placeholder nests there
 * (placementInferred). With zero or several candidates the placeholder
 * attaches to the root.
 *
 * This is a heuristic layered on honest structure — to unwind it, replace
 * the body of this function with the root-attachment fallback alone.
 */
function attachPlaceholders(
  root: TreeNode,
  nodes: Map<string, TreeNode>,
  orphansByParent: Map<string, TreeNode[]>,
): void {
  const deficits = new Map<string, number>();
  for (const node of nodes.values()) {
    const deficit = node.post.metrics.replies - node.children.length;
    if (deficit > 0) deficits.set(node.post.id, deficit);
  }

  const missingIds = [...orphansByParent.keys()].sort((a, b) => snowflakeMs(a) - snowflakeMs(b));
  for (const missingId of missingIds) {
    const createdMs = snowflakeMs(missingId);
    const candidates = [...deficits.keys()].filter(
      (id) => Date.parse(nodes.get(id)!.post.createdAt) < createdMs,
    );
    const inferred = candidates.length === 1;
    const host = inferred ? nodes.get(candidates[0]!)! : root;
    if (inferred) {
      const remaining = deficits.get(candidates[0]!)! - 1;
      if (remaining > 0) deficits.set(candidates[0]!, remaining);
      else deficits.delete(candidates[0]!);
    }
    const children = orphansByParent.get(missingId)!;
    children.sort(byDate);
    host.children.push({
      post: placeholderPost(
        missingId,
        root.post.conversationId,
        new Date(createdMs).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
      ),
      children,
      placeholder: true,
      placementInferred: inferred,
      displayText: "",
    });
  }
}

/**
 * Direct replies each post declares beyond what the tree contains — posts
 * that are deleted, private, or simply not returned by the API. Placeholders
 * count as present (each stands for one hidden reply).
 */
export function hiddenReplyCounts(root: TreeNode): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (node: TreeNode): void => {
    if (!node.placeholder) {
      const hidden = node.post.metrics.replies - node.children.length;
      if (hidden > 0) counts.set(node.post.id, hidden);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return counts;
}

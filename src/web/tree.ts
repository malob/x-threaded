import type { Post } from "../shared/types";

export interface TreeNode {
  post: Post;
  children: TreeNode[];
  /** Parent post is missing from the data (deleted or not returned). */
  orphaned: boolean;
  /** Post text with reply-context @mentions stripped from the front. */
  displayText: string;
}

/**
 * Build the reply tree from a flat post list. Replies whose parent is absent
 * attach to the root, flagged as orphaned. Siblings sort chronologically.
 */
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
    posts.map((post) => [post.id, { post, children: [], orphaned: false, displayText: post.text }]),
  );
  const root = nodes.get(rootId);
  if (!root) return null;

  for (const node of nodes.values()) {
    if (node.post.id === rootId) continue;
    const parent = node.post.parentId ? nodes.get(node.post.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      node.orphaned = true;
      root.children.push(node);
    }
  }

  const byDate = (a: TreeNode, b: TreeNode) =>
    a.post.createdAt.localeCompare(b.post.createdAt);
  for (const node of nodes.values()) {
    node.children.sort(byDate);
  }
  computeDisplayText(root, new Set());
  return root;
}

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

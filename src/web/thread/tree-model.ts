/**
 * The adapter from the render layer's tree derivations to the narrow KeyModel
 * the keyboard reducer consumes.
 *
 * It lives here rather than inline in Thread.tsx so the tests drive the same
 * adapter the app does — a keyboard test that built its own model would lock
 * in the test's idea of "visible", not the view's. When the tree derivations
 * collapse into a single-pass model, this is the seam that moves.
 */
import { scopeIds, type TreeNode } from "../tree";
import type { KeyModel } from "./keys";

export interface FoldOwners {
  readonly branchFolds: ReadonlySet<string>;
  readonly segmentFolds: ReadonlySet<string>;
}

export interface KeyModelParts {
  readonly rootId: string;
  readonly spine: TreeNode[];
  readonly owners: FoldOwners;
  readonly parents: ReadonlyMap<string, string | null>;
  readonly byId: ReadonlyMap<string, TreeNode>;
  /** Document order under the current folds. */
  readonly visible: readonly TreeNode[];
  /** Document order ignoring folds. */
  readonly allOrder: readonly TreeNode[];
  readonly unread: ReadonlySet<string>;
}

const postId = (node: TreeNode): string => node.post.id;

export function keyModelOf(parts: KeyModelParts): KeyModel {
  const { rootId, spine, owners, parents, byId, unread } = parts;
  return {
    rootId,
    visible: parts.visible.map(postId),
    allOrder: parts.allOrder.map(postId),
    unread,
    foldOwners: [...owners.branchFolds, ...owners.segmentFolds],
    has: (id) => byId.has(id),
    parentOf: (id) => parents.get(id) ?? null,
    childrenOf: (id) => byId.get(id)?.children.map(postId) ?? [],
    authorHandle: (id) => byId.get(id)?.post.authorHandle,
    isFoldOwner: (id) => owners.branchFolds.has(id) || owners.segmentFolds.has(id),
    startsClosed: (id) => owners.segmentFolds.has(id),
    scopeIds: (id) => {
      const node = byId.get(id);
      return node ? scopeIds(node, spine) : [];
    },
  };
}

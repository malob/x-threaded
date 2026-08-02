/**
 * The conversation as one built structure.
 *
 * `buildThread` reads the posts once and materializes everything the thread
 * view and the keyboard reducer ask of it: the node graph, the thread spine
 * with each segment's reply block, the branch decomposition the renderer draws,
 * fold ownership, scopes, subtree sizes, hidden-reply counts and display text.
 *
 * The point is that no structural rule is written twice. In particular the
 * spine-replies rule — a segment's replies are its children minus the segment
 * that follows it — is computed in exactly one expression, stored in
 * `Segment.replies`, and read from there by document order, fold ownership,
 * scope resolution and the renderer alike. Fold-dependent order is a walk of
 * the already-decided layout, not a second traversal of the post graph.
 */
import { snowflakeMs } from "../../shared/snowflake";
import type { Post } from "../../shared/types";
import type { KeyModel } from "./keys";

/** A post we actually hold. */
export interface PostNode {
  readonly kind: "post";
  readonly id: string;
  readonly post: Post;
  /** Replies, chronological. */
  readonly children: readonly ThreadNode[];
  /** Post text with reply-context @mentions stripped from the front. */
  readonly displayText: string;
}

/**
 * A post the API wouldn't return — deleted, or from a private or suspended
 * account — standing in the tree where its replies say it must have been.
 * There is no Post here because we have none: only the ID (the real missing
 * post's), the time that ID encodes, and where we think it hung.
 */
export interface GapNode {
  readonly kind: "gap";
  readonly id: string;
  /** Decoded from the snowflake ID, the only clock a missing post has. */
  readonly createdAt: string;
  /**
   * The host was identified by the reply-count deficit heuristic (see
   * `attachGaps`) rather than defaulting to the root.
   */
  readonly placementInferred: boolean;
  readonly children: readonly ThreadNode[];
}

export type ThreadNode = PostNode | GapNode;

/**
 * A rendered branch: the maximal single-child chain from its head, then the
 * fork that ended it. Folds are keyed by the owning post — the chain's head
 * collapses `rest`, the run's tail collapses `forks`.
 */
export interface Branch {
  readonly head: ThreadNode;
  /** The rest of the chain below `head`; empty when `head` is not a chain. */
  readonly rest: readonly ThreadNode[];
  /** Last node of the chain — `head` itself when `rest` is empty. */
  readonly tail: ThreadNode;
  /** The tail's replies when it has 2+; empty otherwise. */
  readonly forks: readonly Branch[];
}

/** One post of the thread spine, with the replies that hang off it. */
export interface Segment {
  readonly node: PostNode;
  /**
   * The segment's own replies: its children minus the next spine post. The
   * single site of that rule in the codebase.
   */
  readonly replies: readonly Branch[];
}

/**
 * What the thread column draws: a spine of segments when the root author
 * replied to themselves, and a plain branch otherwise.
 */
export type Layout =
  | { readonly kind: "thread"; readonly segments: readonly Segment[] }
  | { readonly kind: "branch"; readonly branch: Branch };

/** Explicit fold decisions; an absent id means "whatever that post defaults to". */
export type Folds = ReadonlyMap<string, boolean>;

export interface ThreadModel {
  readonly rootId: string;
  readonly root: PostNode;
  /**
   * The root author's self-reply chain, root first. Length 1 means there is no
   * thread — which is also what makes `layout` a branch.
   */
  readonly spine: readonly PostNode[];
  readonly layout: Layout;
  /** Every node reachable from the root. */
  readonly byId: ReadonlyMap<string, ThreadNode>;
  /** Tree parent by id; the root maps to null. */
  readonly parents: ReadonlyMap<string, string | null>;
  /** Chain heads and fork tails: folds that start open. */
  readonly branchFolds: ReadonlySet<string>;
  /** Spine segments with replies: folds that start closed. */
  readonly segmentFolds: ReadonlySet<string>;
  /** Every fold owner, branch folds first — what the global fold commands set. */
  readonly foldOwners: readonly string[];
  /**
   * Direct replies each post declares beyond what the tree holds. Gaps count
   * as present, each standing for one hidden reply; empty when the fetch was
   * truncated, because then a deficit means nothing.
   */
  readonly hiddenReplies: ReadonlyMap<string, number>;
  /** Ids in rendered order as if every fold were open. */
  readonly allOrder: readonly string[];
  /** Ids in rendered order, with the contents of closed folds omitted. */
  visibleIds(folds: Folds): readonly string[];
  /** Whether a fold is open: an explicit decision, else the post's default. */
  isOpen(id: string, folds: Folds): boolean;
  /** The node and its descendants. */
  subtreeSize(id: string): number;
  /** Unread posts in a node's subtree, including the node itself. */
  unreadCount(id: string, unread: ReadonlySet<string>): number;
  /**
   * The ids a post owns for scoped operations: its subtree, except that a
   * spine segment owns only itself and its reply blocks. The segments that
   * follow are its tree descendants but its visual siblings.
   */
  scopeIds(id: string): readonly string[];
  /** The narrow read-only view the keyboard reducer consumes. */
  keyModel(visible: readonly string[], unread: ReadonlySet<string>): KeyModel;
}

export interface BuildOptions {
  /**
   * The conversation is known to be incomplete, so reply-count deficits are
   * meaningless and `hiddenReplies` stays empty.
   */
  readonly truncated?: boolean;
}

const LEADING_MENTION = /^@(\w{1,15})(?:\s+|$)/;
const ANY_MENTION = /@(\w{1,15})/g;

/**
 * x.com's stand-in handle for an author it isn't naming (`/i/status/<id>`).
 * A gap has no author, but the fake Post this union replaced carried "i", and
 * that handle reached the reply-context set below — kept so a reply to a
 * missing post still renders exactly as it did.
 */
const UNKNOWN_HANDLE = "i";

/**
 * Strip the leading run of @mentions that are reply-context noise: handles of
 * ancestor authors and anyone mentioned upstream (X pre-fills these when
 * replying, and x.com hides them behind "Replying to …"). Mentions of anyone
 * else, and mid-text mentions, are real content and stay. Falls back to the
 * full text when stripping would leave nothing.
 */
function stripContextMentions(text: string, context: ReadonlySet<string>): string {
  let rest = text;
  let match: RegExpMatchArray | null;
  while ((match = rest.match(LEADING_MENTION)) && context.has(match[1]!.toLowerCase())) {
    rest = rest.slice(match[0].length);
  }
  const trimmed = rest.trim();
  return trimmed === "" ? text : trimmed;
}

interface Gap {
  readonly createdAt: string;
  readonly placementInferred: boolean;
}

interface Graph {
  readonly posts: ReadonlyMap<string, Post>;
  readonly gaps: ReadonlyMap<string, Gap>;
  readonly childIds: ReadonlyMap<string, string[]>;
}

/**
 * Turn the linked id graph into nodes, top-down, carrying the reply context
 * each post's text is stripped against. Done in one recursion because the
 * context flows from ancestors while the nodes assemble from the leaves up.
 */
function materialize(id: string, context: ReadonlySet<string>, graph: Graph): ThreadNode {
  const kids = graph.childIds.get(id) ?? [];
  const gap = graph.gaps.get(id);
  if (gap) {
    const childContext = new Set(context).add(UNKNOWN_HANDLE);
    return {
      kind: "gap",
      id,
      createdAt: gap.createdAt,
      placementInferred: gap.placementInferred,
      children: kids.map((kid) => materialize(kid, childContext, graph)),
    };
  }
  const post = graph.posts.get(id)!;
  const childContext = new Set(context);
  childContext.add(post.authorHandle.toLowerCase());
  for (const mention of post.text.matchAll(ANY_MENTION)) {
    childContext.add(mention[1]!.toLowerCase());
  }
  return {
    kind: "post",
    id,
    post,
    displayText: stripContextMentions(post.text, context),
    children: kids.map((kid) => materialize(kid, childContext, graph)),
  };
}

/**
 * Decide where each missing parent hung, and mint a gap for it.
 *
 * The API only exposes child→parent edges, so a missing post's true parent is
 * unknowable directly. But every post declares its direct reply count, and
 * hidden replies show up as a deficit against the children we can see. If
 * exactly one post has such a deficit and predates the missing post (its ID
 * encodes its creation time), the missing post must be one of that post's
 * hidden replies, so the gap nests there (`placementInferred`). With zero or
 * several candidates the gap attaches to the root.
 *
 * A missing id that isn't a snowflake can be neither dated nor placed, so it
 * gets no gap at all: its replies attach to the root directly rather than
 * hanging under a node with an invented timestamp.
 *
 * This is a heuristic layered on honest structure — to unwind it, keep only
 * the root-attachment fallback.
 */
function attachGaps(
  rootId: string,
  posts: ReadonlyMap<string, Post>,
  childIds: Map<string, string[]>,
  orphans: ReadonlyMap<string, string[]>,
  kidsOf: (id: string) => string[],
): Map<string, Gap> {
  const gaps = new Map<string, Gap>();
  const deficits = new Map<string, number>();
  for (const post of posts.values()) {
    const deficit = post.metrics.replies - (childIds.get(post.id)?.length ?? 0);
    if (deficit > 0) deficits.set(post.id, deficit);
  }

  const missing: { id: string; createdMs: number }[] = [];
  for (const [missingId, children] of orphans) {
    const createdMs = snowflakeMs(missingId);
    if (createdMs === null) kidsOf(rootId).push(...children);
    else missing.push({ id: missingId, createdMs });
  }

  missing.sort((a, b) => a.createdMs - b.createdMs);
  for (const { id: missingId, createdMs } of missing) {
    const candidates = [...deficits.keys()].filter(
      (id) => Date.parse(posts.get(id)!.createdAt) < createdMs,
    );
    const inferred = candidates.length === 1;
    const hostId = inferred ? candidates[0]! : rootId;
    if (inferred) {
      const remaining = deficits.get(candidates[0]!)! - 1;
      if (remaining > 0) deficits.set(candidates[0]!, remaining);
      else deficits.delete(candidates[0]!);
    }
    gaps.set(missingId, {
      // Zeroed milliseconds: a snowflake dates a post to the ms, but the ISO
      // strings we sort against come from the API at second resolution.
      createdAt: new Date(createdMs).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
      placementInferred: inferred,
    });
    kidsOf(missingId).push(...orphans.get(missingId)!);
    kidsOf(hostId).push(missingId);
  }
  return gaps;
}

export function buildThread(
  rootId: string,
  posts: readonly Post[],
  opts: BuildOptions = {},
): ThreadModel | null {
  const byPost = new Map(posts.map((post) => [post.id, post]));
  if (!byPost.has(rootId)) return null;

  const childIds = new Map<string, string[]>();
  const kidsOf = (id: string): string[] => {
    const existing = childIds.get(id);
    if (existing) return existing;
    const fresh: string[] = [];
    childIds.set(id, fresh);
    return fresh;
  };

  // Link what we hold; a reply whose parent we don't hold waits here for a gap.
  const orphans = new Map<string, string[]>();
  for (const post of byPost.values()) {
    if (post.id === rootId) continue;
    if (!post.parentId) kidsOf(rootId).push(post.id);
    else if (byPost.has(post.parentId)) kidsOf(post.parentId).push(post.id);
    else {
      const group = orphans.get(post.parentId) ?? [];
      group.push(post.id);
      orphans.set(post.parentId, group);
    }
  }

  const gaps = attachGaps(rootId, byPost, childIds, orphans, kidsOf);

  const createdAtOf = (id: string): string => gaps.get(id)?.createdAt ?? byPost.get(id)!.createdAt;
  for (const list of childIds.values()) {
    list.sort((a, b) => createdAtOf(a).localeCompare(createdAtOf(b)));
  }

  const root = materialize(rootId, new Set<string>(), { posts: byPost, gaps, childIds });
  // Unreachable: rootId names a real post, so it never materializes as a gap.
  if (root.kind !== "post") return null;

  const byId = new Map<string, ThreadNode>();
  const parents = new Map<string, string | null>([[rootId, null]]);
  const children = new Map<string, readonly string[]>();
  const subtree = new Map<string, readonly string[]>();
  const hiddenReplies = new Map<string, number>();

  const collect = (node: ThreadNode): readonly string[] => {
    byId.set(node.id, node);
    children.set(
      node.id,
      node.children.map((child) => child.id),
    );
    if (node.kind === "post" && !opts.truncated) {
      const hidden = node.post.metrics.replies - node.children.length;
      if (hidden > 0) hiddenReplies.set(node.id, hidden);
    }
    const ids: string[] = [node.id];
    for (const child of node.children) {
      parents.set(child.id, node.id);
      for (const id of collect(child)) ids.push(id);
    }
    subtree.set(node.id, ids);
    return ids;
  };
  collect(root);

  /**
   * The spine: the root author replying to their own posts, from the root
   * down. Children are chronological, so a forked self-reply resolves to the
   * earliest; later self-replies render as ordinary replies.
   */
  const spine: PostNode[] = [root];
  for (let current = root; ; ) {
    const next = current.children.find(
      (child): child is PostNode =>
        child.kind === "post" && child.post.authorId === root.post.authorId,
    );
    if (!next) break;
    spine.push(next);
    current = next;
  }

  const branchOf = (node: ThreadNode): Branch => {
    const rest: ThreadNode[] = [];
    let tail = node;
    while (tail.children.length === 1) {
      tail = tail.children[0]!;
      rest.push(tail);
    }
    return {
      head: node,
      rest,
      tail,
      forks: tail.children.length > 1 ? tail.children.map(branchOf) : [],
    };
  };

  const layout: Layout =
    spine.length > 1
      ? {
          kind: "thread",
          segments: spine.map((node, i) => ({
            node,
            replies: node.children.filter((child) => child !== spine[i + 1]).map(branchOf),
          })),
        }
      : { kind: "branch", branch: branchOf(root) };

  const branchFolds = new Set<string>();
  const segmentFolds = new Set<string>();
  const noteFolds = (branch: Branch): void => {
    if (branch.rest.length > 0) branchFolds.add(branch.head.id);
    if (branch.forks.length > 0) {
      branchFolds.add(branch.tail.id);
      for (const fork of branch.forks) noteFolds(fork);
    }
  };
  if (layout.kind === "thread") {
    for (const segment of layout.segments) {
      if (segment.replies.length > 0) segmentFolds.add(segment.node.id);
      for (const reply of segment.replies) noteFolds(reply);
    }
  } else {
    noteFolds(layout.branch);
  }

  // A segment's scope stops at its own reply blocks; everything else owns its
  // whole subtree. (A one-post spine needs no entry: the root's subtree already
  // is its reply blocks.)
  const scope = new Map<string, readonly string[]>(subtree);
  if (layout.kind === "thread") {
    for (const segment of layout.segments) {
      scope.set(segment.node.id, [
        segment.node.id,
        ...segment.replies.flatMap((reply) => subtree.get(reply.head.id)!),
      ]);
    }
  }

  const orderWith = (open: (id: string) => boolean): string[] => {
    const out: string[] = [];
    const walk = (branch: Branch): void => {
      out.push(branch.head.id);
      if (branch.rest.length > 0) {
        if (!open(branch.head.id)) return;
        for (const node of branch.rest) out.push(node.id);
      }
      if (branch.forks.length > 0) {
        if (!open(branch.tail.id)) return;
        for (const fork of branch.forks) walk(fork);
      }
    };
    if (layout.kind === "thread") {
      for (const segment of layout.segments) {
        out.push(segment.node.id);
        if (segment.replies.length > 0 && open(segment.node.id)) {
          for (const reply of segment.replies) walk(reply);
        }
      }
    } else {
      walk(layout.branch);
    }
    return out;
  };

  const allOrder = orderWith(() => true);
  const isOpen = (id: string, folds: Folds): boolean => folds.get(id) ?? !segmentFolds.has(id);
  const scopeIds = (id: string): readonly string[] => scope.get(id) ?? [];

  return {
    rootId,
    root,
    spine,
    layout,
    byId,
    parents,
    branchFolds,
    segmentFolds,
    foldOwners: [...branchFolds, ...segmentFolds],
    hiddenReplies,
    allOrder,
    visibleIds: (folds) => orderWith((id) => isOpen(id, folds)),
    isOpen,
    subtreeSize: (id) => subtree.get(id)?.length ?? 0,
    unreadCount: (id, unread) => {
      let count = 0;
      for (const member of subtree.get(id) ?? []) if (unread.has(member)) count++;
      return count;
    },
    scopeIds,
    keyModel: (visible, unread) => ({
      rootId,
      visible,
      allOrder,
      unread,
      foldOwners: [...branchFolds, ...segmentFolds],
      has: (id) => byId.has(id),
      parentOf: (id) => parents.get(id) ?? null,
      childrenOf: (id) => children.get(id) ?? [],
      authorHandle: (id) => {
        const node = byId.get(id);
        return node?.kind === "post" ? node.post.authorHandle : undefined;
      },
      isFoldOwner: (id) => branchFolds.has(id) || segmentFolds.has(id),
      startsClosed: (id) => segmentFolds.has(id),
      scopeIds,
    }),
  };
}

/**
 * The model for a conversation whose root post is missing. Nothing renders in
 * that case, but the keydown listener is registered before we know it, and it
 * needs something to read.
 */
export function emptyKeyModel(rootId: string): KeyModel {
  return {
    rootId,
    visible: [],
    allOrder: [],
    unread: new Set(),
    foldOwners: [],
    has: () => false,
    parentOf: () => null,
    childrenOf: () => [],
    authorHandle: () => undefined,
    isFoldOwner: () => false,
    startsClosed: () => false,
    scopeIds: () => [],
  };
}

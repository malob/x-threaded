import type { QueryClient } from "@tanstack/react-query";
import type { ConversationResponse } from "../../shared/types";

/** One cache slot per conversation. */
export const conversationKey = (rootId: string) => ["conversation", rootId] as const;

export type ConversationReadIntent = {
  readonly kind: "set";
  readonly ids: readonly string[];
  readonly read: boolean;
};

export type LoadedConversationResponse<T extends ConversationResponse = ConversationResponse> =
  T & {
    /** A preceding newest-post refresh supplied the freshness this cached load would request. */
    readonly refreshCovered?: true;
  };

interface ReadOperation {
  readonly id: number;
  intent: ConversationReadIntent;
}

interface ProtectedRead {
  readonly intent: ConversationReadIntent;
  /** Root-unknown responses that were still capable of landing when this write succeeded. */
  readonly responses: Set<number>;
}

interface ConversationOwnership {
  /** Latest response from the server, before local read intentions. */
  base: ConversationResponse | undefined;
  /** Successful writes kept until the whole active batch has drained. */
  readonly applied: ReadOperation[];
  /** Writes reflected optimistically but not settled yet. */
  readonly pending: ReadOperation[];
  /** Network completion plus settlement of the preceding operation. */
  tail: Promise<void>;
  /** Read requests and response writers that have not finished their queue step. */
  activeSteps: number;
  /** Conversation-producing requests currently owned by this root. */
  activeResponseSteps: number;
}

function applyReadIntent(
  conversation: ConversationResponse,
  intent: ConversationReadIntent,
): ConversationResponse {
  const present = new Set(conversation.posts.map((post) => post.id));
  const unread = new Set(conversation.unreadIds);
  for (const id of intent.ids) {
    if (!present.has(id)) continue;
    if (intent.read) unread.delete(id);
    else unread.add(id);
  }
  return { ...conversation, unreadIds: [...unread] };
}

/**
 * Owns read-state while writes are in flight.
 *
 * Known-root requests form one FIFO per conversation, while the cache always
 * replays every active intention in invocation order. Successful earlier
 * writes stay in that replay journal until later writes drain. Root-unknown
 * responses separately retain only the successful reads they overlap, and
 * every response commit is versioned against its actual destination root. A
 * failure removes only its operation; later optimistic intent remains on top.
 */
class ConversationCacheOwnership {
  readonly roots = new Map<string, ConversationOwnership>();
  /** Newest successfully committed response invocation for each actual cache root. */
  readonly responseVersions = new Map<string, number>();
  /** Successful newest-post refresh count when each root was last observed. */
  readonly refreshSuccessEpochs = new Map<string, number>();
  /** Responses whose target root is not known until their network request resolves. */
  readonly unknownResponses = new Set<number>();
  /** Concurrent root-unknown requests need an authoritative destination re-read. */
  readonly overlappingUnknownResponses = new Set<number>();
  /** Successful reads retained only for the unknown responses they overlapped. */
  readonly protectedReads = new Map<string, ProtectedRead[]>();
  nextInvocation = 0;

  constructor(readonly queryClient: QueryClient) {}

  private stateFor(rootId: string): ConversationOwnership {
    const existing = this.roots.get(rootId);
    if (existing) return existing;
    const state: ConversationOwnership = {
      base: this.queryClient.getQueryData<ConversationResponse>(conversationKey(rootId)),
      applied: [],
      pending: [],
      tail: Promise.resolve(),
      activeSteps: 0,
      activeResponseSteps: 0,
    };
    this.roots.set(rootId, state);
    return state;
  }

  private enqueue<T>(state: ConversationOwnership, step: () => Promise<T>): Promise<T> {
    const queued = state.tail.then(step);
    // A rejected operation cannot poison the root's queue behind it.
    state.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private render(rootId: string, state: ConversationOwnership): void {
    if (!state.base) return;
    const operations = [...state.applied, ...state.pending].sort((a, b) => a.id - b.id);
    const visible = operations.reduce(
      (conversation, operation) => applyReadIntent(conversation, operation.intent),
      state.base,
    );
    this.queryClient.setQueryData<ConversationResponse>(conversationKey(rootId), visible);
  }

  private commit(
    rootId: string,
    conversation: ConversationResponse,
    responseId: number,
  ): boolean {
    // `responseId` is allocated when the request is invoked. An unknown-root
    // response claims its destination only when it resolves, but once a newer
    // destination response has committed, an older completion cannot replace
    // any part of that payload.
    const currentVersion = this.responseVersions.get(rootId);
    if (currentVersion !== undefined && responseId < currentVersion) return false;
    this.responseVersions.set(rootId, responseId);

    const state = this.roots.get(rootId);
    if (!state) {
      this.queryClient.setQueryData<ConversationResponse>(conversationKey(rootId), conversation);
      return true;
    }
    state.base = conversation;
    this.render(rootId, state);
    return true;
  }

  runRead<T>(
    rootId: string,
    intent: ConversationReadIntent,
    request: (resolvedIntent: ConversationReadIntent) => Promise<T>,
    prepare?: (state: ConversationOwnership) => ConversationReadIntent,
  ): Promise<T> {
    const state = this.stateFor(rootId);
    const operation: ReadOperation = { id: this.nextInvocation++, intent };
    state.activeSteps += 1;
    state.pending.push(operation);
    this.render(rootId, state);

    return this.enqueue(state, async () => {
      let value: T;
      try {
        // Mark-all resolves its concrete ids here, after every earlier
        // conversation response has committed but before its request is sent.
        // Its optimistic registration still covers the posts visible at click
        // time; this refreshes that intent when an earlier queued response
        // introduced more posts.
        if (prepare) {
          operation.intent = prepare(state);
          this.render(rootId, state);
        }
        value = await request(operation.intent);
      } catch (error) {
        this.settleRead(rootId, state, operation, false);
        throw error;
      }
      this.settleRead(rootId, state, operation, true);
      return value;
    });
  }

  runResponseWrite<T extends ConversationResponse>(
    rootId: string,
    request: () => Promise<T>,
    protectedResponseId?: number,
    refreshCovered = false,
  ): Promise<T> {
    const responseId = this.nextInvocation++;
    const state = this.stateFor(rootId);
    state.activeSteps += 1;
    state.activeResponseSteps += 1;

    return this.enqueue(state, async () => {
      try {
        const conversation = await request();
        // Every production read now uses this queue, but cancel a legacy or
        // externally-started TanStack query before replacing the cache too.
        const canceling = this.queryClient.cancelQueries({
          queryKey: conversationKey(rootId),
          exact: true,
        });
        const cacheConversation =
          protectedResponseId === undefined
            ? conversation
            : this.applyProtectedReads(protectedResponseId, conversation);
        this.commit(rootId, cacheConversation, responseId);
        if (refreshCovered) {
          this.refreshSuccessEpochs.set(
            rootId,
            (this.refreshSuccessEpochs.get(rootId) ?? 0) + 1,
          );
        }
        await canceling;
        return conversation;
      } finally {
        this.finishResponseStep(rootId, state);
      }
    });
  }

  /**
   * Run a response whose cache root is unknowable until it resolves.
   *
   * The optional displayed root owns its network ordering. Separately, the
   * response gets an invocation identity. It both orders the eventual payload
   * against every other response for its actual target and retains any
   * successful read that overlaps it. A different target can therefore replay
   * exact local intent after its ordinary queue drains, without an indefinite
   * overlay or a late older response replacing newer payload.
   */
  runUnknownResponseWrite<T extends ConversationResponse>(
    ownerRootId: string | null,
    request: () => Promise<T>,
    reconcile?: (rootId: string) => Promise<ConversationResponse>,
  ): Promise<LoadedConversationResponse<T>> {
    const responseId = this.nextInvocation++;
    if (this.unknownResponses.size > 0) {
      this.overlappingUnknownResponses.add(responseId);
      for (const activeResponseId of this.unknownResponses) {
        this.overlappingUnknownResponses.add(activeResponseId);
      }
    }
    const overlappedRoots = new Set(
      [...this.roots]
        .filter(([, state]) => state.activeResponseSteps > 0)
        .map(([rootId]) => rootId),
    );
    const refreshEpochs = new Map(this.refreshSuccessEpochs);
    this.unknownResponses.add(responseId);

    if (ownerRootId === null) {
      return this.runUnownedResponse(
        responseId,
        overlappedRoots,
        refreshEpochs,
        request,
        reconcile,
      );
    }

    const state = this.stateFor(ownerRootId);
    state.activeSteps += 1;
    state.activeResponseSteps += 1;
    return this.runOwnedUnknownResponse(
      responseId,
      overlappedRoots,
      refreshEpochs,
      ownerRootId,
      state,
      request,
      reconcile,
    );
  }

  private async runOwnedUnknownResponse<T extends ConversationResponse>(
    responseId: number,
    overlappedRoots: ReadonlySet<string>,
    refreshEpochs: ReadonlyMap<string, number>,
    ownerRootId: string,
    ownerState: ConversationOwnership,
    request: () => Promise<T>,
    reconcile?: (rootId: string) => Promise<ConversationResponse>,
  ): Promise<LoadedConversationResponse<T>> {
    try {
      const conversation = await this.enqueue(ownerState, async () => {
        try {
          const response = await request();
          if (response.rootId === ownerRootId) {
            await this.commitResponse(responseId, response);
          }
          return response;
        } finally {
          this.finishResponseStep(ownerRootId, ownerState);
        }
      });

      if (conversation.rootId !== ownerRootId) {
        const refreshCovered = await this.commitUnknownTarget(
          responseId,
          overlappedRoots,
          refreshEpochs,
          conversation,
          reconcile,
        );
        return this.withRefreshCoverage(conversation, refreshCovered);
      }
      const refreshCovered = this.refreshCoveredSince(refreshEpochs, ownerRootId);
      if (this.overlappingUnknownResponses.has(responseId) && reconcile) {
        await this.reconcileUnknownTarget(responseId, conversation, reconcile);
        return this.withRefreshCoverage(
          conversation,
          this.refreshCoveredSince(refreshEpochs, ownerRootId),
        );
      }
      return this.withRefreshCoverage(conversation, refreshCovered);
    } finally {
      this.finishUnknownResponse(responseId);
    }
  }

  private async runUnownedResponse<T extends ConversationResponse>(
    responseId: number,
    overlappedRoots: ReadonlySet<string>,
    refreshEpochs: ReadonlyMap<string, number>,
    request: () => Promise<T>,
    reconcile?: (rootId: string) => Promise<ConversationResponse>,
  ): Promise<LoadedConversationResponse<T>> {
    try {
      const conversation = await request();
      const refreshCovered = await this.commitUnknownTarget(
        responseId,
        overlappedRoots,
        refreshEpochs,
        conversation,
        reconcile,
      );
      return this.withRefreshCoverage(conversation, refreshCovered);
    } finally {
      this.finishUnknownResponse(responseId);
    }
  }

  private async commitUnknownTarget<T extends ConversationResponse>(
    responseId: number,
    overlappedRoots: ReadonlySet<string>,
    refreshEpochs: ReadonlyMap<string, number>,
    conversation: T,
    reconcile?: (rootId: string) => Promise<ConversationResponse>,
  ): Promise<boolean> {
    const rootId = conversation.rootId;
    const targetState = this.roots.get(rootId);
    const targetHasResponse = (targetState?.activeResponseSteps ?? 0) > 0;
    const currentVersion = this.responseVersions.get(rootId);
    const superseded = currentVersion !== undefined && responseId < currentVersion;
    const needsReconcile =
      overlappedRoots.has(rootId) ||
      targetHasResponse ||
      superseded ||
      this.overlappingUnknownResponses.has(responseId);
    if (!reconcile || !needsReconcile) {
      await this.commitResponse(responseId, conversation);
      return this.refreshCoveredSince(refreshEpochs, rootId);
    }

    await this.reconcileUnknownTarget(responseId, conversation, reconcile);
    return this.refreshCoveredSince(refreshEpochs, rootId);
  }

  private async reconcileUnknownTarget(
    responseId: number,
    conversation: ConversationResponse,
    reconcile: (rootId: string) => Promise<ConversationResponse>,
  ): Promise<void> {
    const rootId = conversation.rootId;
    await this.runResponseWrite(
      rootId,
      async () => {
        try {
          return this.withReceipt(await reconcile(rootId), conversation);
        } catch {
          // The root-unknown request already succeeded (and may already have
          // spent money). A free, auxiliary GET must not turn that success
          // into an unreceipted failure. Prefer the paid response while its
          // invocation is newest; otherwise preserve the newer destination
          // base and attach only this request's receipt.
          const currentVersion = this.responseVersions.get(rootId);
          const newerDestinationOwnsRoot =
            currentVersion !== undefined && currentVersion > responseId;
          const current =
            this.roots.get(rootId)?.base ??
            this.queryClient.getQueryData<ConversationResponse>(conversationKey(rootId));
          const fallback = newerDestinationOwnsRoot && current ? current : conversation;
          return this.withReceipt(fallback, conversation);
        }
      },
      responseId,
      false,
    );
  }

  private async commitResponse(
    responseId: number,
    conversation: ConversationResponse,
  ): Promise<boolean> {
    const rootId = conversation.rootId;
    const canceling = this.queryClient.cancelQueries({
      queryKey: conversationKey(rootId),
      exact: true,
    });
    const protectedConversation = this.applyProtectedReads(responseId, conversation);
    const committed = this.commit(rootId, protectedConversation, responseId);
    await canceling;
    return committed;
  }

  private applyProtectedReads(
    responseId: number,
    conversation: ConversationResponse,
  ): ConversationResponse {
    return (this.protectedReads.get(conversation.rootId) ?? [])
      .filter((read) => read.responses.has(responseId))
      .reduce(
        (current, read) => applyReadIntent(current, read.intent),
        conversation as ConversationResponse,
      );
  }

  private withReceipt(
    authoritative: ConversationResponse,
    triggeringResponse: ConversationResponse,
  ): ConversationResponse {
    const reconciled = { ...authoritative };
    if (triggeringResponse.cost) reconciled.cost = triggeringResponse.cost;
    else delete reconciled.cost;
    return reconciled;
  }

  private withRefreshCoverage<T extends ConversationResponse>(
    conversation: T,
    refreshCovered: boolean,
  ): LoadedConversationResponse<T> {
    return refreshCovered ? { ...conversation, refreshCovered: true } : conversation;
  }

  private refreshCoveredSince(
    refreshEpochs: ReadonlyMap<string, number>,
    rootId: string,
  ): boolean {
    return (this.refreshSuccessEpochs.get(rootId) ?? 0) > (refreshEpochs.get(rootId) ?? 0);
  }

  private settleRead(
    rootId: string,
    state: ConversationOwnership,
    operation: ReadOperation,
    succeeded: boolean,
  ): void {
    const index = state.pending.findIndex((candidate) => candidate.id === operation.id);
    if (index >= 0) {
      state.pending.splice(index, 1);
      if (succeeded) {
        state.applied.push(operation);
        this.protectRead(rootId, operation);
      }
    }
    this.render(rootId, state);
    this.finishStep(rootId, state);
  }

  private finishStep(rootId: string, state: ConversationOwnership): void {
    state.activeSteps -= 1;
    if (state.activeSteps === 0 && this.roots.get(rootId) === state) {
      this.roots.delete(rootId);
    }
  }

  private finishResponseStep(rootId: string, state: ConversationOwnership): void {
    state.activeResponseSteps -= 1;
    this.finishStep(rootId, state);
  }

  private protectRead(rootId: string, operation: ReadOperation): void {
    if (this.unknownResponses.size === 0) return;
    const protectedRead: ProtectedRead = {
      intent: { ...operation.intent, ids: [...operation.intent.ids] },
      responses: new Set(this.unknownResponses),
    };
    const reads = this.protectedReads.get(rootId);
    if (reads) reads.push(protectedRead);
    else this.protectedReads.set(rootId, [protectedRead]);
  }

  private finishUnknownResponse(responseId: number): void {
    this.unknownResponses.delete(responseId);
    this.overlappingUnknownResponses.delete(responseId);
    for (const [rootId, reads] of this.protectedReads) {
      for (const read of reads) read.responses.delete(responseId);
      const remaining = reads.filter((read) => read.responses.size > 0);
      if (remaining.length > 0) this.protectedReads.set(rootId, remaining);
      else this.protectedReads.delete(rootId);
    }
  }
}

const OWNERSHIP = new WeakMap<QueryClient, ConversationCacheOwnership>();

function ownershipFor(queryClient: QueryClient): ConversationCacheOwnership {
  const existing = OWNERSHIP.get(queryClient);
  if (existing) return existing;
  const ownership = new ConversationCacheOwnership(queryClient);
  OWNERSHIP.set(queryClient, ownership);
  return ownership;
}

/**
 * Apply an optimistic read intent now and issue its server request in the
 * conversation's invocation-order queue.
 */
export function runConversationReadWrite<T>(
  queryClient: QueryClient,
  rootId: string,
  intent: ConversationReadIntent,
  request: () => Promise<T>,
): Promise<T> {
  // Cancellation is initiated synchronously before the optimistic snapshot;
  // the request itself waits for cancellation to finish.
  const canceling = queryClient.cancelQueries({ queryKey: conversationKey(rootId), exact: true });
  return ownershipFor(queryClient).runRead(rootId, intent, async () => {
    await canceling;
    return request();
  });
}

/**
 * Mark every post that exists when this FIFO step starts read.
 *
 * The initial ids render optimistically. Once earlier queued responses have
 * committed, the operation replaces them with the exact ids it sends to the
 * server. Responses invoked later therefore cannot be consumed by this write.
 */
export function runConversationMarkAllRead<T>(
  queryClient: QueryClient,
  rootId: string,
  request: (ids: readonly string[]) => Promise<T>,
): Promise<T> {
  const initial = queryClient.getQueryData<ConversationResponse>(conversationKey(rootId));
  const canceling = queryClient.cancelQueries({ queryKey: conversationKey(rootId), exact: true });
  return ownershipFor(queryClient).runRead(
    rootId,
    { kind: "set", ids: initial?.posts.map((post) => post.id) ?? [], read: true },
    async (intent) => {
      await canceling;
      return request(intent.ids);
    },
    (state) => ({
      kind: "set",
      ids: state.base?.posts.map((post) => post.id) ?? [],
      read: true,
    }),
  );
}

/**
 * Run a conversation-producing writer in the same FIFO as read-state writes.
 * Its queue step owns both the request and cache commit, so invocation order
 * also determines response-commit order for this conversation.
 */
export interface ConversationResponseWriteOptions {
  /** Only newest-post refreshes cover App's automatic refresh after a cached load. */
  readonly coversRefresh?: boolean;
}

export function runConversationResponseWrite<T extends ConversationResponse>(
  queryClient: QueryClient,
  rootId: string,
  request: () => Promise<T>,
  options: ConversationResponseWriteOptions = {},
): Promise<T> {
  const canceling = queryClient.cancelQueries({ queryKey: conversationKey(rootId), exact: true });
  return ownershipFor(queryClient).runResponseWrite(rootId, async () => {
    await canceling;
    return request();
  }, undefined, options.coversRefresh ?? false);
}

/**
 * Run a root-unknown load behind the conversation whose controls are visible.
 *
 * The displayed root owns the request's network ordering. Once the actual
 * target becomes known, its cache commit also replays every successful target
 * read that overlapped this response—even if that target's ordinary queue has
 * already drained. An ownerless load gets the same short-lived protection.
 */
export function runConversationLoadWrite<T extends ConversationResponse>(
  queryClient: QueryClient,
  ownerRootId: string | null,
  request: () => Promise<T>,
  reconcile?: (rootId: string) => Promise<ConversationResponse>,
): Promise<LoadedConversationResponse<T>> {
  const canceling =
    ownerRootId === null
      ? Promise.resolve()
      : queryClient.cancelQueries({
          queryKey: conversationKey(ownerRootId),
          exact: true,
        });
  return ownershipFor(queryClient).runUnknownResponseWrite(
    ownerRootId,
    async () => {
      await canceling;
      return request();
    },
    reconcile,
  );
}

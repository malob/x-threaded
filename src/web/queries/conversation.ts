import {
  queryOptions,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ConversationResponse, RefreshResponse } from "../../shared/types";
import {
  getConversation,
  loadConversation,
  refreshConversation,
  resumeConversation,
  setReadState,
} from "../api";
import {
  conversationKey,
  runConversationLoadWrite,
  runConversationMarkAllRead,
  runConversationReadWrite,
  runConversationResponseWrite,
} from "./conversation-cache";

export { conversationKey } from "./conversation-cache";

/**
 * Cache-only query options. Conversation network reads are explicit ownership
 * operations below; a query observer may subscribe to this slot but cannot
 * start an unversioned refetch of it.
 */
export function conversationQueryOptions(rootId: string) {
  return queryOptions<ConversationResponse>({
    queryKey: conversationKey(rootId),
    queryFn: skipToken,
  });
}

/** Read the server's stored snapshot in the same known-root FIFO as writers. */
export function fetchStoredConversation(
  queryClient: QueryClient,
  rootId: string,
): Promise<ConversationResponse> {
  return runConversationResponseWrite(queryClient, rootId, () => getConversation(rootId));
}

/**
 * The conversation on screen. `null` while the inbox is showing; the fetches
 * that fill this cache are all started explicitly (see `App.openPost`), so an
 * open conversation is served from the slot rather than re-read here.
 */
export function useConversation(rootId: string | null) {
  return useQuery(conversationQueryOptions(rootId ?? ""));
}

/**
 * Fetch a conversation from X. Costs money, so it only ever runs from a
 * submitted URL or an inbox card whose price the reader has already seen.
 */
export function useLoadConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ url, ownerRootId }: { url: string; ownerRootId: string | null }) =>
      runConversationLoadWrite(
        queryClient,
        ownerRootId,
        () => loadConversation(url),
        (rootId) => getConversation(rootId),
      ),
  });
}

export interface ConversationWriteOptions {
  /** The rootId is the one this refresh asked for, not whatever is on screen. */
  onRefreshed: (rootId: string, response: RefreshResponse) => void;
  onError: (message: string) => void;
}

/** Which of the two billable writers is holding a conversation's lock. */
type Writer = "refresh" | "resume";

/**
 * The two ways of buying more of a conversation — "what's new since" and "what
 * came before" — behind one lock per rootId.
 *
 * They share a lock instead of owning one each because a mutation only ever
 * describes its latest call: `isPending` and `variables` belong to the most
 * recent `mutate`, so with a resume of A in flight, starting a resume of B made
 * A report idle. A's button re-enabled while its POST was still running, and a
 * second click bought the same posts twice. Tracking per rootId is what fixes
 * that; tracking per mutation cannot.
 *
 * Sharing one lock between the two writers is the other half. A refresh and a
 * resume of the same conversation can overlap, and the response generated
 * first can land last, painting a conversation over a strictly more complete
 * one. Serializing the two writers per conversation is what prevents that
 * clobber, so refusing a resume while that conversation is refreshing (and
 * vice versa) is the point of the shared lock, not a limitation of it.
 *
 * Who holds what is kept twice, on purpose. The ref is the lock: taking it has
 * to be synchronous, because two writes started in one tick — a handler that
 * calls both, two async continuations resolving in the same microtask — both
 * read React state from before either of them, and the second one is a
 * duplicate charge. (Driving the built app against a stub server, a resume and
 * a refresh dispatched in a single tick did exactly that with a state-only
 * lock: two POSTs, two bills.) The state is how the lock is rendered — the
 * buttons that stay disabled during a write come from it — and it is only ever
 * written from the ref, so it cannot disagree with it.
 */
export function useConversationWrites({ onRefreshed, onError }: ConversationWriteOptions) {
  const queryClient = useQueryClient();
  const held = useRef(new Map<string, Writer>());
  const [writers, setWriters] = useState<ReadonlyMap<string, Writer>>(() => new Map());

  const release = (rootId: string) => {
    held.current.delete(rootId);
    setWriters(new Map(held.current));
  };

  const refreshMutation = useMutation({
    mutationFn: (rootId: string) =>
      runConversationResponseWrite(
        queryClient,
        rootId,
        () => refreshConversation(rootId),
        { coversRefresh: true },
      ),
    onSuccess: (fresh, rootId) => onRefreshed(rootId, fresh),
    onError: (error) => onError(error.message),
    onSettled: (_data, _error, rootId) => release(rootId),
  });

  const resumeMutation = useMutation({
    mutationFn: (rootId: string) =>
      runConversationResponseWrite(queryClient, rootId, () => resumeConversation(rootId)),
    onError: (error) => onError(error.message),
    onSettled: (_data, _error, rootId) => release(rootId),
  });

  /** Take the conversation's lock and write, or refuse: someone already has it. */
  const write = (rootId: string, writer: Writer, run: () => void) => {
    if (held.current.has(rootId)) return;
    held.current.set(rootId, writer);
    setWriters(new Map(held.current));
    run();
  };

  return {
    /** Buy whatever is new in a conversation (a `since_id` read at X). */
    refresh: (rootId: string) => write(rootId, "refresh", () => refreshMutation.mutate(rootId)),
    /**
     * Buy the older replies a stopped fetch never reached. Deliberately manual:
     * the conversation reads fine without them, and going back for them costs
     * money, so it happens when someone asks for it.
     */
    resume: (rootId: string) => write(rootId, "resume", () => resumeMutation.mutate(rootId)),
    /** Per conversation, so a write to one never speaks for another. */
    isRefreshing: (rootId: string) => writers.get(rootId) === "refresh",
    isResuming: (rootId: string) => writers.get(rootId) === "resume",
  };
}

export interface SetReadVariables {
  rootId: string;
  ids: string[];
  read: boolean;
}

/**
 * Mark posts read or unread, optimistically.
 *
 * Both read-write hooks share the per-conversation queue in
 * `conversation-cache.ts`. Registration applies the intent optimistically;
 * the HTTP request waits for every earlier read write on that conversation,
 * and settlement replays the remaining intentions over the latest server
 * response. That makes a rollback operation-owned rather than snapshot-owned.
 */
export function useSetRead({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rootId, ids, read }: SetReadVariables) => {
      const requestedIds = [...ids];
      return runConversationReadWrite(
        queryClient,
        rootId,
        { kind: "set", ids: requestedIds, read },
        () => setReadState(requestedIds, read),
      );
    },
    onError: (error) => onError(error.message),
  });
}

/**
 * Mark every post in a conversation read, optimistically.
 *
 * Uses the same queue and overlay as `useSetRead`, so a targeted operation
 * invoked immediately after this one is already visible while this request is
 * still on the wire, and remains visible if this request fails.
 */
export function useMarkAllRead({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rootId: string) =>
      runConversationMarkAllRead(queryClient, rootId, (ids) => setReadState([...ids], true)),
    onError: (error) => onError(error.message),
  });
}

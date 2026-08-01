import { queryOptions, skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { ConversationResponse, RefreshResponse } from "../../shared/types";
import {
  getConversation,
  loadConversation,
  markConversationRead,
  refreshConversation,
  resumeConversation,
  setReadState,
} from "../api";

/**
 * One cache slot per conversation. Everything that produces a conversation
 * writes to the slot named by the rootId it was asked about, which is what
 * stops a slow response from painting itself over whatever the reader has
 * since navigated to: a late answer lands in its own slot, unobserved.
 */
export const conversationKey = (rootId: string) => ["conversation", rootId] as const;

export function conversationQueryOptions(rootId: string) {
  return queryOptions({
    queryKey: conversationKey(rootId),
    // Reading a stored conversation costs nothing — it never touches X — so
    // this one can take TanStack's signal and be abandoned mid-flight when the
    // reader moves on.
    queryFn: ({ signal }) => getConversation(rootId, signal),
  });
}

/**
 * The conversation on screen. `null` while the inbox is showing; the fetches
 * that fill this cache are all started explicitly (see `App.openPost`), so an
 * open conversation is served from the slot rather than re-read here.
 */
export function useConversation(rootId: string | null) {
  const options = conversationQueryOptions(rootId ?? "");
  return useQuery({
    ...options,
    queryFn: rootId === null ? skipToken : options.queryFn,
  });
}

/** Apply a read/unread change to a cached conversation. */
function withReadState(
  conversation: ConversationResponse,
  ids: string[],
  read: boolean,
): ConversationResponse {
  const unread = new Set(conversation.unreadIds);
  for (const id of ids) {
    if (read) unread.delete(id);
    else unread.add(id);
  }
  return { ...conversation, unreadIds: [...unread] };
}

/**
 * Fetch a conversation from X. Costs money, so it only ever runs from a
 * submitted URL or an inbox card whose price the reader has already seen.
 */
export function useLoadConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => loadConversation(url),
    onSuccess: (conversation) => {
      // Seed the slot before the caller shows it, so the query that renders it
      // finds fresh data and doesn't re-read what we were just handed.
      queryClient.setQueryData<ConversationResponse>(
        conversationKey(conversation.rootId),
        conversation,
      );
    },
  });
}

export interface RefreshOptions {
  /** The rootId is the one this refresh asked for, not whatever is on screen. */
  onRefreshed: (rootId: string, response: RefreshResponse) => void;
  onError: (message: string) => void;
}

/**
 * Buy whatever is new in a conversation (a `since_id` read at X).
 *
 * Two properties matter here. The response is written to its own rootId's
 * slot, so a refresh that lands after the reader has left cannot resurrect the
 * conversation they left. And a rootId already being refreshed is refused:
 * this fires from an effect on open, and StrictMode's double-invoked effects
 * (plus an impatient back-and-forward) would otherwise buy the same posts
 * twice.
 */
export function useRefreshConversation({ onRefreshed, onError }: RefreshOptions) {
  const queryClient = useQueryClient();
  const inFlight = useRef(new Set<string>());
  const mutation = useMutation({
    mutationFn: (rootId: string) => refreshConversation(rootId),
    onSuccess: (fresh, rootId) => {
      queryClient.setQueryData<ConversationResponse>(conversationKey(rootId), fresh);
      onRefreshed(rootId, fresh);
    },
    onError: (error) => onError(error.message),
    onSettled: (_data, _error, rootId) => {
      inFlight.current.delete(rootId);
    },
  });

  return {
    refresh: (rootId: string) => {
      if (inFlight.current.has(rootId)) return;
      inFlight.current.add(rootId);
      mutation.mutate(rootId);
    },
    /** Which conversation is refreshing, so a different one doesn't say so. */
    refreshingRootId: mutation.isPending ? (mutation.variables ?? null) : null,
  };
}

/**
 * Buy the older replies a stopped fetch never reached. Deliberately manual:
 * the conversation reads fine without them, and going back for them costs
 * money, so it happens when someone asks for it.
 */
export function useResumeConversation({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (rootId: string) => resumeConversation(rootId),
    onSuccess: (older, rootId) => {
      queryClient.setQueryData<ConversationResponse>(conversationKey(rootId), older);
    },
    onError: (error) => onError(error.message),
  });

  return {
    resume: (rootId: string) => mutation.mutate(rootId),
    resumingRootId: mutation.isPending ? (mutation.variables ?? null) : null,
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
 * The POST lives in `mutationFn`, not inside a state updater: React is allowed
 * to run an updater more than once, and this one used to fire a request from
 * inside it. The cached conversation is snapshotted before the change and put
 * back if the write fails, so a dot that came back doesn't lie about what the
 * server thinks.
 */
export function useSetRead({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, read }: SetReadVariables) => setReadState(ids, read),
    onMutate: async ({ rootId, ids, read }) => {
      // Nothing refetches conversations in the background, so this is belt and
      // braces — but an in-flight read would otherwise overwrite the change.
      await queryClient.cancelQueries({ queryKey: conversationKey(rootId) });
      const previous = queryClient.getQueryData<ConversationResponse>(conversationKey(rootId));
      queryClient.setQueryData<ConversationResponse>(conversationKey(rootId), (current) =>
        current ? withReadState(current, ids, read) : current,
      );
      return { previous };
    },
    onError: (error, { rootId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData<ConversationResponse>(conversationKey(rootId), context.previous);
      }
      onError(error.message);
    },
  });
}

/** Mark every post in a conversation read, optimistically. */
export function useMarkAllRead({ onError }: { onError: (message: string) => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rootId: string) => markConversationRead(rootId),
    onMutate: async (rootId) => {
      await queryClient.cancelQueries({ queryKey: conversationKey(rootId) });
      const previous = queryClient.getQueryData<ConversationResponse>(conversationKey(rootId));
      queryClient.setQueryData<ConversationResponse>(conversationKey(rootId), (current) =>
        current ? { ...current, unreadIds: [] } : current,
      );
      return { previous };
    },
    onError: (error, rootId, context) => {
      if (context?.previous) {
        queryClient.setQueryData<ConversationResponse>(conversationKey(rootId), context.previous);
      }
      onError(error.message);
    },
  });
}

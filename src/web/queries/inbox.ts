import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SettingsResponse } from "../../shared/types";
import {
  getAuthStatus,
  getFolders,
  getOwnPosts,
  getSaved,
  getSettings,
  removeSaved,
  setBookmarkFolder,
  syncBookmarks,
} from "../api";

export const savedKey = ["saved"] as const;
export const settingsKey = ["settings"] as const;
export const authKey = ["auth"] as const;
export const foldersKey = ["folders"] as const;
/**
 * A scan is identified by what it bought: how many threads it asked for, and
 * which attempt it was. "Refresh" bumps `attempt` because asking for the same
 * ten threads again is still a new purchase, and a key the cache has already
 * seen would be answered for free with the old list.
 */
export const ownPostsKey = (threads: number, attempt: number) =>
  ["ownPosts", threads, attempt] as const;

/**
 * The saved list. Free — it reads our own rows — so it refetches on every
 * mount, which is how leaving a conversation picks up the read state that
 * changed while you were in it.
 */
export function useSaved() {
  return useQuery({
    queryKey: savedKey,
    queryFn: ({ signal }) => getSaved(signal),
    refetchOnMount: "always",
  });
}

/** Free, and small; same mount-refetch reasoning as the saved list. */
export function useSettings() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => getSettings(signal),
    refetchOnMount: "always",
  });
}

/**
 * Where this deployment stands with X. Free — the status route reads stored
 * tokens and never calls X — and worth re-asking on mount, because coming back
 * from the OAuth redirect is exactly a remount.
 */
export function useAuthStatus() {
  return useQuery({
    queryKey: authKey,
    queryFn: ({ signal }) => getAuthStatus(signal),
    refetchOnMount: "always",
  });
}

/**
 * Bookmark folders, fetched only while the picker is open. The call itself is
 * free, but the first one of a deployment's life pays for a `/2/users/me`, so
 * it stays lazy: nobody should buy that by loading the inbox.
 */
export function useFolders(open: boolean) {
  return useQuery({
    queryKey: foldersKey,
    queryFn: ({ signal }) => getFolders(signal),
    enabled: open,
  });
}

/** What the Your-posts tab is currently asking the timeline for. */
export interface OwnPostsScan {
  threads: number;
  attempt: number;
}

/**
 * The reader's own recent threads. This is the one query on this screen that
 * bills: scanning the timeline is an Owned Read per post.
 *
 * `enabled` is the whole safety argument — the scan runs when the tab is open
 * and the account is connected, and never otherwise. Because it is a query and
 * not an effect, StrictMode's double-invoked effects and rapid tab flips
 * collapse into a single request per key instead of two scans.
 *
 * Two deliberate departures from the other queries:
 *
 * - the fetcher is not handed TanStack's signal. Aborting a billable read does
 *   not un-bill it, and the abort that a StrictMode remount performs would be
 *   followed by a second, identical, *also billed* scan. Letting the request
 *   finish costs one scan and keeps what it bought.
 * - `gcTime: Infinity` — a scan the reader paid for is theirs for the session.
 *   Without it, stepping into a conversation for five minutes would quietly
 *   re-bill on the way back.
 */
export function useOwnPosts(scan: OwnPostsScan, enabled: boolean) {
  return useQuery({
    queryKey: ownPostsKey(scan.threads, scan.attempt),
    queryFn: () => getOwnPosts(scan.threads),
    enabled,
    gcTime: Infinity,
    // Keep the current list on screen while a bigger scan runs, so "load 10
    // more" doesn't blank the list it is extending.
    placeholderData: keepPreviousData,
  });
}

/** Reconcile the saved list against the bookmark folder. Costs money. */
export function useSyncBookmarks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncBookmarks(),
    // A sync adds and removes saved rows, so the list has to be re-read; that
    // read is free.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: savedKey }),
  });
}

export function useSetBookmarkFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string | null; name: string }) =>
      setBookmarkFolder(id, name),
    onSuccess: (settings) => {
      // The PATCH answers with the stored settings, so there is nothing left
      // to go and ask for.
      queryClient.setQueryData<SettingsResponse>(settingsKey, settings);
    },
  });
}

export function useRemoveSaved() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (postId: string) => removeSaved(postId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: savedKey }),
  });
}

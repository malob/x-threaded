import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { AuthStatus, SettingsResponse } from "../../shared/types";
import { authLoginUrl } from "../inbox-state";
import {
  clearBookmarkFolder,
  disconnectX,
  getAuthStatus,
  getFolders,
  getOwnPosts,
  getSaved,
  getSettings,
  removeSaved,
  switchBookmarkFolder,
  syncBookmarks,
  type BookmarkDisposition,
} from "../api";

export const savedKey = ["saved"] as const;
export const settingsRootKey = ["settings"] as const;
export const settingsKey = (accountGeneration: string | null) =>
  [...settingsRootKey, accountGeneration] as const;
export const authKey = ["auth"] as const;
export const foldersRootKey = ["folders"] as const;
export const foldersKey = (accountGeneration: string | null) =>
  [...foldersRootKey, accountGeneration] as const;
export const ownPostsRootKey = ["ownPosts"] as const;
/**
 * A scan is identified by what it bought: how many threads it asked for, and
 * which attempt it was. "Refresh" bumps `attempt` because asking for the same
 * ten threads again is still a new purchase, and a key the cache has already
 * seen would be answered for free with the old list.
 */
export const ownPostsKey = (
  accountGeneration: string | null,
  threads: number,
  attempt: number,
) => [...ownPostsRootKey, accountGeneration, threads, attempt] as const;

/**
 * Remove only state whose meaning depends on the connected X account.
 *
 * Conversation and Saved caches are the deployment's local library, so they
 * stay. Saved is invalidated separately because disconnect may have converted
 * or removed its bookmark-owned subset.
 */
export async function applyDisconnectedAccountState(
  queryClient: QueryClient,
  accountGeneration: string,
): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: authKey }),
    queryClient.cancelQueries({ queryKey: settingsRootKey }),
    queryClient.cancelQueries({ queryKey: foldersRootKey }),
    queryClient.cancelQueries({ queryKey: ownPostsRootKey }),
  ]);
  queryClient.removeQueries({ queryKey: settingsRootKey });
  queryClient.removeQueries({ queryKey: foldersRootKey });
  queryClient.removeQueries({ queryKey: ownPostsRootKey });
  queryClient.setQueryData<AuthStatus>(authKey, () => ({
    state: "unauthorized",
    loginUrl: authLoginUrl(accountGeneration),
    accountGeneration,
  }));
  queryClient.setQueryData<SettingsResponse>(settingsKey(accountGeneration), {
    bookmarkFolderId: null,
    bookmarkFolderName: null,
  });
  await queryClient.invalidateQueries({ queryKey: savedKey });
}

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
export function useSettings(accountGeneration: string | null) {
  return useQuery({
    queryKey: settingsKey(accountGeneration),
    queryFn: ({ signal }) => getSettings(accountGeneration!, signal),
    enabled: accountGeneration !== null,
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
    // Another browser tab can complete a terminal disconnect/account change.
    // Status is local and free, so verify the durable generation again before
    // this tab regains the ability to issue account-bound reads.
    refetchOnWindowFocus: "always",
  });
}

/**
 * Bookmark folders, fetched only while the picker is open. The call itself is
 * free, but the first one under a fresh grant can pay for `/2/users/me`, so it
 * stays lazy: nobody should buy that by loading the inbox. A later Reconnect
 * resolves its replacement identity during the callback instead.
 */
export function useFolders(open: boolean, accountGeneration: string | null) {
  return useQuery({
    queryKey: foldersKey(accountGeneration),
    queryFn: ({ signal }) => getFolders(accountGeneration!, signal),
    enabled: open && accountGeneration !== null,
  });
}

/** What the Your-posts tab is currently asking the timeline for. */
export interface OwnPostsScan {
  threads: number;
  attempt: number;
}

export const DEFAULT_OWN_POSTS_SCAN: OwnPostsScan = { threads: 10, attempt: 0 };

/**
 * Paid scan memory belongs to one page cache and one account generation.
 *
 * A module-global value crosses QueryClients in tests and can cross multiple
 * app roots in the same page. More importantly, carrying account A's larger
 * scan into generation B would immediately buy that larger scan if the
 * remembered tab is Your posts. Weak ownership preserves the useful
 * inbox→conversation→inbox memory without crossing either boundary.
 */
const rememberedOwnPostsScans = new WeakMap<
  QueryClient,
  { accountGeneration: string; scan: OwnPostsScan }
>();

export function initialOwnPostsScan(
  queryClient: QueryClient,
  accountGeneration: string,
): OwnPostsScan {
  const remembered = rememberedOwnPostsScans.get(queryClient);
  return remembered?.accountGeneration === accountGeneration
    ? remembered.scan
    : DEFAULT_OWN_POSTS_SCAN;
}

export function rememberOwnPostsScan(
  queryClient: QueryClient,
  accountGeneration: string,
  scan: OwnPostsScan,
): void {
  rememberedOwnPostsScans.set(queryClient, { accountGeneration, scan });
}

/** Never use account A's paid rows as account B's transition placeholder. */
export function ownPostsPlaceholder<T>(
  accountGeneration: string | null,
  previousData: T | undefined,
  previousKey: readonly unknown[] | undefined,
): T | undefined {
  return accountGeneration !== null &&
    previousKey?.[0] === ownPostsRootKey[0] &&
    previousKey[1] === accountGeneration
    ? previousData
    : undefined;
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
 *
 * A failed scan is the sharp edge. A query that errored holds no data, and
 * query-core treats "no data" as stale whatever `staleTime` says, so the
 * library considers a re-fetch due from then on: flipping to the saved tab and
 * back (`enabled` false→true) or remounting the inbox (`retryOnMount` defaults
 * to true) would each re-issue the scan, and a scan that fails at X can bill
 * on the way. Hence both `retryOnMount: false` and a key that stays disabled
 * once it has errored. The invariant: after a failed scan, no code path may
 * re-issue a billable request until a click mints a new attempt. "Refresh"
 * mints one, which is why the error is rendered next to that button.
 */
export function useOwnPosts(
  accountGeneration: string | null,
  scan: OwnPostsScan,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const key = ownPostsKey(accountGeneration, scan.threads, scan.attempt);
  // Read out of the cache rather than from this hook's own result, so the gate
  // holds across a remount: the failure outlives the component that saw it.
  const failed = queryClient.getQueryState(key)?.status === "error";
  return useQuery({
    queryKey: key,
    queryFn: () => getOwnPosts(accountGeneration!, scan.threads),
    enabled: enabled && accountGeneration !== null && !failed,
    retryOnMount: false,
    gcTime: Infinity,
    // Keep the current list on screen while a bigger scan runs, so "load 10
    // more" doesn't blank the list it is extending.
    placeholderData: (previousData, previousQuery) =>
      ownPostsPlaceholder(accountGeneration, previousData, previousQuery?.queryKey),
  });
}

/** Reconcile the saved list against the bookmark folder. Costs money. */
export function useSyncBookmarks(accountGeneration: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (accountGeneration === null) throw new Error("X account state is unavailable; reload");
      return syncBookmarks(accountGeneration);
    },
    // A sync adds and removes saved rows, so the list has to be re-read; that
    // read is free.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: savedKey }),
  });
}

/** Paid, staged switch: the old selection remains unless the new scan completes. */
export async function commitSettingsTransition(
  queryClient: QueryClient,
  accountGeneration: string,
  settings: SettingsResponse,
): Promise<void> {
  // A GET begun before the mutation can otherwise resolve afterwards and
  // replace the successful write with its older snapshot. TanStack marks a
  // cancelled query so even a fetcher that ignores AbortSignal cannot commit.
  await queryClient.cancelQueries({
    queryKey: settingsKey(accountGeneration),
    exact: true,
  });
  queryClient.setQueryData<SettingsResponse>(settingsKey(accountGeneration), settings);
}

export function useSwitchBookmarkFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, accountGeneration }: { id: string; name: string; accountGeneration: string }) =>
      switchBookmarkFolder(id, name, accountGeneration),
    onSuccess: async (result, { accountGeneration }) => {
      await commitSettingsTransition(queryClient, accountGeneration, {
        bookmarkFolderId: result.bookmarkFolderId,
        bookmarkFolderName: result.bookmarkFolderName,
      });
      return queryClient.invalidateQueries({ queryKey: savedKey });
    },
  });
}

/** Free local disposition after the no-folder confirmation. */
export function useClearBookmarkFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ disposition, accountGeneration }: { disposition: BookmarkDisposition; accountGeneration: string }) =>
      clearBookmarkFolder(disposition, accountGeneration),
    onSuccess: async (settings, { accountGeneration }) => {
      await commitSettingsTransition(queryClient, accountGeneration, settings);
      return queryClient.invalidateQueries({ queryKey: savedKey });
    },
  });
}

/** Revoke X credentials, then remove every account-specific cache slot. */
export function useDisconnectX() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ disposition, accountGeneration }: { disposition: BookmarkDisposition; accountGeneration: string }) =>
      disconnectX(disposition, accountGeneration),
    onSuccess: (result) =>
      applyDisconnectedAccountState(queryClient, result.accountGeneration),
  });
}

export function useRemoveSaved() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (postId: string) => removeSaved(postId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: savedKey }),
  });
}

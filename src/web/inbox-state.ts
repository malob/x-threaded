import { formatUsd } from "../shared/pricing";
import { MAX_OWN_POST_THREADS } from "../shared/types";
import type { AuthStatus, FetchCost, FoldersResponse, SettingsResponse } from "../shared/types";

export type OwnPostsContinuation = "load-more" | "limit-reached" | null;
export type InboxTab = "saved" | "yours";

export interface AccountTabState {
  readonly tab: InboxTab;
  readonly accountGeneration: string | null;
}

/**
 * A remembered Your Posts choice belongs to one account generation. Any
 * unowned legacy choice or later generation is forced to Saved synchronously,
 * before a paid own-post query can enable.
 */
export function reconcileAccountTab(
  state: AccountTabState,
  accountGeneration: string | null,
): AccountTabState {
  if (accountGeneration === null || state.accountGeneration === accountGeneration) return state;
  return {
    tab: "saved",
    accountGeneration,
  };
}

/** Bind interactive OAuth navigation to the account state the user confirmed. */
export function authLoginUrl(accountGeneration: string): string {
  return `/auth/login?${new URLSearchParams({ accountGeneration })}`;
}

/**
 * Cached auth data is not proof of the current account after a tab regains
 * focus. Keep account-bound queries fenced until the free status check has
 * succeeded; TanStack deliberately retains old data when that check fails.
 */
export function verifiedAccountGeneration(
  auth: AuthStatus | undefined,
  verificationPending: boolean,
  verificationFailed: boolean,
): string | null {
  if (verificationPending || verificationFailed) return null;
  return auth?.accountGeneration ?? null;
}

/**
 * A larger paid scan is useful only after the server satisfied this target.
 * If it returned fewer items while still saying more exist, it already hit
 * its safe page/no-progress boundary; increasing the target would repeat the
 * same purchase. Fifty is also the API's hard per-request thread ceiling.
 */
export function ownPostsContinuation(
  hasMore: boolean,
  itemCount: number,
  requestedThreads: number,
): OwnPostsContinuation {
  if (!hasMore) return null;
  const target = Math.min(Math.max(requestedThreads, 1), MAX_OWN_POST_THREADS);
  return itemCount >= target && requestedThreads < MAX_OWN_POST_THREADS
    ? "load-more"
    : "limit-reached";
}

/** A lifecycle choice waiting for an explicit user decision. */
export type LifecyclePrompt =
  | {
      readonly kind: "switch-folder";
      readonly accountGeneration: string;
      readonly fromName: string | null;
      readonly toId: string;
      readonly toName: string;
    }
  | { readonly kind: "clear-folder"; readonly accountGeneration: string; readonly fromName: string }
  | { readonly kind: "disconnect"; readonly accountGeneration: string; readonly accountLabel: string }
  | { readonly kind: "reconnect"; readonly accountGeneration: string; readonly accountLabel: string };

export interface LifecyclePromptCopy {
  readonly title: string;
  readonly detail: string;
}

/**
 * Turn a picker selection into inert confirmation state.
 *
 * Deliberately has no callback: selecting an option cannot write settings or
 * start the paid folder scan. Only a later dialog action receives the prompt.
 */
export function folderSelectionPrompt(
  current: SettingsResponse,
  nextId: string | null,
  nextName: string,
  accountGeneration: string,
): Extract<LifecyclePrompt, { kind: "switch-folder" | "clear-folder" }> | null {
  const currentId = current.bookmarkFolderId || null;
  const normalizedNext = nextId || null;
  if (currentId === normalizedNext) return null;
  if (normalizedNext === null) {
    if (currentId === null) return null;
    return {
      kind: "clear-folder",
      accountGeneration,
      fromName: current.bookmarkFolderName || "the current folder",
    };
  }
  return {
    kind: "switch-folder",
    accountGeneration,
    fromName: currentId ? current.bookmarkFolderName || "the current folder" : null,
    toId: normalizedNext,
    toName: nextName || "the selected folder",
  };
}

/** Product language shared by the rendered dialog and focused semantic tests. */
export function lifecyclePromptCopy(prompt: LifecyclePrompt): LifecyclePromptCopy {
  switch (prompt.kind) {
    case "switch-folder":
      return {
        title: prompt.fromName ? "Switch bookmark folders?" : "Start bookmark sync?",
        detail: prompt.fromName
          ? `Switching from ${prompt.fromName} to ${prompt.toName} starts a paid sync. x-threaded will update its Saved list, but it does not move, add, or remove bookmarks on X.`
          : `Syncing ${prompt.toName} is a paid action. x-threaded will update its Saved list, but it does not move, add, or remove bookmarks on X.`,
      };
    case "clear-folder":
      return {
        title: "Stop syncing bookmarks?",
        detail: `Stop syncing ${prompt.fromName}, then choose whether to keep them as local saves or remove them from this app. Either choice affects only x-threaded and does not change your bookmarks on X.`,
      };
    case "disconnect":
      return {
        title: `Disconnect ${prompt.accountLabel}?`,
        detail:
          "The X access credentials stored by x-threaded will be revoked. Choose whether synced bookmark items become local saves or are removed from this app. Manual saves, cached conversations and posts, and read history remain. Your bookmarks on X do not change.",
      };
    case "reconnect":
      return {
        title: `Reconnect ${prompt.accountLabel}?`,
        detail: `Only ${prompt.accountLabel} can be accepted by this reconnect. If X is signed in as a different account, x-threaded will reject it; disconnect first to use that account. Reconnecting may include a paid identity check; it does not change bookmarks on X or clear the local library.`,
      };
  }
}

export type AuthReturnNotice =
  | { readonly kind: "account-state-changed"; readonly cost: null }
  | { readonly kind: "disconnect-first"; readonly cost: null }
  | { readonly kind: "different-account"; readonly cost: FetchCost | null }
  | { readonly kind: "different-account-revoke-failed"; readonly cost: FetchCost | null }
  | { readonly kind: "reauthorization-conflict"; readonly cost: FetchCost | null }
  | { readonly kind: "reauthorized"; readonly cost: FetchCost | null };

function nonnegativeNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nonnegativeInteger(value: string | null): number | null {
  const parsed = nonnegativeNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

/** Parse only the callback notices the server owns; malformed receipts are not displayed as money. */
export function authReturnNotice(search: string): AuthReturnNotice | null {
  const params = new URLSearchParams(search);
  const notice = params.get("authNotice");
  if (notice === "account-state-changed") {
    return { kind: "account-state-changed", cost: null };
  }
  if (notice === "disconnect-first") {
    return { kind: "disconnect-first", cost: null };
  }
  const posts = nonnegativeInteger(params.get("authCostPosts"));
  const billable = nonnegativeInteger(params.get("authCostBillable"));
  const usd = nonnegativeNumber(params.get("authCostUsd"));
  const cost =
    posts !== null && billable !== null && billable <= posts && usd !== null
      ? { posts, billable, usd }
      : null;
  if (
    notice !== "different-account" &&
    notice !== "different-account-revoke-failed" &&
    notice !== "reauthorization-conflict" &&
    notice !== "reauthorized"
  ) {
    return null;
  }
  return {
    kind: notice,
    cost,
  };
}

export interface SingleFlight {
  /** Returns false without invoking `operation` when another call owns the flight. */
  run(operation: () => Promise<unknown>): Promise<boolean>;
}

/**
 * A synchronous admission gate for an async operation.
 *
 * Acquiring before the first await closes the one-render gap where two event
 * paths both still observe a mutation hook as idle. The owner releases the
 * gate on both fulfillment and rejection.
 */
export function createSingleFlight(): SingleFlight {
  let active = false;
  return {
    async run(operation) {
      if (active) return false;
      active = true;
      try {
        await operation();
        return true;
      } finally {
        active = false;
      }
    },
  };
}

/** The four meanings `settings.data === undefined` used to collapse together. */
export type FolderSettingsState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty"; readonly settings: SettingsResponse }
  | { readonly kind: "data"; readonly settings: SettingsResponse };

/**
 * Give cached data precedence over a background-refetch error: it is still a
 * settings value the reader can use, while a first-load failure has no value
 * and must never masquerade as "no folder selected".
 */
export function folderSettingsState(
  settings: SettingsResponse | undefined,
  error: Error | null,
): FolderSettingsState {
  if (settings) {
    return settings.bookmarkFolderId
      ? { kind: "data", settings }
      : { kind: "empty", settings };
  }
  if (error) return { kind: "error", message: error.message };
  return { kind: "loading" };
}

/** A successful folder request can carry the User Read that resolved identity. */
export function folderCostNotice(response: FoldersResponse | undefined): string | null {
  const cost = response?.cost;
  return cost && cost.billable > 0
    ? `folder lookup cost ${formatUsd(cost.usd, false)}`
    : null;
}

import { formatUsd } from "../shared/pricing";
import { ACCOUNT_GENERATION_HEADER } from "../shared/types";
import type {
  ApiError,
  AuthStatus,
  ConversationResponse,
  DisconnectResponse,
  FoldersResponse,
  OkResponse,
  OwnPostsResponse,
  RefreshResponse,
  ResolveResponse,
  SavedListResponse,
  SettingsResponse,
  SyncResponse,
} from "../shared/types";

/**
 * Cloudflare Access answers a lapsed session with the HTML of its login page,
 * not a 401. Handing that to `response.json()` raises a SyntaxError about
 * character 0 — true, useless, and shown to someone whose actual problem is
 * that they need to sign in again.
 */
function expectJson(response: Response): void {
  if (!response.headers.get("Content-Type")?.includes("application/json")) {
    throw new Error("your session expired — reload the page to sign in again");
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  expectJson(response);
  const body = (await response.json()) as T | ApiError;
  if (!response.ok) {
    const failure = body as ApiError;
    const message = failure.error ?? `request failed (${response.status})`;
    // A request can fail after X was read and billed. The server says so when
    // it happened, and this message is the only place the user would see it.
    const spent = failure.cost;
    throw new Error(
      spent && spent.billable > 0 ? `${message} · spent ${formatUsd(spent.usd, false)}` : message,
    );
  }
  return body as T;
}

/**
 * The GETs take an optional `AbortSignal` so a query can hand them the one
 * TanStack cancels when nobody is waiting for the answer any more. Mutations
 * don't: a write that has left the browser has to be seen through.
 */
export function resolvePost(postId: string, signal?: AbortSignal): Promise<ResolveResponse> {
  return request(`/api/resolve/${postId}`, { signal });
}

export function getSaved(signal?: AbortSignal): Promise<SavedListResponse> {
  return request("/api/saved", { signal });
}

export function removeSaved(postId: string): Promise<OkResponse> {
  return request(`/api/saved/${postId}`, { method: "DELETE" });
}

/** The one GET that bills; `useOwnPosts` explains why its caller withholds the signal. */
export function getOwnPosts(
  accountGeneration: string,
  threads = 10,
  signal?: AbortSignal,
): Promise<OwnPostsResponse> {
  return request(`/api/me/posts?threads=${threads}`, {
    signal,
    headers: { [ACCOUNT_GENERATION_HEADER]: accountGeneration },
  });
}

export function getSettings(
  accountGeneration: string,
  signal?: AbortSignal,
): Promise<SettingsResponse> {
  return request("/api/settings", {
    signal,
    headers: { [ACCOUNT_GENERATION_HEADER]: accountGeneration },
  });
}

export type BookmarkDisposition = "keep" | "remove";

/** A staged folder switch answers with both its sync receipt and activated setting. */
export type BookmarkSwitchResponse = SyncResponse & SettingsResponse;

/**
 * Scan a new folder and activate it only if that paid scan completes.
 * The caller presents the confirmation UI before invoking this function.
 */
export function switchBookmarkFolder(
  bookmarkFolderId: string,
  bookmarkFolderName: string,
  accountGeneration: string,
): Promise<BookmarkSwitchResponse> {
  return request("/api/bookmarks/switch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [ACCOUNT_GENERATION_HEADER]: accountGeneration,
    },
    body: JSON.stringify({ bookmarkFolderId, bookmarkFolderName }),
  });
}

/** Stop folder sync, explicitly deciding what happens to its app-local mirror. */
export function clearBookmarkFolder(
  bookmarkDisposition: BookmarkDisposition,
  accountGeneration: string,
): Promise<SettingsResponse> {
  return request("/api/settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      [ACCOUNT_GENERATION_HEADER]: accountGeneration,
    },
    body: JSON.stringify({ bookmarkFolderId: null, bookmarkDisposition }),
  });
}

export function getFolders(
  accountGeneration: string,
  signal?: AbortSignal,
): Promise<FoldersResponse> {
  return request("/api/bookmarks/folders", {
    signal,
    headers: { [ACCOUNT_GENERATION_HEADER]: accountGeneration },
  });
}

const AUTH_STATES: readonly string[] = [
  "unconfigured",
  "unauthorized",
  "disconnecting",
  "broken",
  "authorized",
];

export async function getAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  // Unlike other endpoints, a non-2xx here is still a meaningful answer — as
  // long as it is one of the four states. Anything else would be an error
  // body wearing the union's clothes, so it goes to the caller's catch.
  const response = await fetch("/api/auth/status", { signal });
  expectJson(response);
  const body = (await response.json()) as { state?: string; accountGeneration?: unknown };
  if (
    !AUTH_STATES.includes(body.state ?? "") ||
    typeof body.accountGeneration !== "string" ||
    body.accountGeneration.length === 0
  ) {
    throw new Error(`auth status unavailable (${response.status})`);
  }
  return body as AuthStatus;
}

export function syncBookmarks(accountGeneration: string): Promise<SyncResponse> {
  return request("/api/bookmarks/sync", {
    method: "POST",
    headers: { [ACCOUNT_GENERATION_HEADER]: accountGeneration },
  });
}

/** Revoke the stored X grant and dispose of its bookmark mirror as instructed. */
export async function disconnectX(
  bookmarkDisposition: BookmarkDisposition,
  accountGeneration: string,
): Promise<DisconnectResponse> {
  const result = await request<DisconnectResponse>("/api/auth/disconnect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [ACCOUNT_GENERATION_HEADER]: accountGeneration,
    },
    body: JSON.stringify({ bookmarkDisposition }),
  });
  if (
    result.ok !== true ||
    typeof result.accountGeneration !== "string" ||
    result.accountGeneration.length === 0
  ) {
    throw new Error("disconnect response unavailable");
  }
  return result;
}

export function getConversation(
  rootId: string,
  signal?: AbortSignal,
): Promise<ConversationResponse> {
  return request(`/api/conversations/${rootId}`, { signal });
}

export function loadConversation(url: string, force = false): Promise<ConversationResponse> {
  return request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, force }),
  });
}

export function refreshConversation(rootId: string): Promise<RefreshResponse> {
  return request(`/api/conversations/${rootId}/refresh`, { method: "POST" });
}

/** Buy the older replies a stopped fetch never reached. Costs money. */
export function resumeConversation(rootId: string): Promise<RefreshResponse> {
  return request(`/api/conversations/${rootId}/resume`, { method: "POST" });
}

export function markConversationRead(rootId: string): Promise<OkResponse> {
  return request(`/api/conversations/${rootId}/read`, { method: "POST" });
}

export function setReadState(postIds: string[], read: boolean): Promise<OkResponse> {
  return request("/api/read-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postIds, read }),
  });
}

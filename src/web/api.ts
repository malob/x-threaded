import { formatUsd } from "../shared/pricing";
import type {
  ApiError,
  AuthStatus,
  ConversationResponse,
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

export function resolvePost(postId: string): Promise<ResolveResponse> {
  return request(`/api/resolve/${postId}`);
}

export function getSaved(): Promise<SavedListResponse> {
  return request("/api/saved");
}

export function removeSaved(postId: string): Promise<OkResponse> {
  return request(`/api/saved/${postId}`, { method: "DELETE" });
}

export function getOwnPosts(threads = 10): Promise<OwnPostsResponse> {
  return request(`/api/me/posts?threads=${threads}`);
}

export function getSettings(): Promise<SettingsResponse> {
  return request("/api/settings");
}

export function setBookmarkFolder(
  bookmarkFolderId: string | null,
  bookmarkFolderName: string,
): Promise<SettingsResponse> {
  return request("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookmarkFolderId, bookmarkFolderName }),
  });
}

export function getFolders(): Promise<FoldersResponse> {
  return request("/api/bookmarks/folders");
}

const AUTH_STATES: readonly string[] = ["unconfigured", "unauthorized", "broken", "authorized"];

export async function getAuthStatus(): Promise<AuthStatus> {
  // Unlike other endpoints, a non-2xx here is still a meaningful answer — as
  // long as it is one of the four states. Anything else would be an error
  // body wearing the union's clothes, so it goes to the caller's catch.
  const response = await fetch("/api/auth/status");
  expectJson(response);
  const body = (await response.json()) as { state?: string };
  if (!AUTH_STATES.includes(body.state ?? "")) {
    throw new Error(`auth status unavailable (${response.status})`);
  }
  return body as AuthStatus;
}

export function syncBookmarks(): Promise<SyncResponse> {
  return request("/api/bookmarks/sync", { method: "POST" });
}

export function getConversation(rootId: string): Promise<ConversationResponse> {
  return request(`/api/conversations/${rootId}`);
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

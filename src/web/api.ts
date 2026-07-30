import type {
  ApiError,
  AuthStatus,
  ConversationListResponse,
  ConversationResponse,
  FoldersResponse,
  OwnPostsResponse,
  RefreshResponse,
  SavedListResponse,
  SettingsResponse,
} from "../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json()) as T | ApiError;
  if (!response.ok) {
    const message = (body as ApiError).error ?? `request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function listConversations(): Promise<ConversationListResponse> {
  return request("/api/conversations");
}

export function resolvePost(
  postId: string,
): Promise<{ rootId: string | null; replyCount: number | null }> {
  return request(`/api/resolve/${postId}`);
}

export function getSaved(): Promise<SavedListResponse> {
  return request("/api/saved");
}

export function removeSaved(postId: string): Promise<{ ok: boolean }> {
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

export async function getAuthStatus(): Promise<AuthStatus> {
  // Unlike other endpoints, a non-2xx here is still a meaningful answer.
  const response = await fetch("/api/auth/status");
  return (await response.json()) as AuthStatus;
}

export function syncBookmarks(): Promise<{ synced: number; added: number; removed: number }> {
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

export function markConversationRead(rootId: string): Promise<{ ok: boolean }> {
  return request(`/api/conversations/${rootId}/read`, { method: "POST" });
}

export function setReadState(postIds: string[], read: boolean): Promise<{ ok: boolean }> {
  return request("/api/read-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postIds, read }),
  });
}

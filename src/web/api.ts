import type {
  ApiError,
  ConversationListResponse,
  ConversationResponse,
  RefreshResponse,
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

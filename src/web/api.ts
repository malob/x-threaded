import type { ApiError, ConversationResponse, ConversationSummary } from "../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json()) as T | ApiError;
  if (!response.ok) {
    const message = (body as ApiError).error ?? `request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function listConversations(): Promise<ConversationSummary[]> {
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

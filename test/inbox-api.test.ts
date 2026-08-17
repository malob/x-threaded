import { afterEach, describe, expect, it } from "bun:test";
import {
  clearBookmarkFolder,
  disconnectX,
  getAuthStatus,
  switchBookmarkFolder,
} from "../src/web/api";
import { ACCOUNT_GENERATION_HEADER } from "../src/shared/types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown): Response {
  return Response.json(body, { status: 200 });
}

describe("bookmark/account lifecycle API contracts", () => {
  it("uses the staged switch endpoint only when explicitly invoked", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ path: String(input), init });
      return jsonResponse({
        synced: 1,
        added: 1,
        removed: 0,
        unavailable: 0,
        complete: true,
        cost: { posts: 1, billable: 1, usd: 0.006 },
        bookmarkFolderId: "folder-b",
        bookmarkFolderName: "Later",
      });
    }) as typeof fetch;

    expect(calls).toEqual([]);
    await switchBookmarkFolder("folder-b", "Later", "generation-a");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/api/bookmarks/switch");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get(ACCOUNT_GENERATION_HEADER)).toBe(
      "generation-a",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      bookmarkFolderId: "folder-b",
      bookmarkFolderName: "Later",
    });
  });

  it("sends an explicit keep/remove disposition when clearing or disconnecting", async () => {
    const calls: { path: string; body: unknown; generation: string | null }[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        path: String(input),
        body: JSON.parse(String(init?.body)),
        generation: new Headers(init?.headers).get(ACCOUNT_GENERATION_HEADER),
      });
      return String(input) === "/api/settings"
        ? jsonResponse({ bookmarkFolderId: null, bookmarkFolderName: null })
        : jsonResponse({ ok: true, accountGeneration: "generation-2" });
    }) as typeof fetch;

    await clearBookmarkFolder("keep", "generation-a");
    expect(await disconnectX("remove", "generation-a")).toEqual({
      ok: true,
      accountGeneration: "generation-2",
    });

    expect(calls).toEqual([
      {
        path: "/api/settings",
        body: { bookmarkFolderId: null, bookmarkDisposition: "keep" },
        generation: "generation-a",
      },
      {
        path: "/api/auth/disconnect",
        body: { bookmarkDisposition: "remove" },
        generation: "generation-a",
      },
    ]);
  });

  it("accepts the truthful transient disconnecting auth state", async () => {
    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe("/api/auth/status");
      return jsonResponse({ state: "disconnecting", accountGeneration: "generation-1" });
    }) as typeof fetch;
    expect(await getAuthStatus()).toEqual({
      state: "disconnecting",
      accountGeneration: "generation-1",
    });
  });

  it("rejects account state without the durable generation namespace", async () => {
    globalThis.fetch = (async () => jsonResponse({ state: "authorized" })) as unknown as typeof fetch;
    expect(getAuthStatus()).rejects.toThrow("auth status unavailable");

    globalThis.fetch = (async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    expect(disconnectX("keep", "generation-a")).rejects.toThrow(
      "disconnect response unavailable",
    );
  });
});

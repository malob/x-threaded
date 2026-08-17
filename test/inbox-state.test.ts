import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type {
  AuthStatus,
  FoldersResponse,
  SavedListResponse,
  SettingsResponse,
} from "../src/shared/types";
import {
  authLoginUrl,
  authReturnNotice,
  createSingleFlight,
  folderCostNotice,
  folderSelectionPrompt,
  folderSettingsState,
  lifecyclePromptCopy,
  ownPostsContinuation,
  reconcileAccountTab,
  verifiedAccountGeneration,
} from "../src/web/inbox-state";
import { conversationKey } from "../src/web/queries/conversation-cache";
import {
  applyDisconnectedAccountState,
  authKey,
  commitSettingsTransition,
  foldersKey,
  initialOwnPostsScan,
  ownPostsKey,
  ownPostsPlaceholder,
  rememberOwnPostsScan,
  savedKey,
  settingsKey,
} from "../src/web/queries/inbox";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("bookmark settings presentation", () => {
  it("forces Saved before a new account generation can auto-buy Your Posts", () => {
    const accountA = { tab: "yours", accountGeneration: "account-a" } as const;
    expect(reconcileAccountTab(accountA, "account-a")).toBe(accountA);
    expect(reconcileAccountTab(accountA, null)).toBe(accountA);
    expect(reconcileAccountTab(accountA, "account-b")).toEqual({
      tab: "saved",
      accountGeneration: "account-b",
    });
    expect(reconcileAccountTab({ tab: "yours", accountGeneration: null }, "account-a")).toEqual({
      tab: "saved",
      accountGeneration: "account-a",
    });
  });

  it("never authorizes account-bound reads from stale auth after verification fails", () => {
    const cachedAccount: AuthStatus = {
      state: "authorized",
      accountGeneration: "account-a",
      user: { username: "reader", name: "Reader" },
      scopes: ["bookmark.read"],
      expiresAt: Date.now() + 60_000,
    };

    expect(verifiedAccountGeneration(cachedAccount, false, false)).toBe("account-a");
    expect(verifiedAccountGeneration(cachedAccount, true, false)).toBeNull();
    expect(verifiedAccountGeneration(cachedAccount, false, true)).toBeNull();
  });

  it("keeps loading, error, empty and selected data as four distinct states", () => {
    const empty: SettingsResponse = {
      bookmarkFolderId: null,
      bookmarkFolderName: null,
    };
    const selected: SettingsResponse = {
      bookmarkFolderId: "folder-1",
      bookmarkFolderName: "Reading",
    };
    const cleared: SettingsResponse = {
      bookmarkFolderId: "",
      bookmarkFolderName: "",
    };

    expect(folderSettingsState(undefined, null)).toEqual({ kind: "loading" });
    expect(folderSettingsState(undefined, new Error("offline"))).toEqual({
      kind: "error",
      message: "offline",
    });
    expect(folderSettingsState(empty, null)).toEqual({ kind: "empty", settings: empty });
    expect(folderSettingsState(cleared, null)).toEqual({ kind: "empty", settings: cleared });
    expect(folderSettingsState(selected, null)).toEqual({ kind: "data", settings: selected });
  });

  it("keeps usable cached settings when only a background refetch failed", () => {
    const selected: SettingsResponse = {
      bookmarkFolderId: "folder-1",
      bookmarkFolderName: "Reading",
    };

    expect(folderSettingsState(selected, new Error("refresh failed"))).toEqual({
      kind: "data",
      settings: selected,
    });
  });

  it("turns folder choices into confirmation state without performing an action", () => {
    const accountGeneration = "generation-a";
    const current: SettingsResponse = {
      bookmarkFolderId: "folder-a",
      bookmarkFolderName: "Reading",
    };

    expect(folderSelectionPrompt(current, "folder-a", "Reading", accountGeneration)).toBeNull();
    expect(folderSelectionPrompt(current, "folder-b", "Later", accountGeneration)).toEqual({
      kind: "switch-folder",
      accountGeneration,
      fromName: "Reading",
      toId: "folder-b",
      toName: "Later",
    });
    expect(folderSelectionPrompt(current, null, "", accountGeneration)).toEqual({
      kind: "clear-folder",
      accountGeneration,
      fromName: "Reading",
    });
    expect(
      folderSelectionPrompt(
        { bookmarkFolderId: null, bookmarkFolderName: null },
        "folder-b",
        "Later",
        accountGeneration,
      ),
    ).toEqual({
      kind: "switch-folder",
      accountGeneration,
      fromName: null,
      toId: "folder-b",
      toName: "Later",
    });
    expect(
      folderSelectionPrompt(
        { bookmarkFolderId: null, bookmarkFolderName: null },
        null,
        "",
        accountGeneration,
      ),
    ).toBeNull();
  });

  it("makes lifecycle confirmation copy explicit about spend, X, and retained local data", () => {
    const switching = lifecyclePromptCopy({
      kind: "switch-folder",
      accountGeneration: "generation-a",
      fromName: "Reading",
      toId: "folder-b",
      toName: "Later",
    });
    expect(switching.title).toBe("Switch bookmark folders?");
    expect(switching.detail).toContain("paid sync");
    expect(switching.detail).toContain("does not move, add, or remove bookmarks on X");

    const clearing = lifecyclePromptCopy({
      kind: "clear-folder",
      accountGeneration: "generation-a",
      fromName: "Reading",
    });
    expect(clearing.detail).toContain("keep them as local saves or remove them from this app");
    expect(clearing.detail).toContain("does not change your bookmarks on X");

    const disconnecting = lifecyclePromptCopy({
      kind: "disconnect",
      accountGeneration: "generation-a",
      accountLabel: "@malo",
    });
    expect(disconnecting.detail).toContain("credentials");
    expect(disconnecting.detail).toContain("revoked");
    expect(disconnecting.detail).toContain("cached conversations");
    expect(disconnecting.detail).toContain("read history");

    const reconnecting = lifecyclePromptCopy({
      kind: "reconnect",
      accountGeneration: "generation-a",
      accountLabel: "@malo",
    });
    expect(reconnecting.detail).toContain("@malo");
    expect(reconnecting.detail).toContain("can be accepted by this reconnect");
    expect(reconnecting.detail).toContain("will reject it; disconnect first");
  });
});

describe("Your-posts continuation", () => {
  it("offers another paid scan only when the current request was fully satisfied", () => {
    expect(ownPostsContinuation(true, 10, 10)).toBe("load-more");
    expect(ownPostsContinuation(true, 7, 10)).toBe("limit-reached");
    expect(ownPostsContinuation(false, 10, 10)).toBe(null);
  });

  it("stops at the API's 50-thread ceiling instead of repeating the same purchase", () => {
    expect(ownPostsContinuation(true, 50, 50)).toBe("limit-reached");
    expect(ownPostsContinuation(true, 50, 60)).toBe("limit-reached");
  });
});

describe("OAuth callback notices", () => {
  it("binds OAuth navigation and stale-state notices to the confirmed account generation", () => {
    expect(authLoginUrl("generation A/1")).toBe(
      "/auth/login?accountGeneration=generation+A%2F1",
    );
    expect(authReturnNotice("?authNotice=account-state-changed")).toEqual({
      kind: "account-state-changed",
      cost: null,
    });
  });

  it("parses rejected-account receipts without trusting incomplete cost parameters", () => {
    expect(
      authReturnNotice(
        "?authNotice=different-account&authCostPosts=1&authCostBillable=1&authCostUsd=0.01",
      ),
    ).toEqual({
      kind: "different-account",
      cost: { posts: 1, billable: 1, usd: 0.01 },
    });
    expect(authReturnNotice("?authNotice=different-account&authCostUsd=99")).toEqual({
      kind: "different-account",
      cost: null,
    });
    expect(authReturnNotice("?authNotice=disconnect-first")).toEqual({
      kind: "disconnect-first",
      cost: null,
    });
    expect(
      authReturnNotice(
        "?authNotice=different-account-revoke-failed&authCostPosts=1&authCostBillable=1&authCostUsd=0.01",
      ),
    ).toEqual({
      kind: "different-account-revoke-failed",
      cost: { posts: 1, billable: 1, usd: 0.01 },
    });
    expect(
      authReturnNotice(
        "?authNotice=reauthorization-conflict&authCostPosts=2&authCostBillable=1&authCostUsd=0.01",
      ),
    ).toEqual({
      kind: "reauthorization-conflict",
      cost: { posts: 2, billable: 1, usd: 0.01 },
    });
  });

  it("parses a same-account reconnect receipt and degrades safely when it is malformed", () => {
    expect(
      authReturnNotice(
        "?authNotice=reauthorized&authCostPosts=1&authCostBillable=1&authCostUsd=0.01",
      ),
    ).toEqual({
      kind: "reauthorized",
      cost: { posts: 1, billable: 1, usd: 0.01 },
    });
    expect(authReturnNotice("?authNotice=reauthorized&authCostPosts=wat")).toEqual({
      kind: "reauthorized",
      cost: null,
    });
    expect(authReturnNotice("?anything=else")).toBeNull();
  });

  it("clears only account-specific query data after disconnect", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const oldGeneration = "account-7";
    const newGeneration = "account-8";
    const saved = { items: [], quoted: {} };
    const conversation = { rootId: "root", posts: [] };
    queryClient.setQueryData(authKey, {
      state: "authorized",
      accountGeneration: oldGeneration,
      user: { username: "malo" },
    });
    queryClient.setQueryData(foldersKey(oldGeneration), {
      folders: [{ id: "folder-a", name: "Reading" }],
    });
    queryClient.setQueryData(ownPostsKey(oldGeneration, 10, 0), {
      items: [{ id: "old-account" }],
    });
    queryClient.setQueryData(settingsKey(oldGeneration), {
      bookmarkFolderId: "folder-a",
      bookmarkFolderName: "Reading",
    });
    queryClient.setQueryData(savedKey, saved);
    queryClient.setQueryData(conversationKey("root"), conversation);

    await applyDisconnectedAccountState(queryClient, newGeneration);

    expect(queryClient.getQueryData(foldersKey(oldGeneration))).toBeUndefined();
    expect(queryClient.getQueryData(ownPostsKey(oldGeneration, 10, 0))).toBeUndefined();
    expect(queryClient.getQueryData<AuthStatus>(authKey)).toEqual({
      state: "unauthorized",
      loginUrl: "/auth/login?accountGeneration=account-8",
      accountGeneration: newGeneration,
    });
    expect(queryClient.getQueryData<SettingsResponse>(settingsKey(newGeneration))).toEqual({
      bookmarkFolderId: null,
      bookmarkFolderName: null,
    });
    expect(queryClient.getQueryData<SavedListResponse>(savedKey)).toBe(saved);
    expect(queryClient.getQueryData<typeof conversation>(conversationKey("root"))).toBe(
      conversation,
    );
  });

  it("namespaces account data by the server generation", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const accountA = { bookmarkFolderId: "folder-a", bookmarkFolderName: "Account A" };
    queryClient.setQueryData(settingsKey("account-11"), accountA);
    queryClient.setQueryData(foldersKey("account-11"), {
      folders: [{ id: "folder-a", name: "A" }],
    });
    queryClient.setQueryData(ownPostsKey("account-11", 10, 0), {
      items: [{ id: "a-post" }],
    });

    expect(queryClient.getQueryData(settingsKey("account-12"))).toBeUndefined();
    expect(queryClient.getQueryData(foldersKey("account-12"))).toBeUndefined();
    expect(queryClient.getQueryData(ownPostsKey("account-12", 10, 0))).toBeUndefined();
    expect(queryClient.getQueryData<typeof accountA>(settingsKey("account-11"))).toBe(accountA);
  });

  it("keeps placeholder rows only while expanding the same account generation", () => {
    const accountA = { items: [{ id: "a-post" }] };

    expect(
      ownPostsPlaceholder("account-a", accountA, ownPostsKey("account-a", 10, 0)),
    ).toBe(accountA);
    expect(
      ownPostsPlaceholder("account-b", accountA, ownPostsKey("account-a", 10, 0)),
    ).toBeUndefined();
    expect(ownPostsPlaceholder(null, accountA, ownPostsKey("account-a", 10, 0))).toBeUndefined();
  });

  it("keeps paid-scan memory isolated by QueryClient and account generation", () => {
    const firstTab = new QueryClient();
    const secondTab = new QueryClient();

    expect(initialOwnPostsScan(firstTab, "account-3")).toEqual({ threads: 10, attempt: 0 });
    expect(initialOwnPostsScan(secondTab, "account-3")).toEqual({ threads: 10, attempt: 0 });

    rememberOwnPostsScan(firstTab, "account-3", { threads: 30, attempt: 2 });
    expect(initialOwnPostsScan(firstTab, "account-3")).toEqual({ threads: 30, attempt: 2 });
    expect(initialOwnPostsScan(secondTab, "account-3")).toEqual({ threads: 10, attempt: 0 });
    expect(initialOwnPostsScan(firstTab, "account-4")).toEqual({ threads: 10, attempt: 0 });
  });

  it("does not let an older settings GET overwrite a completed transition", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const generation = "account-19";
    const late = deferred<SettingsResponse>();
    const oldRequest = queryClient.fetchQuery({
      queryKey: settingsKey(generation),
      queryFn: () => late.promise,
    });
    await Promise.resolve();

    const switched = { bookmarkFolderId: "folder-b", bookmarkFolderName: "Account B" };
    await commitSettingsTransition(queryClient, generation, switched);
    late.resolve({ bookmarkFolderId: "folder-a", bookmarkFolderName: "Account A" });
    await oldRequest.catch(() => undefined);

    expect(queryClient.getQueryData<typeof switched>(settingsKey(generation))).toEqual(switched);
  });
});

describe("bookmark-folder cost presentation", () => {
  it("surfaces a billable receipt and stays silent for absent or free receipts", () => {
    const folders = [{ id: "folder-1", name: "Reading" }];
    const response = (cost?: FoldersResponse["cost"]): FoldersResponse => ({
      folders,
      ...(cost ? { cost } : {}),
    });

    expect(folderCostNotice(response())).toBeNull();
    expect(folderCostNotice(response({ posts: 1, billable: 0, usd: 0 }))).toBeNull();
    expect(folderCostNotice(response({ posts: 1, billable: 1, usd: 0.01 }))).toBe(
      "folder lookup cost 1¢",
    );
  });
});

describe("bookmark sync single-flight ownership", () => {
  it("rejects a same-tick duplicate and releases after success", async () => {
    const flight = createSingleFlight();
    const pending = deferred<void>();
    const calls: string[] = [];

    const first = flight.run(async () => {
      calls.push("first");
      await pending.promise;
    });
    const duplicate = flight.run(async () => {
      calls.push("duplicate");
    });

    expect(await duplicate).toBe(false);
    expect(calls).toEqual(["first"]);
    pending.resolve();
    expect(await first).toBe(true);
    expect(await flight.run(async () => calls.push("after"))).toBe(true);
    expect(calls).toEqual(["first", "after"]);
  });

  it("releases after the owned operation rejects", async () => {
    const flight = createSingleFlight();
    const failed = flight.run(async () => {
      throw new Error("sync failed");
    });

    expect(await failed.catch((error: unknown) => error)).toEqual(new Error("sync failed"));
    expect(await flight.run(async () => undefined)).toBe(true);
  });

  it("owns the whole folder-change chain before its first await", async () => {
    const flight = createSingleFlight();
    const folderSaved = deferred<void>();
    const calls: string[] = [];

    const changeFolder = flight.run(async () => {
      calls.push("set folder A");
      await folderSaved.promise;
      calls.push("sync folder A");
    });
    const manualSync = flight.run(async () => {
      calls.push("manual sync");
    });
    const secondFolder = flight.run(async () => {
      calls.push("set folder B");
    });

    expect(await manualSync).toBe(false);
    expect(await secondFolder).toBe(false);
    expect(calls).toEqual(["set folder A"]);

    folderSaved.resolve();
    expect(await changeFolder).toBe(true);
    expect(calls).toEqual(["set folder A", "sync folder A"]);
  });
});

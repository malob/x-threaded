import { describe, expect, it } from "bun:test";
import type { FoldersResponse, SettingsResponse } from "../src/shared/types";
import {
  createSingleFlight,
  folderCostNotice,
  folderSettingsState,
} from "../src/web/inbox-state";

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

/**
 * The chunking helper itself. What chunking does to the *answers* — that a
 * 250-id list still comes back whole, on either driver — is pinned by the
 * storage contract suite instead (test/storage-contract.ts).
 */
import { describe, expect, it } from "bun:test";
import { MAX_SQL_PARAMS, chunked, placeholders } from "../src/server/db/driver";
import { D1_MAX_BOUND_PARAMS } from "./fake-d1";

describe("chunked", () => {
  it("splits into runs of at most size, in order", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(chunked([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
    expect(chunked([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it("gives an empty list no chunks, so callers can loop unguarded", () => {
    expect(chunked([], 100)).toEqual([]);
  });

  it("rejects a size that couldn't make progress", () => {
    expect(() => chunked([1], 0)).toThrow("positive integer");
    expect(() => chunked([1], -1)).toThrow("positive integer");
    expect(() => chunked([1], 1.5)).toThrow("positive integer");
  });

  it("matches the ceiling the D1 fake enforces", () => {
    expect(MAX_SQL_PARAMS).toBe(D1_MAX_BOUND_PARAMS);
  });
});

describe("placeholders", () => {
  it("writes one ? per bound parameter", () => {
    expect(placeholders(1)).toBe("?");
    expect(placeholders(3)).toBe("?,?,?");
    expect(placeholders(0)).toBe("");
  });
});

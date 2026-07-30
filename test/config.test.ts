import { describe, expect, it } from "bun:test";
import { resolveMaxPosts } from "../src/server/config";

describe("resolveMaxPosts", () => {
  it("defaults to 500 when unset", () => {
    expect(resolveMaxPosts(undefined)).toBe(500);
  });

  it("accepts an in-range integer", () => {
    expect(resolveMaxPosts("600")).toBe(600);
    expect(resolveMaxPosts("1")).toBe(1);
    expect(resolveMaxPosts("5000")).toBe(5000);
  });

  // Every one of these used to become NaN (or slip through Number()), and
  // `posts.length >= NaN` never trips — the per-conversation spend cap would
  // silently vanish. Booting is the last moment we can refuse.
  it.each([
    ["a typo", "5OO"],
    ["non-numeric", "abc"],
    ["empty", ""],
    ["whitespace", " "],
    ["zero", "0"],
    ["negative", "-1"],
    ["exponent notation", "1e3"],
    ["fractional", "1.5"],
    ["above the ceiling", "9999999"],
  ])("throws on %s", (_label, raw) => {
    expect(() => resolveMaxPosts(raw)).toThrow(/MAX_POSTS_PER_FETCH/);
    // The offending value has to reach the operator staring at the log line.
    expect(() => resolveMaxPosts(raw)).toThrow(JSON.stringify(raw));
  });
});

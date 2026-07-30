import { describe, expect, it } from "bun:test";
import { clamp, parseIntStrict } from "../src/shared/num";

describe("parseIntStrict", () => {
  it("accepts exactly decimal integers", () => {
    expect(parseIntStrict("10")).toBe(10);
    expect(parseIntStrict("-3")).toBe(-3);
    expect(parseIntStrict("0")).toBe(0);
  });

  it("rejects everything Number() would quietly mangle", () => {
    for (const bad of ["", " ", "abc", "1.5", "1e3", "0x10", "5OO", " 7", "7 ", "+7", "NaN", "Infinity"]) {
      expect(parseIntStrict(bad)).toBeNull();
    }
  });
});

describe("clamp", () => {
  it("clamps into the inclusive range", () => {
    expect(clamp(0, 1, 50)).toBe(1);
    expect(clamp(999, 1, 50)).toBe(50);
    expect(clamp(25, 1, 50)).toBe(25);
  });
});

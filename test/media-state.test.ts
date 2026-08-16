import { describe, expect, it } from "bun:test";
import { mediaSourceVisible } from "../src/web/media-state";

describe("media failure state", () => {
  it("shows a new src for the same media identity after the old src failed", () => {
    const oldSrc = "https://cdn.example/old.jpg";
    const newSrc = "https://cdn.example/new.jpg";

    expect(mediaSourceVisible(oldSrc, null)).toBe(true);
    expect(mediaSourceVisible(oldSrc, oldSrc)).toBe(false);
    expect(mediaSourceVisible(newSrc, oldSrc)).toBe(true);
  });

  it("renders nothing when the media has no usable source", () => {
    expect(mediaSourceVisible(null, null)).toBe(false);
    expect(mediaSourceVisible("", null)).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import {
  cancelPendingKey,
  cancelPendingKeyOnPointer,
} from "../src/web/thread/pending";

describe("pending key cancellation", () => {
  it("drops a prefix before a pointer interaction changes the target", () => {
    const target = new EventTarget();
    const pending = { current: "z" as string | null };
    const stop = cancelPendingKeyOnPointer(target, pending);

    target.dispatchEvent(new Event("pointerdown"));
    expect(pending.current).toBeNull();

    stop();
    pending.current = "g";
    target.dispatchEvent(new Event("pointerdown"));
    expect(pending.current).toBe("g");
  });

  it("drops a prefix before yielding Enter or Space to a native control", () => {
    const pending = { current: "y" as string | null };
    cancelPendingKey(pending);
    expect(pending.current).toBeNull();
  });
});

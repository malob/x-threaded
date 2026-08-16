/** The ref-shaped storage Thread uses so prefixes do not trigger a render. */
export interface PendingKeyRef {
  current: string | null;
}

/** Any interaction handed to a different target ends a half-typed command. */
export function cancelPendingKey(pending: PendingKeyRef): void {
  pending.current = null;
}

/**
 * Pointer interaction can move the cursor, toggle a fold, follow a link or
 * focus a native control. Listen in capture so child handlers cannot preserve
 * a prefix by stopping propagation.
 */
export function cancelPendingKeyOnPointer(
  target: EventTarget,
  pending: PendingKeyRef,
): () => void {
  const cancel = () => cancelPendingKey(pending);
  target.addEventListener("pointerdown", cancel, { capture: true });
  return () => target.removeEventListener("pointerdown", cancel, { capture: true });
}

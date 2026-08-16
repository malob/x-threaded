import { formatUsd } from "../shared/pricing";
import type { FoldersResponse, SettingsResponse } from "../shared/types";

export interface SingleFlight {
  /** Returns false without invoking `operation` when another call owns the flight. */
  run(operation: () => Promise<unknown>): Promise<boolean>;
}

/**
 * A synchronous admission gate for an async operation.
 *
 * Acquiring before the first await closes the one-render gap where two event
 * paths both still observe a mutation hook as idle. The owner releases the
 * gate on both fulfillment and rejection.
 */
export function createSingleFlight(): SingleFlight {
  let active = false;
  return {
    async run(operation) {
      if (active) return false;
      active = true;
      try {
        await operation();
        return true;
      } finally {
        active = false;
      }
    },
  };
}

/** The four meanings `settings.data === undefined` used to collapse together. */
export type FolderSettingsState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty"; readonly settings: SettingsResponse }
  | { readonly kind: "data"; readonly settings: SettingsResponse };

/**
 * Give cached data precedence over a background-refetch error: it is still a
 * settings value the reader can use, while a first-load failure has no value
 * and must never masquerade as "no folder selected".
 */
export function folderSettingsState(
  settings: SettingsResponse | undefined,
  error: Error | null,
): FolderSettingsState {
  if (settings) {
    return settings.bookmarkFolderId
      ? { kind: "data", settings }
      : { kind: "empty", settings };
  }
  if (error) return { kind: "error", message: error.message };
  return { kind: "loading" };
}

/** A successful folder request can carry the User Read that resolved identity. */
export function folderCostNotice(response: FoldersResponse | undefined): string | null {
  const cost = response?.cost;
  return cost && cost.billable > 0
    ? `folder lookup cost ${formatUsd(cost.usd, false)}`
    : null;
}

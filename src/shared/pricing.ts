/**
 * X API pay-per-use rates and the estimates we show before spending money.
 * https://docs.x.com/x-api/getting-started/pricing
 */
export const POST_READ_USD = 0.005;

/** Reading your own posts — timeline, bookmarks — is an Owned Read. */
export const OWNED_READ_USD = 0.001;

/**
 * What one X call billed, in the two units X charges in.
 *
 * An estimate, always: X deduplicates a post read within a 24h UTC day and
 * documents that dedup as soft, so nothing here is a figure X will confirm.
 * The free /2/usage/tweets endpoint is what reconciles this ledger against
 * their meter (2026-07-30 review, H1).
 */
export interface Receipt {
  /** Posts read at the lookup/search rate. */
  readonly reads: number;
  /** Posts read from the signed-in user's own timeline or bookmarks. */
  readonly ownedReads: number;
}

export const NO_READS: Receipt = { reads: 0, ownedReads: 0 };

export function postReads(count: number): Receipt {
  return { reads: count, ownedReads: 0 };
}

export function ownedReads(count: number): Receipt {
  return { reads: 0, ownedReads: count };
}

export function addReceipts(a: Receipt, b: Receipt): Receipt {
  return { reads: a.reads + b.reads, ownedReads: a.ownedReads + b.ownedReads };
}

/** The one place reads become dollars. */
export function receiptUsd(receipt: Receipt): number {
  return receipt.reads * POST_READ_USD + receipt.ownedReads * OWNED_READ_USD;
}

/**
 * Posts a conversation is likely to contain, from its root's reply count.
 *
 * reply_count only counts direct replies, so it undershoots: measured across
 * cached conversations the true total ran 1.2–1.9× it (mean ~1.5). Calling
 * the counts endpoint would be exact but costs a post read per conversation,
 * which is too much to spend rendering a list.
 */
export function estimatePostCount(replyCount: number): number {
  return Math.max(1, Math.round(1 + replyCount * 1.5));
}

export function estimateFetchUsd(replyCount: number): number {
  return estimatePostCount(replyCount) * POST_READ_USD;
}

/** Compact money for UI: "free", "<1¢", "~7¢", "~$1.20". */
export function formatUsd(usd: number, approximate = true): string {
  if (usd <= 0) return "free";
  const prefix = approximate ? "~" : "";
  if (usd < 0.01) return "<1¢";
  if (usd < 1) return `${prefix}${Math.round(usd * 100)}¢`;
  return `${prefix}$${usd.toFixed(2)}`;
}

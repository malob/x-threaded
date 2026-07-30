/**
 * X API pay-per-use rates and the estimates we show before spending money.
 * https://docs.x.com/x-api/getting-started/pricing
 */
export const POST_READ_USD = 0.005;
export const OWNED_READ_USD = 0.001;

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

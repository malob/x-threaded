/**
 * Strict numeric parsing for the inputs that gate spending. Number() accepts
 * "", "1e3", and whitespace, and turns garbage into NaN — which every `>=`
 * guard treats as false, silently disabling caps (see the 2026-07-30 review,
 * finding C2). These helpers make NaN unrepresentable at the boundaries.
 */

/** Parse a decimal integer exactly; null for anything else (incl. "", "1.5", "1e3"). */
export function parseIntStrict(raw: string): number | null {
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * Extract a post ID from an x.com / twitter.com status URL or a bare numeric ID.
 * Handles missing protocols, www/mobile subdomains, query strings, and
 * trailing segments like /photo/1 or /video/1. Returns null when nothing
 * parseable is found.
 */
export function parsePostUrl(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{5,}$/.test(trimmed)) return trimmed;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www|mobile)\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;

  const match = url.pathname.match(/^\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/(\d+)/);
  return match?.[1] ?? null;
}

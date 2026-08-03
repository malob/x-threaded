/**
 * Everything the app knows about x.com URLs and its own routes, in one place.
 *
 * The app's routes mirror x.com's so a post URL becomes an app URL by swapping
 * the domain — which means the same status-path shape is parsed on the server
 * (pasted URLs) and in the client (deep links), and must agree. Shared here so
 * there is one regex, and one way to build a link back out.
 */

/**
 * `/<handle>/status/<postId>`, as x.com serves it. Handles are at most 15
 * characters; the legacy `/statuses/` spelling still redirects, so accept it.
 * Trailing segments (`/photo/1`, `/video/1`) are ignored, not rejected.
 */
export const STATUS_PATH = /^\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/(\d+)/;

/**
 * A bare post ID: digits only. Snowflakes have been 18-19 digits for over a
 * decade, but the floor stays low (5) so the very oldest posts still parse —
 * the point is to reject handles, paths, and typos, not to date-check.
 */
export function parsePostId(raw: string): string | null {
  const trimmed = raw.trim();
  return /^\d{5,}$/.test(trimmed) ? trimmed : null;
}

/** The post ID a `/<handle>/status/<id>` pathname points at, if it is one. */
export function parsePostPath(pathname: string): string | null {
  return STATUS_PATH.exec(pathname)?.[1] ?? null;
}

/**
 * Extract a post ID from an x.com / twitter.com status URL or a bare numeric ID.
 * Handles missing protocols, www/mobile subdomains, query strings, and
 * trailing segments like /photo/1 or /video/1. Returns null when nothing
 * parseable is found.
 */
export function parsePostUrl(input: string): string | null {
  const trimmed = input.trim();
  const bare = parsePostId(trimmed);
  if (bare) return bare;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www|mobile)\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;

  return parsePostPath(url.pathname);
}

/**
 * This app's path for a post. The handle is decorative (as on X); "i" is the
 * placeholder x.com itself uses when the handle isn't known yet.
 */
export function appPath(handle: string | undefined, postId: string): string {
  return `/${handle ?? "i"}/status/${postId}`;
}

/** The canonical x.com URL for a post, handle known or not. */
export function xPostUrl(handle: string | undefined, postId: string): string {
  return `https://x.com${appPath(handle, postId)}`;
}

/**
 * An author's profile on x.com — the app's one profile link, worn by the
 * @handle in a byline (ruling n: the name is not a link, and neither is the
 * avatar, which is the node you click to select).
 */
export function xProfileUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

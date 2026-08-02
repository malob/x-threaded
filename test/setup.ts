/**
 * Network tripwire, preloaded before every test file (see bunfig.toml).
 *
 * X API reads bill per post, so a test that reaches the network costs money
 * and reports nothing. The real fetch is dropped on the floor here rather
 * than stashed: nothing in the suite can restore it, which is what makes
 * "tests never hit the network" structural instead of a convention.
 */

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let handler: FetchHandler | null = null;

function requestUrl(input: Request | URL | string): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const url = requestUrl(input);
  if (!handler) throw new Error("network tripwire: unexpected fetch to " + url);
  return await handler(url, init);
}) as unknown as typeof fetch;

/**
 * Serve fetches from `handler` for the duration of a test. Returns a restore
 * function that puts back whatever was installed before (the tripwire, in the
 * normal case) — call it in a finally or afterEach.
 */
export function withMockFetch(handler_: FetchHandler): () => void {
  const previous = handler;
  handler = handler_;
  return () => {
    handler = previous;
  };
}

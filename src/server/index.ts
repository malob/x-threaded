import { serveStatic } from "hono/bun";
import { buildApp } from "./app";
import { resolveMaxPosts } from "./config";
import { bunDriver } from "./db/bun";
import { SqlStore } from "./db/store";
import { XApi } from "./xapi";

const port = Number(process.env.PORT ?? 8788);
const hostname = "127.0.0.1";
// Keep the browser-facing origin aligned with the callback documented for the
// X app. The socket still binds explicitly to IPv4 loopback; advertising that
// numeric address would make OAuth derive a redirect_uri that does not match
// the registered localhost callback.
const advertisedHostname = "localhost";
// Conversation reads can legitimately wait through pagination and one
// bounded X retry without writing response bytes. Bun's documented default
// idle timeout treats that as idle, so disable it for this loopback-only
// development server instead of resetting a request after it has spent.
const idleTimeout = 0;
const dbPath = process.env.DB_PATH ?? "data/x-threaded.sqlite";
const bearerToken = process.env.X_BEARER_TOKEN;

if (!bearerToken) {
  console.error("X_BEARER_TOKEN is not set; refusing to start.");
  process.exit(1);
}

/** A malformed main-result limit is worse than none: refuse to start, like above. */
function readMaxPosts(): number {
  try {
    return resolveMaxPosts(process.env.MAX_POSTS_PER_FETCH);
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}; refusing to start.`,
    );
    process.exit(1);
  }
}

const maxPosts = readMaxPosts();

const clientId = process.env.X_OAUTH_CLIENT_ID;
const clientSecret = process.env.X_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.warn(
    "X_OAUTH_CLIENT_ID / X_OAUTH_CLIENT_SECRET are not both set — " +
      "user-context features (your posts, bookmarks) are disabled. See .env.example.",
  );
}

/**
 * Local dev holds its own OAuth grant, separate from production's. Refresh
 * tokens are single-use and rotate, so two stores must never share a chain;
 * authorizing separately at /auth/login gives this instance its own.
 */
const app = buildApp({
  store: new SqlStore(await bunDriver(dbPath)),
  xapi: new XApi(bearerToken),
  maxPosts,
  oauth: clientId && clientSecret ? { clientId, clientSecret } : null,
});

app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

export const serverBinding = { hostname, port, idleTimeout };
export const serverAdvertisedHostname = advertisedHostname;
const serverConfig = { ...serverBinding, fetch: app.fetch };

// Start explicitly so importing this entrypoint never opens a listener and the
// success message is emitted only after Bun has actually bound the socket.
if (import.meta.main) {
  const server = Bun.serve(serverConfig);
  console.log(
    `x-threaded server listening on http://${advertisedHostname}:${server.port}`,
  );
}

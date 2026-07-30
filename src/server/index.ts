import { serveStatic } from "hono/bun";
import { buildApp } from "./app";
import { resolveMaxPosts } from "./config";
import { SqliteStore } from "./store-sqlite";
import { XApi } from "./xapi";

const port = Number(process.env.PORT ?? 8788);
const dbPath = process.env.DB_PATH ?? "data/x-threaded.sqlite";
const bearerToken = process.env.X_BEARER_TOKEN;

if (!bearerToken) {
  console.error("X_BEARER_TOKEN is not set; refusing to start.");
  process.exit(1);
}

/** A malformed spending cap is worse than none: refuse to start, like above. */
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
  store: new SqliteStore(dbPath),
  xapi: new XApi(bearerToken),
  maxPosts,
  oauth: clientId && clientSecret ? { clientId, clientSecret } : null,
});

app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

console.log(`x-threaded server listening on http://localhost:${port}`);

export default { port, fetch: app.fetch };

import { serveStatic } from "hono/bun";
import { buildApp } from "./app";
import { SqliteStore } from "./store-sqlite";
import { XApi } from "./xapi";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? "data/x-threaded.sqlite";
const maxPosts = Number(process.env.MAX_POSTS_PER_FETCH ?? 500);
const bearerToken = process.env.X_BEARER_TOKEN;

if (!bearerToken) {
  console.error("X_BEARER_TOKEN is not set; refusing to start.");
  process.exit(1);
}

const app = buildApp({
  store: new SqliteStore(dbPath),
  xapi: new XApi(bearerToken),
  maxPosts,
});

app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

console.log(`x-threaded server listening on http://localhost:${port}`);

export default { port, fetch: app.fetch };

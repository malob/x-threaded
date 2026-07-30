import type { Hono } from "hono";
import { buildApp } from "../src/server/app";
import type { OAuthConfig } from "../src/server/oauth";
import { SqliteStore } from "../src/server/store-sqlite";
import { D1Store } from "../src/server/store-d1";
import { FakeD1Database } from "./fake-d1";
import { FakeXApi } from "./fake-xapi";

export interface TestAppOptions {
  maxPosts?: number;
  oauth?: OAuthConfig | null;
}

/**
 * The real routes over a real (in-memory) store and a throwing X API double.
 * Drive it with app.request(); nothing here can reach the network.
 */
export function makeTestApp(opts: TestAppOptions = {}): {
  app: Hono;
  store: SqliteStore;
  xapi: FakeXApi;
} {
  const store = new SqliteStore(":memory:");
  const xapi = new FakeXApi();
  const app = buildApp({
    store,
    xapi,
    maxPosts: opts.maxPosts ?? 500,
    oauth: opts.oauth ?? null,
  });
  return { app, store, xapi };
}

/** The Worker's store, over a fresh D1 stand-in. */
export function makeD1TestStore(): D1Store {
  return new D1Store(new FakeD1Database());
}

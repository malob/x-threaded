import { checkAccess } from "./access";
import { buildApp } from "./app";
import { resolveMaxPosts } from "./config";
import { D1Store, type D1Database } from "./store-d1";
import { XApi } from "./xapi";

interface Env {
  DB: D1Database;
  X_BEARER_TOKEN: string;
  MAX_POSTS_PER_FETCH?: string;
  /** Cloudflare Access AUD tag; enables JWT enforcement when set. */
  POLICY_AUD?: string;
  /** https://<team>.cloudflareaccess.com */
  TEAM_DOMAIN?: string;
  /** OAuth 2.0 user context; absent means user-context features are off. */
  X_OAUTH_CLIENT_ID?: string;
  X_OAUTH_CLIENT_SECRET?: string;
}

/**
 * Cloudflare Workers entry. Static assets and the SPA fallback are handled
 * by the assets config in wrangler.jsonc; only /api/* reaches this handler
 * (run_worker_first).
 */
export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const denial = await checkAccess(request, {
      policyAud: env.POLICY_AUD,
      teamDomain: env.TEAM_DOMAIN,
    });
    if (denial) return denial;

    if (!env.X_BEARER_TOKEN) {
      return Response.json(
        { error: "X_BEARER_TOKEN secret is not set — run: wrangler secret put X_BEARER_TOKEN" },
        { status: 500 },
      );
    }

    // A malformed cap would silently uncap spending, so serve an error instead.
    let maxPosts: number;
    try {
      maxPosts = resolveMaxPosts(env.MAX_POSTS_PER_FETCH);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }

    const app = buildApp({
      store: new D1Store(env.DB),
      xapi: new XApi(env.X_BEARER_TOKEN),
      maxPosts,
      oauth:
        env.X_OAUTH_CLIENT_ID && env.X_OAUTH_CLIENT_SECRET
          ? { clientId: env.X_OAUTH_CLIENT_ID, clientSecret: env.X_OAUTH_CLIENT_SECRET }
          : null,
    });
    return app.fetch(request, env, ctx as Parameters<typeof app.fetch>[2]);
  },
};

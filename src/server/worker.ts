import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import { checkAccess } from "./access";
import { buildApp } from "./app";
import { resolveMaxPosts } from "./config";
import { d1Driver } from "./db/d1";
import { SqlStore } from "./db/store";
import { XApi } from "./xapi";

interface Env {
  DB: D1Database;
  X_BEARER_TOKEN: string;
  MAX_POSTS_PER_FETCH?: string;
  /** Cloudflare Access AUD tag; enables JWT enforcement when set. */
  POLICY_AUD?: string;
  /** https://<team>.cloudflareaccess.com */
  TEAM_DOMAIN?: string;
  /** "true" to serve this deployment with no gate; see access.ts. */
  ALLOW_UNGATED?: string;
  /** OAuth 2.0 user context; absent means user-context features are off. */
  X_OAUTH_CLIENT_ID?: string;
  X_OAUTH_CLIENT_SECRET?: string;
}

/**
 * Cloudflare Workers entry. Static assets and the SPA fallback are handled by
 * the assets config in wrangler.jsonc, whose `run_worker_first` lists both
 * prefixes that reach this handler: /api/* and /auth/*. The second is not
 * optional — the OAuth redirect and callback live there, and letting the SPA
 * swallow them breaks login.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const denial = await checkAccess(request, {
      policyAud: env.POLICY_AUD,
      teamDomain: env.TEAM_DOMAIN,
      // Exact match on purpose: "false", "0" and typos all leave the gate up.
      allowUngated: env.ALLOW_UNGATED === "true",
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

    // Built once per isolate, not per request. Beyond skipping the router
    // rebuild, this is what makes oauth.ts's per-store refresh single-flight
    // effective on Workers: it keys on the Storage instance, and per-request
    // stores would never share an entry, letting concurrent requests present
    // the same single-use refresh token twice (Stage 0 adversarial review).
    // Bindings are stable within a deployment; new deploys start new isolates.
    if (!cachedApp) {
      cachedApp = buildApp({
        store: new SqlStore(d1Driver(env.DB)),
        xapi: new XApi(env.X_BEARER_TOKEN),
        maxPosts,
        oauth:
          env.X_OAUTH_CLIENT_ID && env.X_OAUTH_CLIENT_SECRET
            ? { clientId: env.X_OAUTH_CLIENT_ID, clientSecret: env.X_OAUTH_CLIENT_SECRET }
            : null,
      });
    }
    return cachedApp.fetch(request, env, ctx);
  },
};

let cachedApp: ReturnType<typeof buildApp> | null = null;

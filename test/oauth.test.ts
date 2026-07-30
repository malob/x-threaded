import { describe, expect, it } from "bun:test";
import { bunDriver } from "../src/server/db/bun";
import { SqlStore } from "../src/server/db/store";
import { getUserAccessToken, SELF_ID, type OAuthConfig } from "../src/server/oauth";
import { withMockFetch } from "./setup";

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const CONFIG: OAuthConfig = { clientId: "client-id", clientSecret: "client-secret" };
const GRANTED_SCOPE = "tweet.read users.read bookmark.read offline.access";

function newStore(): SqlStore {
  return new SqlStore(bunDriver(":memory:"));
}

/** A token endpoint that counts hits and hands back a fresh, unexpired pair. */
function tokenEndpoint(options: { scope?: string; delayMs?: number } = {}) {
  const state = { hits: 0 };
  const handler = async (url: string) => {
    if (url !== TOKEN_URL) throw new Error(`unexpected fetch to ${url}`);
    state.hits++;
    const n = state.hits;
    if (options.delayMs) await Bun.sleep(options.delayMs);
    return Response.json({
      access_token: `access-${n}`,
      refresh_token: `refresh-${n}`,
      expires_in: 7200,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    });
  };
  return { state, handler };
}

describe("getUserAccessToken", () => {
  it("returns a live access token without touching the network", async () => {
    // No withMockFetch: the tripwire turns any refresh attempt into a failure.
    const store = newStore();
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "live",
      refreshToken: "refresh-0",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: GRANTED_SCOPE,
      userId: "42",
    });

    expect(await getUserAccessToken(store, CONFIG)).toBe("live");
  });

  it("keeps the cached user ID and prior scope across a rotation", async () => {
    const store = newStore();
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "expired",
      refreshToken: "refresh-0",
      expiresAt: Date.now() - 1000,
      scope: GRANTED_SCOPE,
      userId: "42",
    });

    const { state, handler } = tokenEndpoint(); // X omits `scope` on refresh
    const restore = withMockFetch(handler);
    try {
      expect(await getUserAccessToken(store, CONFIG)).toBe("access-1");
    } finally {
      restore();
    }

    expect(state.hits).toBe(1);
    const stored = await store.getOAuthTokens(SELF_ID);
    // The rotation itself must land...
    expect(stored?.accessToken).toBe("access-1");
    expect(stored?.refreshToken).toBe("refresh-1");
    // ...without erasing the metadata that isn't in the refresh response.
    expect(stored?.userId).toBe("42");
    expect(stored?.scope).toBe(GRANTED_SCOPE);
  });

  it("takes a scope from the refresh response when X sends one", async () => {
    const store = newStore();
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "expired",
      refreshToken: "refresh-0",
      expiresAt: Date.now() - 1000,
      scope: GRANTED_SCOPE,
      userId: "42",
    });

    const narrowed = "tweet.read users.read offline.access";
    const { handler } = tokenEndpoint({ scope: narrowed });
    const restore = withMockFetch(handler);
    try {
      await getUserAccessToken(store, CONFIG);
    } finally {
      restore();
    }

    const stored = await store.getOAuthTokens(SELF_ID);
    expect(stored?.scope).toBe(narrowed);
    expect(stored?.userId).toBe("42");
  });

  it("presents a single-use refresh token to X only once under concurrency", async () => {
    const store = newStore();
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "expired",
      refreshToken: "refresh-0",
      expiresAt: Date.now() - 1000,
      scope: GRANTED_SCOPE,
      userId: "42",
    });

    const { state, handler } = tokenEndpoint({ delayMs: 20 });
    const restore = withMockFetch(handler);
    try {
      const [first, second] = await Promise.all([
        getUserAccessToken(store, CONFIG),
        getUserAccessToken(store, CONFIG),
      ]);
      expect(state.hits).toBe(1);
      expect(first).toBe("access-1");
      expect(second).toBe("access-1");

      // The fresh token is far from expiry, so nothing refreshes again.
      expect(await getUserAccessToken(store, CONFIG)).toBe("access-1");
      expect(state.hits).toBe(1);
    } finally {
      restore();
    }
  });

  it("refreshes again after a failed refresh instead of caching the rejection", async () => {
    const store = newStore();
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "expired",
      refreshToken: "refresh-0",
      expiresAt: Date.now() - 1000,
      scope: GRANTED_SCOPE,
      userId: "42",
    });

    let hits = 0;
    const restore = withMockFetch(async () => {
      hits++;
      if (hits === 1) {
        return Response.json({ error: "server_error" }, { status: 503 });
      }
      return Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 7200,
      });
    });
    try {
      await expect(getUserAccessToken(store, CONFIG)).rejects.toThrow("token refresh failed (503)");
      expect(await getUserAccessToken(store, CONFIG)).toBe("access-2");
    } finally {
      restore();
    }
    expect(hits).toBe(2);
  });

  it("does not couple refreshes across unrelated stores", async () => {
    const stores = [newStore(), newStore()];
    for (const store of stores) {
      await store.putOAuthTokens(SELF_ID, {
        accessToken: "expired",
        refreshToken: "refresh-0",
        expiresAt: Date.now() - 1000,
        scope: GRANTED_SCOPE,
        userId: "42",
      });
    }

    const { state, handler } = tokenEndpoint({ delayMs: 20 });
    const restore = withMockFetch(handler);
    try {
      const tokens = await Promise.all(stores.map((s) => getUserAccessToken(s, CONFIG)));
      expect(state.hits).toBe(2);
      expect(new Set(tokens).size).toBe(2);
    } finally {
      restore();
    }
  });
});

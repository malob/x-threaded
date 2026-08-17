import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { bunDriver } from "../src/server/db/bun";
import { SqlStore } from "../src/server/db/store";
import {
  exchangeCode,
  exchangeCodeForTokens,
  getUserAccessToken,
  OAuthCodeExchangeError,
  OAuthGrantConflictError,
  revokeOAuthGrant,
  SELF_ID,
  type OAuthConfig,
  type TokenTimings,
} from "../src/server/oauth";
import type { Storage } from "../src/server/storage";
import { withMockFetch } from "./setup";

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const CONFIG: OAuthConfig = { clientId: "client-id", clientSecret: "client-secret" };
const GRANTED_SCOPE = "tweet.read users.read bookmark.read offline.access";

/** Lease timings scaled down so a test can wait one out in milliseconds. */
const FAST: Partial<TokenTimings> = { leaseMs: 200, graceMs: 50, pollMs: 5, fetchTimeoutMs: 500 };

async function newStore(): Promise<SqlStore> {
  return new SqlStore(await bunDriver(":memory:"));
}

/** A store holding a grant that is past its refresh margin. */
async function storeWithExpiredToken(store?: SqlStore): Promise<SqlStore> {
  const target = store ?? (await newStore());
  await target.putOAuthTokens(SELF_ID, {
    accessToken: "expired",
    refreshToken: "refresh-0",
    expiresAt: Date.now() - 1000,
    scope: GRANTED_SCOPE,
    userId: "42",
  });
  return target;
}

/** A token endpoint that counts hits and hands back a fresh, unexpired pair. */
function tokenEndpoint(
  options: { scope?: string; delayMs?: number; onHit?: () => void | Promise<void> } = {},
) {
  const state = { hits: 0 };
  const handler = async (url: string) => {
    if (url !== TOKEN_URL) throw new Error(`unexpected fetch to ${url}`);
    state.hits++;
    const n = state.hits;
    await options.onHit?.();
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

/** A token endpoint that refuses, the way X refuses a spent refresh token. */
function deadGrantEndpoint() {
  const state = { hits: 0 };
  const handler = async () => {
    state.hits++;
    return Response.json(
      { error: "invalid_grant", error_description: "Value passed for the token was invalid." },
      { status: 400 },
    );
  };
  return { state, handler };
}

/** Run `body` with `handler` installed, restoring the tripwire afterwards. */
async function withEndpoint<T>(
  handler: Parameters<typeof withMockFetch>[0],
  body: () => Promise<T>,
): Promise<T> {
  const restore = withMockFetch(handler);
  try {
    return await body();
  } finally {
    restore();
  }
}

afterEach(() => {
  setSystemTime();
});

describe("getUserAccessToken", () => {
  it("returns a live access token without touching the network", async () => {
    // No withMockFetch: the tripwire turns any refresh attempt into a failure.
    const store = await newStore();
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
    const store = await newStore();
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
    const store = await newStore();
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
    const store = await newStore();
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
    const store = await newStore();
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
        // A definite endpoint rejection: X evaluated the request and issued
        // nothing, so the token is provably unspent and the lease releases.
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      return Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 7200,
      });
    });
    try {
      await expect(getUserAccessToken(store, CONFIG)).rejects.toThrow("token refresh failed (400)");
      expect(await getUserAccessToken(store, CONFIG)).toBe("access-2");
    } finally {
      restore();
    }
    expect(hits).toBe(2);
  });

  it("does not couple refreshes across unrelated stores", async () => {
    const stores = [await newStore(), await newStore()];
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

/**
 * The durable lease: what stops two *isolates* from presenting the same
 * single-use refresh token to X (2026-07-30 review, C4; dialogue rounds 2–3).
 *
 * Two SqlStore instances over one database is the whole point of the setup —
 * it is exactly what a Worker sees under concurrent requests, and the
 * in-process WeakMap single-flight cannot see across it.
 */
describe("getUserAccessToken — the cross-isolate lease", () => {
  /** Two stores over one database: separate isolates, shared truth. */
  async function twoIsolates(): Promise<[SqlStore, SqlStore]> {
    const driver = await bunDriver(":memory:");
    return [new SqlStore(driver), new SqlStore(driver)];
  }

  it("presents the token once and makes the cross-isolate loser retry", async () => {
    const [first, second] = await twoIsolates();
    await storeWithExpiredToken(first);

    const { state, handler } = tokenEndpoint({ delayMs: 20 });
    const results = await withEndpoint(handler, () =>
      Promise.allSettled([
        getUserAccessToken(first, CONFIG, FAST),
        getUserAccessToken(second, CONFIG, FAST),
      ]),
    );

    expect(state.hits).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: "access-1" },
    ]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(OAuthGrantConflictError);
    expect(await first.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      state: "ready",
      leaseId: null,
      recoveryUsed: false,
      userId: "42",
      scope: GRANTED_SCOPE,
    });
  });

  it("carries a loser through to the winner's broken verdict", async () => {
    const [first, second] = await twoIsolates();
    await storeWithExpiredToken(first);

    const { state, handler } = deadGrantEndpoint();
    await withEndpoint(handler, async () => {
      const results = await Promise.allSettled([
        getUserAccessToken(first, CONFIG, FAST),
        getUserAccessToken(second, CONFIG, FAST),
      ]);
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    });

    expect(state.hits).toBe(1);
    expect(await first.getOAuthTokens(SELF_ID)).toMatchObject({ state: "broken" });
  });
});

describe("getUserAccessToken — a grant X has rejected", () => {
  it("records invalid_grant as broken and stops asking", async () => {
    const store = await storeWithExpiredToken();

    const { state, handler } = deadGrantEndpoint();
    await withEndpoint(handler, async () => {
      await expect(getUserAccessToken(store, CONFIG, FAST)).rejects.toThrow(/invalid_grant/);

      const broken = await store.getOAuthTokens(SELF_ID);
      expect(broken).toMatchObject({ state: "broken", leaseId: null });
      expect(broken?.brokenReason).toContain("invalid_grant");

      // The grant is dead; re-asking would only be another dead presentation.
      await expect(getUserAccessToken(store, CONFIG, FAST)).rejects.toThrow(/reconnect|login/i);
      expect(state.hits).toBe(1);
    });
  });

  it("hands the lease back when X refuses without spending the token", async () => {
    const store = await storeWithExpiredToken();

    await withEndpoint(
      async () => Response.json({ error: "invalid_request" }, { status: 400 }),
      async () => {
        await expect(getUserAccessToken(store, CONFIG, FAST)).rejects.toThrow(
          "token refresh failed (400)",
        );
      },
    );

    // A 4xx endpoint rejection means X issued nothing: still ours to retry.
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "ready",
      leaseId: null,
      leaseUntil: null,
      refreshToken: "refresh-0",
      recoveryUsed: false,
    });
  });

  it("still reads invalid_grant when a sibling field is malformed", async () => {
    const store = await storeWithExpiredToken();

    await withEndpoint(
      // One malformed sibling (scope as a number) must not erase the error
      // discriminator: the grant is just as dead as in a well-formed body,
      // and misreading it as `refused` would keep presenting a spent token.
      async () => Response.json({ error: "invalid_grant", scope: 42 }, { status: 400 }),
      async () => {
        await expect(getUserAccessToken(store, CONFIG, FAST)).rejects.toThrow(/invalid_grant/);
      },
    );

    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({ state: "broken" });
  });

  it("leaves the lease standing when the outcome is unknowable", async () => {
    const store = await storeWithExpiredToken();

    await withEndpoint(
      () => {
        throw new Error("The socket connection was closed unexpectedly");
      },
      async () => {
        await expect(getUserAccessToken(store, CONFIG, FAST)).rejects.toThrow(/socket|refresh/i);
      },
    );

    // X may have rotated the token before the connection died: releasing the
    // lease here would invite a second presentation of a spent token.
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "refreshing",
      recoveryUsed: false,
    });
    expect((await store.getOAuthTokens(SELF_ID))?.leaseId).toBeString();
  });

  it("treats a 5xx as unknowable too — a gateway can answer after X processed", async () => {
    const store = await storeWithExpiredToken();

    await withEndpoint(
      async () => Response.json({ error: "server_error" }, { status: 503 }),
      async () => {
        await expect(getUserAccessToken(store, CONFIG, FAST)).rejects.toThrow(
          "token refresh failed (503)",
        );
      },
    );

    // An HTTP response is not proof of non-consumption unless the endpoint
    // itself rejected the request (4xx): the lease stands for recovery.
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "refreshing",
      recoveryUsed: false,
    });
  });

  it("treats a 2xx missing the rotated refresh token as unknowable", async () => {
    const store = await storeWithExpiredToken();

    await withEndpoint(
      async () => Response.json({ access_token: "at-1", expires_in: 7200 }),
      async () => {
        await expect(getUserAccessToken(store, CONFIG, FAST)).rejects.toThrow(/nothing usable/);
      },
    );

    // X rotates on every refresh, so a success that omits the new refresh
    // token cannot be finalized: persisting the old one as `ready` would
    // record a token X may have just killed as the grant's future.
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "refreshing",
      refreshToken: "refresh-0",
      recoveryUsed: false,
    });
  });

  it("retries a transiently failing finalize without re-contacting X", async () => {
    const store = await storeWithExpiredToken();
    let finalizeFailures = 1;
    const flaky: typeof store = Object.create(store);
    flaky.finalizeTokenLease = async (...args) => {
      if (finalizeFailures-- > 0) throw new Error("D1_ERROR: transient");
      return store.finalizeTokenLease(...args);
    };

    const { state, handler } = tokenEndpoint();
    const restore = withMockFetch(handler);
    try {
      // The rotated pair must land despite the failed first write, and X must
      // be contacted exactly once — a retry that re-refreshed would present a
      // spent token.
      expect(await getUserAccessToken(flaky, CONFIG, FAST)).toBe("access-1");
    } finally {
      restore();
    }
    expect(state.hits).toBe(1);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "ready",
      refreshToken: "refresh-1",
    });
  });
});

/**
 * A holder that never came back. The lease has lapsed, but its holder may have
 * exchanged the token before dying — so recovery is one bounded attempt, and
 * anything ambiguous ends as `broken` (dialogue r3, verdict 1).
 */
describe("getUserAccessToken — recovering an abandoned lease", () => {
  /** A grant whose refresh is leased to a holder that then stopped existing. */
  async function abandoned(options: { recovered?: boolean } = {}): Promise<{
    store: SqlStore;
    leaseUntil: number;
  }> {
    const store = await storeWithExpiredToken();
    const leaseUntil = Date.now() + 30_000;
    await store.claimTokenLease(SELF_ID, "refresh-0", "dead-lease", leaseUntil);
    if (options.recovered) {
      await store.claimRecoveryLease(
        SELF_ID,
        "refresh-0",
        "dead-recovery",
        leaseUntil + 30_000,
        leaseUntil + 1,
      );
    }
    return { store, leaseUntil };
  }

  it("recovers once when the holder died before exchanging", async () => {
    const { store, leaseUntil } = await abandoned();
    setSystemTime(new Date(leaseUntil + 60_000));

    let recoveryUsedDuring: boolean | undefined;
    const { state, handler } = tokenEndpoint({
      onHit: async () => {
        recoveryUsedDuring = (await store.getOAuthTokens(SELF_ID))?.recoveryUsed;
      },
    });
    const token = await withEndpoint(handler, () => getUserAccessToken(store, CONFIG, FAST));

    expect(state.hits).toBe(1);
    expect(token).toBe("access-1");
    // The allowance is spent while the attempt is in flight, and restored only
    // by the rotation that proves the grant survived.
    expect(recoveryUsedDuring).toBe(true);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "ready",
      refreshToken: "refresh-1",
      recoveryUsed: false,
      leaseId: null,
    });
  });

  it("breaks the grant when the holder had already spent the token", async () => {
    const { store, leaseUntil } = await abandoned();
    setSystemTime(new Date(leaseUntil + 60_000));

    const { state, handler } = deadGrantEndpoint();
    await withEndpoint(handler, async () => {
      await expect(getUserAccessToken(store, CONFIG, FAST)).rejects.toThrow(/invalid_grant/);
    });

    expect(state.hits).toBe(1);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({ state: "broken" });
  });

  it("refuses a second recovery, without asking X", async () => {
    const { store, leaseUntil } = await abandoned({ recovered: true });
    setSystemTime(new Date(leaseUntil + 120_000));

    const { state, handler } = tokenEndpoint();
    await withEndpoint(handler, async () => {
      await expect(getUserAccessToken(store, CONFIG, FAST)).rejects.toThrow(/reconnect|login/i);
    });

    expect(state.hits).toBe(0);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "broken",
      refreshToken: "refresh-0",
    });
  });
});

describe("getUserAccessToken — finalize is conditional", () => {
  it("writes nothing when the lease was lost mid-refresh", async () => {
    const store = await storeWithExpiredToken();

    // A fresh /auth/login lands while our refresh is in flight: the row we
    // leased is gone, and the pair we are holding is no longer the truth.
    const { state, handler } = tokenEndpoint({
      onHit: async () => {
        await store.putOAuthTokens(SELF_ID, {
          accessToken: "access-relogin",
          refreshToken: "refresh-relogin",
          expiresAt: Date.now() + 60 * 60 * 1000,
          scope: GRANTED_SCOPE,
          userId: "42",
        });
      },
    });

    const token = await withEndpoint(handler, () => getUserAccessToken(store, CONFIG, FAST));

    expect(state.hits).toBe(1);
    expect(token).toBe("access-relogin");
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access-relogin",
      refreshToken: "refresh-relogin",
      state: "ready",
      leaseId: null,
    });
  });
});

describe("exchangeCode", () => {
  async function exchangeFailure(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): Promise<OAuthCodeExchangeError> {
    try {
      await withEndpoint(handler, () =>
        exchangeCodeForTokens(CONFIG, "code", "verifier", "https://example.test/auth/callback"),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthCodeExchangeError);
      return error as OAuthCodeExchangeError;
    }
    throw new Error("expected code exchange to fail");
  }

  it("distinguishes a conclusive code refusal from ambiguous provider outcomes", async () => {
    const refused = await exchangeFailure(() =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    expect(refused.outcome).toBe("refused");

    for (const status of [408, 429, 500]) {
      const ambiguous = await exchangeFailure(() =>
        Response.json({ error: "temporarily_unavailable" }, { status }),
      );
      expect(ambiguous.outcome).toBe("ambiguous");
    }

    const transport = await exchangeFailure(() => {
      throw new TypeError("socket closed");
    });
    expect(transport.outcome).toBe("ambiguous");
  });

  it("can exchange a reauthorization code without replacing the observed grant", async () => {
    const store = await newStore();
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 60_000,
      scope: GRANTED_SCOPE,
      userId: "42",
    });

    let exchangeSignal: AbortSignal | null | undefined;
    const next = await withEndpoint(
      async (_url, init) => {
        exchangeSignal = init?.signal;
        return Response.json({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 7200,
          scope: GRANTED_SCOPE,
        });
      },
      () =>
        exchangeCodeForTokens(CONFIG, "code", "verifier", "https://example.test/auth/callback"),
    );

    expect(next).toMatchObject({ accessToken: "access-new", refreshToken: "refresh-new" });
    expect(exchangeSignal).toBeInstanceOf(AbortSignal);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      userId: "42",
    });
  });

  it("revives a broken grant", async () => {
    const store: Storage = await storeWithExpiredToken();
    await store.markTokenBroken(SELF_ID, "refresh-0", "invalid_grant");

    await withEndpoint(
      async () =>
        Response.json({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 7200,
          scope: GRANTED_SCOPE,
        }),
      () => exchangeCode(store, CONFIG, "code", "verifier", "https://example.test/auth/callback"),
    );

    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      state: "ready",
      recoveryUsed: false,
      brokenReason: null,
    });
    expect(await getUserAccessToken(store, CONFIG, FAST)).toBe("access-new");
  });
});

describe("revokeOAuthGrant", () => {
  it("uses X's confidential-client revocation request without deleting anything locally", async () => {
    const observed: { url: string; init?: RequestInit }[] = [];
    await withEndpoint(
      async (url, init) => {
        observed.push({ url, init });
        return Response.json({ revoked: true });
      },
      () => revokeOAuthGrant(CONFIG, "refresh-to-revoke"),
    );

    expect(observed[0]?.url).toBe("https://api.x.com/2/oauth2/revoke");
    expect(observed[0]?.init?.method).toBe("POST");
    expect(new Headers(observed[0]?.init?.headers).get("authorization")).toBe(
      `Basic ${btoa("client-id:client-secret")}`,
    );
    expect(new URLSearchParams(String(observed[0]?.init?.body)).toString()).toBe(
      "token=refresh-to-revoke",
    );
    expect(observed[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

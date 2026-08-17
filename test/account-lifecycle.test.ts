import { describe, expect, it } from "bun:test";
import { SELF_ID } from "../src/server/oauth";
import type { Storage } from "../src/server/storage";
import { USER_READ_USD } from "../src/shared/pricing";
import { makePost } from "./fixtures";
import {
  accountRequest,
  makeAuthedApp,
  makeTestApp,
  seedConversation,
  TEST_OAUTH,
  withAccountGeneration,
} from "./harness";
import { withMockFetch } from "./setup";

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REVOKE_URL = "https://api.x.com/2/oauth2/revoke";

function callbackRequestForGeneration(accountGeneration: string, code = "code"): Request {
  return new Request(`http://localhost/auth/callback?code=${code}&state=state`, {
    headers: { Cookie: `x_pkce=verifier.state.${accountGeneration}` },
  });
}

async function callbackRequest(store: Storage, code = "code"): Promise<Request> {
  const accountGeneration = await store.getOrCreateAccountGeneration(
    SELF_ID,
    crypto.randomUUID(),
  );
  return callbackRequestForGeneration(accountGeneration, code);
}

function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "access-new",
    refresh_token: "refresh-new",
    expires_in: 7200,
    scope: "tweet.read users.read bookmark.read offline.access",
    ...overrides,
  };
}

async function withOAuthEndpoints<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  body: () => T | Promise<T>,
): Promise<T> {
  const restore = withMockFetch(handler);
  try {
    return await body();
  } finally {
    restore();
  }
}

function notice(response: Response): URLSearchParams {
  return new URL(response.headers.get("location")!, "http://localhost").searchParams;
}

describe("OAuth account ownership", () => {
  it("rejects stale Connect or Reconnect intent before leaving for X", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const generationA = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access-b",
      refreshToken: "refresh-b",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account-b",
    });

    const response = await app.request(
      `/auth/login?accountGeneration=${encodeURIComponent(generationA)}`,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?authNotice=account-state-changed");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(xapi.calls).toEqual([]);
  });

  it("rejects a stale OAuth callback before exchange or identity spend", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const generationA = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access-b",
      refreshToken: "refresh-b",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account-b",
    });
    let providerCalls = 0;

    const response = await withOAuthEndpoints(
      async () => {
        providerCalls += 1;
        return Response.json(tokenBody());
      },
      () => app.request(callbackRequestForGeneration(generationA)),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?authNotice=account-state-changed");
    expect(providerCalls).toBe(0);
    expect(xapi.calls).toEqual([]);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access-b",
      refreshToken: "refresh-b",
      userId: "account-b",
      state: "ready",
    });
  });

  it("does not let a fresh callback claim after no-grant Disconnect rotates generation", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    const generationA = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );
    const claimFresh = store.claimFreshOAuthInstall.bind(store);
    let claimReached!: () => void;
    let releaseClaim!: () => void;
    const reached = new Promise<void>((resolve) => {
      claimReached = resolve;
    });
    store.claimFreshOAuthInstall = async (...args) => {
      claimReached();
      await new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      return await claimFresh(...args);
    };
    let providerCalls = 0;

    const callback = withOAuthEndpoints(
      async () => {
        providerCalls += 1;
        return Response.json(tokenBody());
      },
      () => app.request(callbackRequestForGeneration(generationA)),
    );
    await reached;
    const disconnected = await app.request(
      "/api/auth/disconnect",
      withAccountGeneration(generationA, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookmarkDisposition: "remove" }),
      }),
    );
    expect(disconnected.status).toBe(200);
    const disconnectedBody = (await disconnected.json()) as {
      ok: boolean;
      accountGeneration: string;
    };
    expect(disconnectedBody.accountGeneration).not.toBe(generationA);

    releaseClaim();
    const callbackResponse = await callback;
    expect(notice(callbackResponse).get("authNotice")).toBe("reauthorization-conflict");
    expect(providerCalls).toBe(0);
    expect(xapi.calls).toEqual([]);
    expect(await store.getOAuthTokens(SELF_ID)).toBeNull();
  });

  it("never leaves the old grant authorized when the replacement exchange is ambiguous", async () => {
    const { app, store } = await makeAuthedApp();

    const response = await withOAuthEndpoints(
      async (url) => {
        expect(url).toBe(TOKEN_URL);
        throw new TypeError("connection closed after request bytes were sent");
      },
      async () => app.request(await callbackRequest(store)),
    );

    expect(response.status).toBe(401);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      refreshToken: "refresh",
      state: "reauthorizing",
    });
    expect(await store.isOAuthGrantCurrent(SELF_ID, "refresh")).toBe(false);

    const status = await app.request("/api/auth/status");
    expect(await status.json()).toMatchObject({
      state: "broken",
      reason: expect.stringContaining("reauthorization"),
    });
  });

  it("restores the old grant only when X conclusively refuses the replacement code", async () => {
    const { app, store } = await makeAuthedApp();

    const response = await withOAuthEndpoints(
      async (url) => {
        expect(url).toBe(TOKEN_URL);
        return Response.json(
          { error: "invalid_grant", error_description: "code was already used" },
          { status: 400 },
        );
      },
      async () => app.request(await callbackRequest(store)),
    );

    expect(response.status).toBe(401);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      refreshToken: "refresh",
      state: "ready",
      brokenReason: null,
    });
    expect(await store.isOAuthGrantCurrent(SELF_ID, "refresh")).toBe(true);
  });

  it("recovers a pending outcome only through a successful same-account callback", async () => {
    const { app, store, xapi } = await makeAuthedApp();

    await withOAuthEndpoints(
      async () => {
        throw new TypeError("first exchange response was lost");
      },
      async () => app.request(await callbackRequest(store, "ambiguous")),
    );
    expect((await store.getOAuthTokens(SELF_ID))?.state).toBe("reauthorizing");

    await withOAuthEndpoints(
      async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      async () => app.request(await callbackRequest(store, "refused-recovery")),
    );
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "reauthorizing",
      refreshToken: "refresh",
    });

    xapi.onGetMe = () => ({ id: "100", username: "same", name: "Same Account" });
    const recovered = await withOAuthEndpoints(
      async () => Response.json(tokenBody()),
      async () => app.request(await callbackRequest(store, "successful-recovery")),
    );

    expect(notice(recovered).get("authNotice")).toBe("reauthorized");
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "ready",
      accessToken: "access-new",
      refreshToken: "refresh-new",
      userId: "100",
    });
  });

  it("keeps the old pair pending when an issued replacement cannot be identified", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    xapi.onGetMe = () => {
      throw new Error("identity response was unavailable");
    };

    const response = await withOAuthEndpoints(
      async (url) =>
        url === TOKEN_URL ? Response.json(tokenBody()) : Response.json({ revoked: true }),
      async () => app.request(await callbackRequest(store)),
    );

    expect(response.status).toBe(500);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      refreshToken: "refresh",
      state: "reauthorizing",
    });
    expect(await store.isOAuthGrantCurrent(SELF_ID, "refresh")).toBe(false);
  });

  it("keeps the old pair pending when same-account promotion throws", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    xapi.onGetMe = () => ({ id: "100", username: "same", name: "Same Account" });
    store.replaceOAuthTokensIfCurrent = async () => {
      throw new Error("D1 promotion failed");
    };

    const response = await withOAuthEndpoints(
      async (url) =>
        url === TOKEN_URL ? Response.json(tokenBody()) : Response.json({ revoked: true }),
      async () => app.request(await callbackRequest(store)),
    );

    expect(response.status).toBe(500);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      refreshToken: "refresh",
      state: "reauthorizing",
    });
    expect(await store.isOAuthGrantCurrent(SELF_ID, "refresh")).toBe(false);
  });

  it("does not revoke a replacement when promotion committed before its response failed", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    xapi.onGetMe = () => ({ id: "100", username: "same", name: "Same Account" });
    const promote = store.replaceOAuthTokensIfCurrent.bind(store);
    store.replaceOAuthTokensIfCurrent = async (id, observed, tokens, callbackLeaseId) => {
      expect(await promote(id, observed, tokens, callbackLeaseId)).toBe(true);
      throw new Error("D1 response was lost after commit");
    };

    const response = await withOAuthEndpoints(
      async (url) => {
        expect(url).toBe(TOKEN_URL);
        return Response.json(tokenBody());
      },
      async () => app.request(await callbackRequest(store)),
    );

    expect(notice(response).get("authNotice")).toBe("reauthorized");
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      state: "ready",
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
  });

  it("reauthorizes the same account without disturbing its folder or queue", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const accountGeneration = await store.getOrCreateAccountGeneration(
      SELF_ID,
      "generation-unused",
    );
    await store.setBookmarkFolder("folder-a", "Reading");
    await store.addSavedItems([
      { postId: "bookmark", source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    xapi.onGetMe = (token) => {
      expect(token).toBe("access-new");
      return { id: "100", username: "same", name: "Same Account" };
    };

    const response = await withOAuthEndpoints(
      async (url) => {
        expect(url).toBe(TOKEN_URL);
        return Response.json(tokenBody());
      },
      async () => app.request(await callbackRequest(store)),
    );

    expect(response.status).toBe(302);
    expect(Object.fromEntries(notice(response))).toEqual({
      authNotice: "reauthorized",
      authCostPosts: "1",
      authCostBillable: "1",
      authCostUsd: String(USER_READ_USD),
    });
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      userId: "100",
      username: "same",
    });
    expect(await store.getBookmarkFolder()).toEqual({ id: "folder-a", name: "Reading" });
    expect((await store.listSavedItems()).map((item) => item.postId)).toEqual(["bookmark"]);
    expect(await store.getOrCreateAccountGeneration(SELF_ID, "generation-loser")).toBe(
      accountGeneration,
    );
  });

  it("rejects a different account, revokes only its new grant, and preserves the old one", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    await store.setBookmarkFolder("folder-a", "Reading");
    xapi.onGetMe = () => ({ id: "200", username: "other", name: "Other Account" });
    const revoked: string[] = [];

    const response = await withOAuthEndpoints(
      async (url, init) => {
        if (url === TOKEN_URL) return Response.json(tokenBody());
        expect(url).toBe(REVOKE_URL);
        revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
        return Response.json({ revoked: true });
      },
      async () => app.request(await callbackRequest(store)),
    );

    expect(response.status).toBe(302);
    expect(notice(response).get("authNotice")).toBe("different-account");
    expect(notice(response).get("authCostPosts")).toBe("1");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(revoked).toEqual(["refresh-new"]);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      userId: "100",
    });
    expect(await store.getBookmarkFolder()).toEqual({ id: "folder-a", name: "Reading" });
  });

  it("reports rejected-grant revoke failure without ever persisting that account", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    xapi.onGetMe = () => ({ id: "200", username: "other", name: "Other Account" });

    const response = await withOAuthEndpoints(
      async (url) =>
        url === TOKEN_URL
          ? Response.json(tokenBody())
          : Response.json({ error: "server_error" }, { status: 500 }),
      async () => app.request(await callbackRequest(store)),
    );

    expect(notice(response).get("authNotice")).toBe("different-account-revoke-failed");
    expect(notice(response).get("authCostBillable")).toBe("1");
    expect((await store.getOAuthTokens(SELF_ID))?.refreshToken).toBe("refresh");
  });

  it("fences a non-owner rotation while a same-account callback owns promotion", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    await store.setBookmarkFolder("folder-a", "Reading");
    xapi.onGetMe = async () => {
      expect(
        await store.replaceOAuthTokensIfCurrent(SELF_ID, "refresh", {
          accessToken: "access-racing",
          refreshToken: "refresh-racing",
          expiresAt: Date.now() + 60 * 60 * 1000,
          scope: "tweet.read users.read bookmark.read",
          userId: "100",
          username: "same",
          displayName: "Same Account",
        }),
      ).toBe(false);
      return { id: "100", username: "same", name: "Same Account" };
    };

    const response = await withOAuthEndpoints(
      async (url) =>
        url === TOKEN_URL ? Response.json(tokenBody()) : Response.json({ revoked: true }),
      async () => app.request(await callbackRequest(store)),
    );

    expect(notice(response).get("authNotice")).toBe("reauthorized");
    expect((await store.getOAuthTokens(SELF_ID))?.refreshToken).toBe("refresh-new");
    expect(await store.getBookmarkFolder()).toEqual({ id: "folder-a", name: "Reading" });
  });

  it("single-flights concurrent reauthorization callbacks before either exchanges", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    xapi.onGetMe = () => ({ id: "100", username: "same", name: "Same Account" });
    let tokenHits = 0;
    let releaseExchange!: () => void;
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    const restore = withMockFetch(async (url) => {
      expect(url).toBe(TOKEN_URL);
      tokenHits += 1;
      exchangeStarted();
      await new Promise<void>((resolve) => {
        releaseExchange = resolve;
      });
      return Response.json(tokenBody());
    });
    try {
      const first = app.request(await callbackRequest(store, "code-a"));
      await started;
      const second = await app.request(await callbackRequest(store, "code-b"));
      expect(notice(second).get("authNotice")).toBe("reauthorization-conflict");
      expect(tokenHits).toBe(1);
      releaseExchange();
      expect(notice(await first).get("authNotice")).toBe("reauthorized");
      expect((await store.getOAuthTokens(SELF_ID))?.refreshToken).toBe("refresh-new");
    } finally {
      restore();
    }
  });

  it("detaches legacy orphan bookmarks when the first fresh grant is installed", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    const priorGeneration = await store.getOrCreateAccountGeneration(
      SELF_ID,
      "generation-before-connect",
    );
    await store.setBookmarkFolder("orphan-folder", "Old account");
    await store.addSavedItems([
      { postId: "orphan", source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);

    const response = await withOAuthEndpoints(
      async () => Response.json(tokenBody()),
      async () => app.request(await callbackRequest(store)),
    );

    expect(response.headers.get("location")).toBe("/");
    expect(xapi.calls).toEqual([]);
    expect(await store.getBookmarkFolder()).toEqual({ id: null, name: null });
    expect(await store.listSavedItems()).toEqual([
      { postId: "orphan", source: "manual", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      refreshToken: "refresh-new",
      userId: null,
    });
    expect(await store.getOrCreateAccountGeneration(SELF_ID, "generation-loser")).not.toBe(
      priorGeneration,
    );
  });

  it("single-flights two first-ever callbacks before either exchanges a code", async () => {
    const { app, store } = await makeTestApp({ oauth: TEST_OAUTH });
    let tokenHits = 0;
    let releaseExchange!: () => void;
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    const restore = withMockFetch(async (url) => {
      expect(url).toBe(TOKEN_URL);
      tokenHits += 1;
      exchangeStarted();
      await new Promise<void>((resolve) => {
        releaseExchange = resolve;
      });
      return Response.json(tokenBody());
    });
    try {
      const first = app.request(await callbackRequest(store, "code-a"));
      await started;
      const second = await app.request(await callbackRequest(store, "code-b"));
      expect(notice(second).get("authNotice")).toBe("reauthorization-conflict");
      expect(tokenHits).toBe(1);
      releaseExchange();
      expect((await first).headers.get("location")).toBe("/");
      expect((await store.getOAuthTokens(SELF_ID))?.refreshToken).toBe("refresh-new");
    } finally {
      restore();
    }
  });

  it("refuses disconnect while a first callback owns grant installation", async () => {
    const { app, store } = await makeTestApp({ oauth: TEST_OAUTH });
    let releaseExchange!: () => void;
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    const restore = withMockFetch(async (url) => {
      expect(url).toBe(TOKEN_URL);
      exchangeStarted();
      await new Promise<void>((resolve) => {
        releaseExchange = resolve;
      });
      return Response.json(tokenBody());
    });
    try {
      const callback = app.request(await callbackRequest(store, "code-a"));
      await started;
      const disconnect = await accountRequest(app, store, "/api/auth/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookmarkDisposition: "remove" }),
      });
      expect(disconnect.status).toBe(409);

      releaseExchange();
      expect((await callback).headers.get("location")).toBe("/");
      expect((await store.getOAuthTokens(SELF_ID))?.refreshToken).toBe("refresh-new");
    } finally {
      restore();
    }
  });
});

describe("POST /api/auth/disconnect", () => {
  it("fences a profile resolution whose grant snapshot predates disconnect", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
    });
    const accountGeneration = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );
    xapi.onGetMe = () => ({ id: "100", username: "late", name: "Late Profile" });
    xapi.onGetBookmarkFolders = () => [];

    const getStatus = store.getOAuthStatusForGeneration.bind(store);
    let releaseSnapshot!: () => void;
    let snapshotRead!: () => void;
    let pauseFirstRead = true;
    const read = new Promise<void>((resolve) => {
      snapshotRead = resolve;
    });
    store.getOAuthStatusForGeneration = async (id, expectedGeneration) => {
      const row = await getStatus(id, expectedGeneration);
      if (pauseFirstRead) {
        pauseFirstRead = false;
        snapshotRead();
        await new Promise<void>((resolve) => {
          releaseSnapshot = resolve;
        });
      }
      return row;
    };

    let releaseRevoke!: () => void;
    let revokeStarted!: () => void;
    const revoking = new Promise<void>((resolve) => {
      revokeStarted = resolve;
    });
    const restore = withMockFetch(async (url) => {
      expect(url).toBe(REVOKE_URL);
      revokeStarted();
      await new Promise<void>((resolve) => {
        releaseRevoke = resolve;
      });
      return Response.json({ revoked: true });
    });
    try {
      const folders = app.request(
        "/api/bookmarks/folders",
        withAccountGeneration(accountGeneration),
      );
      await read;
      const disconnect = app.request(
        "/api/auth/disconnect",
        withAccountGeneration(accountGeneration, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bookmarkDisposition: "remove" }),
        }),
      );
      await revoking;
      releaseSnapshot();

      expect((await folders).status).toBe(409);
      expect(xapi.count("getMe")).toBe(0);
      expect(xapi.count("getBookmarkFolders")).toBe(0);

      releaseRevoke();
      expect((await disconnect).status).toBe(200);
    } finally {
      restore();
    }
  });

  it("reports disconnecting rather than authorized while provider revocation is in flight", async () => {
    const { app, store } = await makeAuthedApp();
    const accountGeneration = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );
    let finishRevoke!: () => void;
    let revokeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      revokeStarted = resolve;
    });
    const restore = withMockFetch(async () => {
      revokeStarted();
      await new Promise<void>((resolve) => {
        finishRevoke = resolve;
      });
      return Response.json({ revoked: true });
    });
    try {
      const disconnect = app.request(
        "/api/auth/disconnect",
        withAccountGeneration(accountGeneration, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bookmarkDisposition: "remove" }),
        }),
      );
      await started;
      const status = await app.request("/api/auth/status");
      expect(await status.json()).toMatchObject({ state: "disconnecting" });
      finishRevoke();
      expect((await disconnect).status).toBe(200);
    } finally {
      restore();
    }
  });

  it("does not let a concurrent folder clear override the disconnect disposition", async () => {
    const { app, store } = await makeAuthedApp();
    const accountGeneration = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );
    await store.setBookmarkFolder("folder-a", "Reading");
    await store.addSavedItems([
      { postId: "bookmark", source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    let finishRevoke!: () => void;
    let revokeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      revokeStarted = resolve;
    });
    const restore = withMockFetch(async () => {
      revokeStarted();
      await new Promise<void>((resolve) => {
        finishRevoke = resolve;
      });
      return Response.json({ revoked: true });
    });
    try {
      const disconnect = app.request(
        "/api/auth/disconnect",
        withAccountGeneration(accountGeneration, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bookmarkDisposition: "remove" }),
        }),
      );
      await started;

      const clear = await app.request(
        "/api/settings",
        withAccountGeneration(accountGeneration, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bookmarkFolderId: null, bookmarkDisposition: "keep" }),
        }),
      );
      expect(clear.status).toBe(409);
      expect(await store.listSavedItems()).toEqual([
        { postId: "bookmark", source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
      ]);

      finishRevoke();
      expect((await disconnect).status).toBe(200);
      expect(await store.listSavedItems()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("revokes first, then terminally disconnects while keeping imports as local saves", async () => {
    const { app, store } = await makeAuthedApp();
    const connectedGeneration = await store.getOrCreateAccountGeneration(
      SELF_ID,
      "generation-unused",
    );
    const root = makePost();
    await seedConversation(store, root);
    await store.markConversationRead(root.id);
    await store.setBookmarkFolder("folder-a", "Reading");
    await store.addSavedItems([
      { postId: root.id, source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    let revoked = false;

    const response = await withOAuthEndpoints(
      async (url) => {
        expect(url).toBe(REVOKE_URL);
        revoked = true;
        return Response.json({ revoked: true });
      },
      () =>
        app.request(
          "/api/auth/disconnect",
          withAccountGeneration(connectedGeneration, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bookmarkDisposition: "keep" }),
          }),
        ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; accountGeneration: string };
    expect(body.ok).toBe(true);
    expect(body.accountGeneration).toBeString();
    expect(body.accountGeneration).not.toBe(connectedGeneration);
    expect(await store.getOrCreateAccountGeneration(SELF_ID, "generation-loser")).toBe(
      body.accountGeneration,
    );
    expect(revoked).toBe(true);
    expect(await store.getOAuthTokens(SELF_ID)).toBeNull();
    expect(await store.getBookmarkFolder()).toEqual({ id: null, name: null });
    expect(await store.listSavedItems()).toEqual([
      { postId: root.id, source: "manual", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    expect(await store.getPost(root.id)).not.toBeNull();
    expect(await store.hasConversation(root.id)).toBe(true);
    expect(await store.getUnreadIds(root.id)).toEqual([]);
  });

  it("keeps the local grant and account data intact when X does not confirm revocation", async () => {
    const { app, store } = await makeAuthedApp();
    const accountGeneration = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );
    await store.setBookmarkFolder("folder-a", "Reading");
    await store.addSavedItems([
      { postId: "bookmark", source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);

    const response = await withOAuthEndpoints(
      async () => Response.json({ error: "server_error" }, { status: 500 }),
      () =>
        app.request(
          "/api/auth/disconnect",
          withAccountGeneration(accountGeneration, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bookmarkDisposition: "remove" }),
          }),
        ),
    );

    expect(response.status).toBe(502);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      refreshToken: "refresh",
      state: "ready",
    });
    expect(await store.getBookmarkFolder()).toEqual({ id: "folder-a", name: "Reading" });
    expect((await store.listSavedItems()).map((item) => item.postId)).toEqual(["bookmark"]);
  });

  it("fences a timeline page that returns after disconnect and makes no later X call", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const accountGeneration = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );
    const late = makePost({ authorId: "100" });
    let releasePage!: () => void;
    const pageStarted = new Promise<void>((resolveStarted) => {
      xapi.onGetOwnPosts = async () => {
        resolveStarted();
        await new Promise<void>((resolve) => {
          releasePage = resolve;
        });
        return { posts: [late], nextToken: "more" };
      };
    });

    const scan = app.request(
      "/api/me/posts?threads=2",
      withAccountGeneration(accountGeneration),
    );
    await pageStarted;
    const disconnected = await withOAuthEndpoints(
      async () => Response.json({ revoked: true }),
      () =>
        app.request(
          "/api/auth/disconnect",
          withAccountGeneration(accountGeneration, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bookmarkDisposition: "remove" }),
          }),
        ),
    );
    expect(disconnected.status).toBe(200);
    releasePage();

    const response = await scan;
    expect(response.status).toBe(409);
    expect(xapi.count("getOwnPosts")).toBe(1);
    expect(await store.getPost(late.id)).toBeNull();
  });
});

describe("account generation admission", () => {
  it("rejects every stale account-bound route before spend or mutation", async () => {
    const { app, store, xapi } = await makeTestApp({ oauth: TEST_OAUTH });
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account-a",
    });
    const generationA = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );

    // A different account becomes current after this tab captured A's
    // generation. Its account-bound state must not be reachable by A's UI.
    await store.putOAuthTokens(SELF_ID, {
      accessToken: "access-b",
      refreshToken: "refresh-b",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "tweet.read users.read bookmark.read",
      userId: "account-b",
    });
    const generationB = await store.getOrCreateAccountGeneration(
      SELF_ID,
      crypto.randomUUID(),
    );
    expect(generationB).not.toBe(generationA);
    const saved = makePost({ id: "saved-by-b", createdAt: "2024-01-01T00:00:00.000Z" });
    await store.upsertPosts([saved]);
    await store.addSavedItems([
      { postId: saved.id, source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    await store.setBookmarkFolder("folder-b", "B's folder");

    const json = { "content-type": "application/json" };
    const staleRequests: Array<[string, string, RequestInit]> = [
      ["settings read", "/api/settings", {}],
      [
        "folder clear",
        "/api/settings",
        {
          method: "PATCH",
          headers: json,
          body: JSON.stringify({ bookmarkFolderId: null, bookmarkDisposition: "remove" }),
        },
      ],
      ["folder list", "/api/bookmarks/folders", {}],
      ["bookmark sync", "/api/bookmarks/sync", { method: "POST" }],
      [
        "folder switch",
        "/api/bookmarks/switch",
        {
          method: "POST",
          headers: json,
          body: JSON.stringify({ bookmarkFolderId: "folder-c", bookmarkFolderName: "C" }),
        },
      ],
      ["own posts", "/api/me/posts?threads=2", {}],
      [
        "disconnect",
        "/api/auth/disconnect",
        {
          method: "POST",
          headers: json,
          body: JSON.stringify({ bookmarkDisposition: "remove" }),
        },
      ],
    ];

    const statuses: Array<[string, number]> = [];
    for (const [label, path, init] of staleRequests) {
      const response = await app.request(path, withAccountGeneration(generationA, init));
      statuses.push([label, response.status]);
      expect(await response.json()).toMatchObject({
        error: expect.stringMatching(/account changed|retry/i),
      });
    }
    expect(statuses).toEqual(staleRequests.map(([label]) => [label, 409]));
    expect(xapi.calls).toEqual([]);
    expect(await store.getOAuthTokens(SELF_ID)).toMatchObject({
      accessToken: "access-b",
      refreshToken: "refresh-b",
      userId: "account-b",
      state: "ready",
    });
    expect(await store.getBookmarkFolder()).toEqual({ id: "folder-b", name: "B's folder" });
    expect(await store.listSavedItems()).toEqual([
      { postId: saved.id, source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
  });
});

describe("bookmark source lifecycle", () => {
  it("stages a complete target scan before atomically switching folders", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const old = makePost({ id: "old", createdAt: "2024-01-01T00:00:00.000Z" });
    const next = makePost({ id: "next", createdAt: "2024-01-02T00:00:00.000Z" });
    await store.upsertPosts([old]);
    await store.addSavedItems([
      { postId: old.id, source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    await store.setBookmarkFolder("folder-a", "A");
    xapi.onGetBookmarksByFolder = () => ({
      posts: [next],
      ids: [next.id],
      missing: [],
      complete: true,
    });

    const response = await accountRequest(app, store, "/api/bookmarks/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkFolderId: "folder-b", bookmarkFolderName: "B" }),
    });

    expect(response.status).toBe(200);
    expect(await store.getBookmarkFolder()).toEqual({ id: "folder-b", name: "B" });
    expect((await store.listSavedItems()).map((item) => item.postId)).toEqual([next.id]);
  });

  it("leaves the active folder and rows untouched when the target scan is partial", async () => {
    const { app, store, xapi } = await makeAuthedApp();
    const old = makePost({ id: "old", createdAt: "2024-01-01T00:00:00.000Z" });
    const partial = makePost({ id: "partial", createdAt: "2024-01-02T00:00:00.000Z" });
    await store.upsertPosts([old]);
    await store.addSavedItems([
      { postId: old.id, source: "bookmark", addedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    await store.setBookmarkFolder("folder-a", "A");
    xapi.onGetBookmarksByFolder = () => ({
      posts: [partial],
      ids: [partial.id],
      missing: [],
      complete: false,
    });

    const response = await accountRequest(app, store, "/api/bookmarks/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkFolderId: "folder-b", bookmarkFolderName: "B" }),
    });

    expect(response.status).toBe(409);
    expect(await store.getBookmarkFolder()).toEqual({ id: "folder-a", name: "A" });
    expect((await store.listSavedItems()).map((item) => item.postId)).toEqual([old.id]);
    expect(await store.getPost(partial.id)).toBeNull();
  });

  it("requires an explicit disposition when selecting no folder", async () => {
    const { app, store } = await makeAuthedApp();
    await store.setBookmarkFolder("folder-a", "A");

    const rejected = await accountRequest(app, store, "/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkFolderId: null }),
    });
    expect(rejected.status).toBe(400);
    expect(await store.getBookmarkFolder()).toEqual({ id: "folder-a", name: "A" });

    const cleared = await accountRequest(app, store, "/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkFolderId: null, bookmarkDisposition: "keep" }),
    });
    expect(cleared.status).toBe(200);
    expect(await store.getBookmarkFolder()).toEqual({ id: null, name: null });
  });
});

import type { OAuthTokens, Storage } from "./storage";

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
/**
 * Scopes we ask for during interactive consent. Tokens generated in the
 * developer portal come with a fixed set that excludes bookmark.read, so the
 * bookmark-folder inbox requires going through this flow.
 */
export const SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];
/** Refresh this long before actual expiry so in-flight requests don't race it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Row id for the single-user deployment. */
const SELF = "self";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Seeds the token store on first use (from the developer portal's
   * "generate access and refresh token for your own account"). */
  seedAccessToken?: string;
  seedRefreshToken?: string;
}

export class OAuthError extends Error {}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** PKCE pair: the verifier is kept by us, the challenge goes to X. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

export function authorizeUrl(
  config: OAuthConfig,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export function newState(): string {
  return randomToken();
}

/** Exchange the authorization code for tokens and persist them. */
export async function exchangeCode(
  store: Storage,
  config: OAuthConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config.clientId, config.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: config.clientId,
    }),
  });
  const body = (await response.json()) as TokenResponse;
  if (!response.ok || !body.access_token || !body.refresh_token) {
    throw new OAuthError(
      `code exchange failed (${response.status}): ${body.error_description ?? body.error ?? "unknown error"}`,
    );
  }
  const tokens: OAuthTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope ?? SCOPES.join(" "),
  };
  await store.putOAuthTokens(SELF, tokens);
  return tokens;
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Row id for the single-user deployment (exported for callers that reset it). */
export const SELF_ID = SELF;

/**
 * Exchange a refresh token for a new access token. X rotates refresh tokens:
 * the response carries a new one and the old is immediately dead, so the
 * caller must persist the result before using it.
 */
async function refresh(config: OAuthConfig, refreshToken: string): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config.clientId, config.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    }),
  });
  const body = (await response.json()) as TokenResponse;
  if (!response.ok || !body.access_token) {
    throw new OAuthError(
      `token refresh failed (${response.status}): ${body.error_description ?? body.error ?? "unknown error"}`,
    );
  }
  return {
    accessToken: body.access_token,
    // A rotated refresh token should always come back; keep the old one if not.
    refreshToken: body.refresh_token ?? refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope ?? "",
  };
}

/**
 * A valid user-context access token, refreshing when it's close to expiry.
 * Returns null when the deployment has no user tokens configured — callers
 * fall back to app-only auth or report the feature as unavailable.
 */
export async function getUserAccessToken(
  store: Storage,
  config: OAuthConfig | null,
): Promise<string | null> {
  if (!config) return null;

  let tokens = await store.getOAuthTokens(SELF);

  if (!tokens) {
    if (!config.seedAccessToken || !config.seedRefreshToken) return null;
    // Treat the seed as already expired: the very first call refreshes it,
    // which both validates the pair and starts rotation in the database.
    tokens = {
      accessToken: config.seedAccessToken,
      refreshToken: config.seedRefreshToken,
      expiresAt: 0,
      scope: "",
    };
  }

  if (Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS) {
    return tokens.accessToken;
  }

  const refreshed = await refresh(config, tokens.refreshToken);
  await store.putOAuthTokens(SELF, refreshed);
  return refreshed.accessToken;
}

/** Scopes granted to the stored token, for feature gating and diagnostics. */
export async function getGrantedScopes(store: Storage): Promise<string[]> {
  const tokens = await store.getOAuthTokens(SELF);
  return tokens?.scope ? tokens.scope.split(" ") : [];
}

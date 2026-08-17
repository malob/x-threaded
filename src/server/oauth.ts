import * as v from "valibot";
import type { OAuthTokens, Storage, StoredTokens } from "./storage";
import { TokenResponseSchema, type TokenResponse } from "./x-wire";

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REVOKE_URL = "https://api.x.com/2/oauth2/revoke";
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
/** Callback/disconnect network work must finish well inside its two-minute lease. */
const OAUTH_MUTATION_TIMEOUT_MS = 60_000;
/**
 * Scopes we ask for during interactive consent. Tokens generated in the
 * developer portal come with a fixed set that excludes bookmark.read, so the
 * bookmark-folder inbox requires going through this flow — this is the one
 * copy of that rule; everywhere else points here or at
 * docs/x-api-notes.md N13.
 */
export const SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];
/** Refresh this long before actual expiry so in-flight requests don't race it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * The clocks the lease protocol runs on. Tunable so tests can wait a lease out
 * in milliseconds rather than half a minute; production uses the defaults.
 */
export interface TokenTimings {
  /**
   * Hard cap on the refresh call, deliberately shorter than the lease: a
   * request still in flight when its lease lapses is exactly the ambiguity the
   * recovery rule has to reason about, so we make sure it cannot happen for a
   * merely slow response (dialogue r2, answer 1).
   */
  fetchTimeoutMs: number;
  /** How long a claimed refresh stays the claimant's to finish. */
  leaseMs: number;
  /** Extra slack past a lapsed lease before anyone considers recovering it. */
  graceMs: number;
  /** How often an owned rotated pair retries a transient finalize write. */
  pollMs: number;
}

export const DEFAULT_TIMINGS: TokenTimings = {
  fetchTimeoutMs: 20_000,
  leaseMs: 30_000,
  graceMs: 5_000,
  pollMs: 50,
};
/**
 * Row id for the single-user deployment: every stored grant, and every route
 * that reads one, keys off this one constant rather than a loose "self".
 */
export const SELF_ID = "self";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * One coherently observed grant: the access token a request may use, the
 * refresh token that owns any cached profile beside it, and that profile.
 * Keeping these together prevents a fresh login between two reads from
 * pairing one account's access token with another account's identity row.
 */
export interface UserGrantSnapshot {
  accessToken: string;
  refreshToken: string;
  userId: string | null;
  username: string | null;
  displayName: string | null;
}

export class OAuthError extends Error {}

export type OAuthCodeExchangeOutcome = "refused" | "ambiguous";

/** Whether a failed code exchange proves X did not issue a replacement pair. */
export class OAuthCodeExchangeError extends OAuthError {
  constructor(
    message: string,
    readonly outcome: OAuthCodeExchangeOutcome,
  ) {
    super(message);
    this.name = "OAuthCodeExchangeError";
  }
}

/** X did not confirm that the requested remote grant was revoked. */
export class OAuthRevocationError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = "OAuthRevocationError";
  }
}

/** A durable grant transition is active; callers must not use or replace it. */
export class OAuthGrantConflictError extends Error {
  constructor(message = "X account disconnect is in progress; retry shortly") {
    super(message);
    this.name = "OAuthGrantConflictError";
  }
}

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

/** Exchange an authorization code without deciding which stored grant it may replace. */
export async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
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
      signal: AbortSignal.timeout(OAUTH_MUTATION_TIMEOUT_MS),
    });
  } catch {
    // The request may have reached X and consumed the one-shot code before
    // the response was lost. Callers must not restore an older same-client
    // pair from this outcome.
    throw new OAuthCodeExchangeError(
      "code exchange got no confirmed response; the prior grant may have been replaced",
      "ambiguous",
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    raw = null;
  }
  const body = tokenResponse(raw);
  if (!response.ok || !body.access_token || !body.refresh_token) {
    const hasIssuedPair = Boolean(body.access_token && body.refresh_token);
    const conclusivelyRefused =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 429 &&
      !hasIssuedPair;
    throw new OAuthCodeExchangeError(
      `code exchange failed (${response.status}): ${body.error_description ?? body.error ?? "unknown error"}`,
      conclusivelyRefused ? "refused" : "ambiguous",
    );
  }
  const tokens: OAuthTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: expiryOf(body),
    scope: body.scope ?? SCOPES.join(" "),
  };
  return tokens;
}

/** Exchange the authorization code and install it as a fresh grant. */
export async function exchangeCode(
  store: Storage,
  config: OAuthConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const tokens = await exchangeCodeForTokens(config, code, verifier, redirectUri);
  await store.putOAuthTokens(SELF_ID, tokens);
  return tokens;
}

/**
 * Revoke the long-lived user grant before deleting its local credentials.
 *
 * X's confidential-client form authenticates with HTTP Basic and takes only
 * the token being invalidated in the form body. Callers deliberately treat a
 * failed response as non-revocation and retain the local grant so the user can
 * retry instead of being told a remote credential disappeared when it may not
 * have.
 */
export async function revokeOAuthGrant(config: OAuthConfig, token: string): Promise<void> {
  const response = await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config.clientId, config.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(OAUTH_MUTATION_TIMEOUT_MS),
  });
  if (response.ok) return;

  let detail = "unknown error";
  try {
    const body = tokenResponse(await response.json());
    detail = body.error_description ?? body.error ?? detail;
  } catch {
    // A non-JSON error still means revocation was not confirmed.
  }
  throw new OAuthRevocationError(`grant revocation failed (${response.status}): ${detail}`);
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

/**
 * The token endpoint's body, or an empty one when it isn't the shape we know.
 *
 * A body we can't read is not an error of its own: it is simply an answer
 * carrying no token pair and no reason, which is what every caller here
 * already has to handle. Throwing instead would route a malformed response
 * around the refresh failure classification, and that classification is the
 * only thing that knows whether the single-use token we sent is still ours.
 */
function tokenResponse(body: unknown): TokenResponse {
  const parsed = v.safeParse(TokenResponseSchema, body);
  return parsed.success ? parsed.output : {};
}

/**
 * When the access token in this answer stops being usable. An answer that
 * omits `expires_in` counts as already expired: the next request renews it,
 * which beats both trusting a lifetime nobody stated and writing the NaN
 * that arithmetic on a missing field yields into the row.
 */
function expiryOf(body: TokenResponse): number {
  return Date.now() + (body.expires_in ?? 0) * 1000;
}

/**
 * What a failed refresh tells us about the token we presented — the only
 * question that matters, because the token was single-use and we need to know
 * whether X spent it.
 *
 * `grant_dead` — X rejected the grant itself; no retry can revive it.
 * `refused` — X answered without issuing a pair, so the token is still ours.
 * `unknown` — no usable answer came back. X may have rotated it and lost the
 *   reply on the way; nothing may presume either way.
 */
type RefreshFailure = "grant_dead" | "refused" | "unknown";

class RefreshError extends OAuthError {
  constructor(
    message: string,
    readonly failure: RefreshFailure,
    /** The short form, for `broken_reason` and the reconnect prompt. */
    readonly detail: string,
  ) {
    super(message);
  }
}

/**
 * Exchange a refresh token for a new access token. X rotates refresh tokens:
 * the response carries a new one and the old is immediately dead, so the
 * caller must persist the result before using it. The rotation contract and
 * everything it forces on this file is docs/x-api-notes.md N14.
 *
 * The hard timeout has no accompanying retry on purpose. Retrying a refresh is
 * re-presenting a token that may already have been spent, which is the one
 * thing the whole protocol exists to prevent.
 */
async function refresh(
  config: OAuthConfig,
  refreshToken: string,
  timeoutMs: number,
): Promise<OAuthTokens> {
  let response: Response;
  let body: TokenResponse;
  try {
    response = await fetch(TOKEN_URL, {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = tokenResponse(await response.json());
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new RefreshError(`token refresh got no answer: ${detail}`, "unknown", detail);
  }

  if (!response.ok) {
    const detail = [body.error ?? "unknown error", body.error_description]
      .filter((part) => part !== undefined)
      .join(" — ");
    // Only a definite endpoint rejection proves the token is unspent: a 4xx
    // (other than 429) means the token endpoint evaluated the request and
    // refused it before issuing anything. A 5xx or 429 can come from a
    // gateway AFTER the exchange was processed, so "we got an HTTP response"
    // is not proof of non-consumption — those stay ambiguous and the lease
    // stands for the recovery rule (Stage 3 adversarial review, finding 2).
    const refused =
      response.status >= 400 && response.status < 500 && response.status !== 429;
    throw new RefreshError(
      `token refresh failed (${response.status}): ${detail}`,
      body.error === "invalid_grant" ? "grant_dead" : refused ? "refused" : "unknown",
      detail,
    );
  }
  // A success is only a success when the whole rotated pair arrived. An
  // answer missing the new refresh token cannot be finalized — persisting
  // the old one as current would record a token X may have just killed as
  // the grant's future — so it stays unknown and the lease stands.
  if (!body.access_token || !body.refresh_token) {
    const detail = `HTTP ${response.status} without a full token pair`;
    throw new RefreshError(`token refresh returned nothing usable: ${detail}`, "unknown", detail);
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: expiryOf(body),
    // Empty when X omits it — the response describes the new token pair only,
    // so the caller carries the previously granted scope forward.
    scope: body.scope ?? "",
  };
}

/**
 * Refreshes currently in flight, keyed by the store they write to.
 *
 * The cheap first layer: callers sharing an isolate join one promise instead
 * of each taking a turn through the database. It is only ever an optimization
 * — the lease below is what actually decides who talks to X, and it is the
 * one that holds when the callers are in different isolates.
 */
const refreshesInFlight = new WeakMap<Storage, Promise<UserGrantSnapshot>>();

function grantSnapshot(tokens: OAuthTokens): UserGrantSnapshot {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    userId: tokens.userId ?? null,
    username: tokens.username ?? null,
    displayName: tokens.displayName ?? null,
  };
}

/** State transitions, for reading the protocol back out of the logs. */
function logTransition(from: string, to: string, detail: string): void {
  // Never a token, a lease id, or any part of one: this line exists to explain
  // a grant's history, and a log is not a place to leak credentials.
  console.log(`oauth: ${from} → ${to} — ${detail}`);
}

/** The error a caller sees once the grant is beyond saving. */
function brokenError(reason: string): OAuthError {
  return new OAuthError(`X session lost (${reason}) — reconnect at /auth/login`);
}

/** Whether this access token is far enough from expiry to just use. */
function isLive(tokens: OAuthTokens): boolean {
  return Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refresh under a held lease, then persist conditionally.
 *
 * Returns the newly persisted grant snapshot, or null when the lease turned
 * out to be lost — in which case this caller has written nothing and must
 * re-read, exactly as if it had never won.
 *
 * The refresh response covers the token pair alone: X never echoes the user ID
 * and omits `scope` when it hasn't changed, so both are carried forward from
 * the row we leased. Dropping them would erase the cached profile (costing a
 * billable `getMe()` to re-resolve) and the granted scopes that gate features.
 */
async function refreshUnderLease(
  store: Storage,
  config: OAuthConfig,
  row: StoredTokens,
  leaseId: string,
  timings: TokenTimings,
  isRecovery: boolean,
): Promise<UserGrantSnapshot | null> {
  let rotated: OAuthTokens;
  try {
    rotated = await refresh(config, row.refreshToken, timings.fetchTimeoutMs);
  } catch (error) {
    const failure = error instanceof RefreshError ? error.failure : "unknown";
    const detail = error instanceof RefreshError ? error.detail : String(error);

    // A recovery attempt is allowed exactly one outcome that isn't fatal:
    // a rotation. Anything else — including a merely inconclusive one — ends
    // as broken, because the alternative is presenting a possibly-spent token
    // a third time (dialogue r3, verdict 1).
    if (failure === "grant_dead" || isRecovery) {
      const reason = isRecovery && failure !== "grant_dead" ? `recovery failed: ${detail}` : detail;
      await store.markTokenBroken(SELF_ID, row.refreshToken, reason);
      logTransition("refreshing", "broken", reason);
      throw brokenError(reason);
    }
    if (failure === "refused") {
      // X answered and issued nothing, so the token we sent is still unspent:
      // hand the lease back rather than making the next caller wait it out.
      if (await store.releaseTokenLease(SELF_ID, leaseId, row.refreshToken)) {
        logTransition("refreshing", "ready", `lease released, token unspent: ${detail}`);
      }
      throw error;
    }
    // No usable answer. X may have rotated the token and lost the reply on the
    // way back, so the lease stays held until it lapses — the recovery rule,
    // not this caller, decides what happens next.
    logTransition("refreshing", "refreshing", `lease left standing, outcome unknown: ${detail}`);
    throw error;
  }

  // The rotated pair exists only in this memory until the finalize lands, and
  // the old token is already dead at X — so a transient database error here
  // must not discard it (the lease would lapse and recovery would re-present
  // the spent token, bricking the grant we were holding the replacement for).
  // Retry the conditional write itself, never the exchange: the CAS makes a
  // repeat attempt safe, and X is never contacted again.
  // Keep trying for as long as the lease is plausibly still ours: giving up
  // any earlier converts a database blip shorter than the lease into a
  // spent-token recovery and a forced re-login. Past the window the CAS
  // would lose anyway, so the deadline is the protocol's own.
  const next: OAuthTokens = {
    ...rotated,
    scope: rotated.scope || row.scope,
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
  };
  const finalizeDeadline = Date.now() + timings.leaseMs + timings.graceMs;
  let landed: boolean;
  for (;;) {
    try {
      landed = await store.finalizeTokenLease(SELF_ID, leaseId, row.refreshToken, next);
      break;
    } catch (error) {
      if (Date.now() >= finalizeDeadline) throw error;
      await sleep(timings.pollMs);
    }
  }
  if (!landed) {
    // Someone re-logged-in or recovered underneath us. Our pair may well be
    // valid, but the row is no longer the one we leased, and writing over it
    // would strand whatever grant is there now.
    logTransition("refreshing", "?", "lease lost before finalize; wrote nothing");
    return null;
  }
  logTransition("refreshing", "ready", isRecovery ? "rotated by recovery" : "rotated");
  return grantSnapshot(next);
}

/**
 * Drive the stored grant to a usable coherent snapshot, coordinating with
 * every other caller through the row itself.
 *
 * Each pass reads the row and does the one thing that row permits: use it,
 * claim it, recover it, or give up on it. Every write is
 * conditional on what was read, so a pass that loses a race simply reads
 * again — no caller ever acts on a row it no longer owns.
 */
async function renew(
  store: Storage,
  config: OAuthConfig,
  timings: TokenTimings,
  expectedAccountGeneration?: string,
): Promise<UserGrantSnapshot> {
  // Long enough to wait out a lapsed lease and run the recovery it permits.
  const deadline = Date.now() + timings.leaseMs + timings.graceMs + timings.fetchTimeoutMs;

  while (Date.now() <= deadline) {
    const status = expectedAccountGeneration
      ? await store.getOAuthStatusForGeneration(SELF_ID, expectedAccountGeneration)
      : null;
    if (expectedAccountGeneration && !status) {
      throw new OAuthGrantConflictError("X account changed; reload before retrying");
    }
    const row = expectedAccountGeneration ? status!.tokens : await store.getOAuthTokens(SELF_ID);
    if (!row) throw new OAuthError("the stored grant disappeared — visit /auth/login");
    if (row.state === "disconnecting") throw new OAuthGrantConflictError();
    if (row.state === "reauthorizing") {
      throw new OAuthGrantConflictError(
        "X account reauthorization is pending; retry Reconnect or disconnect X",
      );
    }
    if (row.state === "broken") throw brokenError(row.brokenReason ?? "unknown");
    // A live token means someone else's refresh landed (or a fresh login did).
    if (isLive(row)) return grantSnapshot(row);

    if (row.state === "ready") {
      const leaseId = randomToken();
      const claimed = await store.claimTokenLease(
        SELF_ID,
        row.refreshToken,
        leaseId,
        Date.now() + timings.leaseMs,
      );
      if (!claimed) continue; // Someone else got there first; read again.
      logTransition("ready", "refreshing", "lease claimed");
      const grant = await refreshUnderLease(store, config, row, leaseId, timings, false);
      if (grant !== null) return grant;
      continue; // Lease lost mid-flight: carry on as one of the losers.
    }

    // Someone else holds the lease. A same-isolate sibling joins the in-memory
    // promise above; a different isolate cannot wait by polling D1 without
    // exhausting Free's per-invocation query budget. Fail closed and let the
    // browser retry after the rightful owner finishes. The loser never calls X.
    const abandonedAt = (row.leaseUntil ?? 0) + timings.graceMs;
    if (Date.now() < abandonedAt) {
      throw new OAuthGrantConflictError("X token refresh is already in progress; retry shortly");
    }

    // The lease has lapsed and the grace period with it.
    if (row.recoveryUsed) {
      // A grant that has already burned its one recovery and been abandoned
      // again is not something we may keep guessing at.
      const reason = "refresh abandoned again after its one recovery attempt";
      await store.markTokenBroken(SELF_ID, row.refreshToken, reason);
      logTransition("refreshing", "broken", reason);
      continue; // Read it back and report it the same way any caller would.
    }
    const leaseId = randomToken();
    const recovered = await store.claimRecoveryLease(
      SELF_ID,
      row.refreshToken,
      leaseId,
      Date.now() + timings.leaseMs,
      Date.now() - timings.graceMs,
    );
    if (!recovered) continue;
    logTransition("refreshing", "refreshing", "abandoned lease recovered (one attempt only)");
    const grant = await refreshUnderLease(store, config, row, leaseId, timings, true);
    if (grant !== null) return grant;
  }

  throw new OAuthError("timed out waiting for the token refresh to settle — try again");
}

/**
 * A coherent snapshot of a valid user-context grant, refreshing when its
 * access token is close to expiry. Returns null when the deployment has no
 * user tokens configured, which callers report as the feature being
 * unavailable — there is no app-only fallback, because no user-context
 * endpoint accepts the app-only bearer. Throws when the grant is broken: only
 * `/auth/login` fixes that, and pretending otherwise would send the caller off
 * to make a doomed API call.
 */
export async function getUserGrantSnapshot(
  store: Storage,
  config: OAuthConfig | null,
  timings: Partial<TokenTimings> = {},
  expectedAccountGeneration?: string,
): Promise<UserGrantSnapshot | null> {
  if (!config) return null;

  // Only /auth/login mints a grant; with no stored row the deployment has
  // simply never been authorized.
  const status = expectedAccountGeneration
    ? await store.getOAuthStatusForGeneration(SELF_ID, expectedAccountGeneration)
    : null;
  if (expectedAccountGeneration && !status) {
    throw new OAuthGrantConflictError("X account changed; reload before retrying");
  }
  const tokens = expectedAccountGeneration ? status!.tokens : await store.getOAuthTokens(SELF_ID);
  if (!tokens) return null;
  if (tokens.state === "disconnecting") throw new OAuthGrantConflictError();
  if (tokens.state === "reauthorizing") {
    throw new OAuthGrantConflictError(
      "X account reauthorization is pending; retry Reconnect or disconnect X",
    );
  }
  if (tokens.state === "broken") throw brokenError(tokens.brokenReason ?? "unknown");
  if (isLive(tokens)) return grantSnapshot(tokens);

  const pending = refreshesInFlight.get(store);
  if (pending) {
    const grant = await pending;
    if (
      expectedAccountGeneration &&
      !(await store.isOAuthGrantCurrent(
        SELF_ID,
        grant.refreshToken,
        expectedAccountGeneration,
      ))
    ) {
      throw new OAuthGrantConflictError("X account changed; reload before retrying");
    }
    return grant;
  }

  const attempt = renew(
    store,
    config,
    { ...DEFAULT_TIMINGS, ...timings },
    expectedAccountGeneration,
  );
  refreshesInFlight.set(store, attempt);
  try {
    return await attempt;
  } finally {
    refreshesInFlight.delete(store);
  }
}

/** Token-only compatibility for callers that do not also resolve identity. */
export async function getUserAccessToken(
  store: Storage,
  config: OAuthConfig | null,
  timings: Partial<TokenTimings> = {},
): Promise<string | null> {
  return (await getUserGrantSnapshot(store, config, timings))?.accessToken ?? null;
}

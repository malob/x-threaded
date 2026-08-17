import type { SpendMeter } from "./meter";
import { getUserGrantSnapshot, SELF_ID, type OAuthConfig } from "./oauth";
import type { Storage } from "./storage";
import { XApiError, type XApiClient } from "./xapi";

/** The stored grant changed too often to resolve one current account safely. */
export class UserContextConflictError extends Error {
  constructor(message = "X account changed during the request; retry") {
    super(message);
    this.name = "UserContextConflictError";
  }
}

/** One retry lets an ordinary account switch settle without an unbounded paid loop. */
const MAX_PROFILE_ATTEMPTS = 2;

/**
 * getMe is safe to repeat after a crashed holder, unlike a refresh-token
 * exchange, but it is billable. Two minutes covers X's bounded 60-second
 * retry wait with headroom; a holder that disappears eventually stops
 * blocking every user-context route.
 */
const PROFILE_LEASE_MS = 2 * 60_000;
const PROFILE_POLL_INITIAL_MS = 25;
const PROFILE_POLL_MAX_MS = 1_600;
/**
 * Six read/claim pairs cost 12 statements. A final losing re-read costs 13;
 * a sixth-pass winner uses the two-statement profile finish plus at most two
 * generation checks for X's one permitted getMe retry: 16. This leaves the
 * heavy bookmark and own-post routes inside D1 Free's 50-query ceiling.
 */
const PROFILE_MAX_CLAIM_PASSES = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A user-context access token plus the signed-in user's ID. The ID is
 * resolved once via /2/users/me (a billable User Read at $0.010, charged to
 * the request's meter) and cached with the tokens. Throws when user context
 * isn't configured.
 *
 * Lives outside oauth.ts because resolving the ID costs money: oauth.ts is
 * pure token plumbing and knows nothing about the X client.
 */
export async function userContext(
  store: Storage,
  xapi: XApiClient,
  oauth: OAuthConfig | null,
  meter: SpendMeter,
  expectedAccountGeneration?: string,
): Promise<{ token: string; userId: string; refreshToken: string }> {
  let paidAttempts = 0;
  let claimPasses = 0;
  let pollMs = PROFILE_POLL_INITIAL_MS;

  for (;;) {
    const grant = oauth
      ? await getUserGrantSnapshot(store, oauth, {}, expectedAccountGeneration)
      : null;
    if (!grant) throw new XApiError("user context is not configured — visit /auth/login", 401);
    if (grant.userId) {
      return { token: grant.accessToken, userId: grant.userId, refreshToken: grant.refreshToken };
    }
    if (paidAttempts >= MAX_PROFILE_ATTEMPTS) throw new UserContextConflictError();

    const now = Date.now();
    if (claimPasses >= PROFILE_MAX_CLAIM_PASSES) {
      throw new UserContextConflictError("X account profile is still resolving; retry");
    }

    const leaseId = crypto.randomUUID();
    claimPasses += 1;
    const claimed = await store.claimUserProfileLease(
      SELF_ID,
      grant.refreshToken,
      leaseId,
      now + PROFILE_LEASE_MS,
      now,
      expectedAccountGeneration,
    );
    if (!claimed) {
      // Re-read rather than trusting the snapshot that lost: the holder may
      // have cached this profile, or a login/refresh may have installed a new
      // grant. A request waits through an ordinary getMe, not through the
      // whole crash lease: the latter would exhaust D1's per-invocation query
      // budget before a heavy route did its real work. A later request that
      // begins after expiry can recover in its first claim.
      await sleep(pollMs);
      pollMs = Math.min(pollMs * 2, PROFILE_POLL_MAX_MS);
      continue;
    }

    paidAttempts += 1;
    pollMs = PROFILE_POLL_INITIAL_MS;

    let me: { id: string; username: string; name: string };
    try {
      me = meter.charge(
        await xapi.getMe(grant.accessToken, {
          beforeRequest: expectedAccountGeneration
            ? async () => {
                if (
                  !(await store.isOAuthGrantCurrent(
                    SELF_ID,
                    grant.refreshToken,
                    expectedAccountGeneration,
                  ))
                ) {
                  throw new UserContextConflictError(
                    "X account changed before profile lookup; stopped",
                  );
                }
              }
            : undefined,
        }),
      );
    } catch (error) {
      // A failed getMe consumes no single-use credential, so there is no
      // ambiguity that warrants stranding the lease. Never replace the X
      // error with a cleanup failure.
      try {
        await store.releaseUserProfileLease(SELF_ID, grant.refreshToken, leaseId);
      } catch {
        // Expiry/recovery remains the fallback if storage is unavailable too.
      }
      throw error;
    }

    // A rotation or a fresh login can land during the getMe round-trip. The
    // atomic finish is a CAS on both the refresh token and the durable profile
    // lease observed alongside the missing identity. Losing either means this
    // snapshot is no longer current, so do not hand it to the route for
    // another X call: read the replacement grant or winner's cached profile.
    //
    // The handle and name ride along so /api/auth/status can name the account
    // without ever paying for a getMe of its own.
    const cached = await store.finishUserProfileLease(
      SELF_ID,
      grant.refreshToken,
      leaseId,
      {
        userId: me.id,
        username: me.username,
        displayName: me.name,
      },
    );
    if (cached) {
      return { token: grant.accessToken, userId: me.id, refreshToken: grant.refreshToken };
    }
  }
}

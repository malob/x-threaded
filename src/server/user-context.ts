import { getUserAccessToken, SELF_ID, type OAuthConfig } from "./oauth";
import type { Storage } from "./storage";
import { XApiError, type XApiClient } from "./xapi";

/**
 * A user-context access token plus the signed-in user's ID. The ID is
 * resolved once via /2/users/me (a billable user read) and cached with
 * the tokens. Throws when user context isn't configured.
 *
 * Lives outside oauth.ts because resolving the ID costs money: oauth.ts is
 * pure token plumbing and knows nothing about the X client.
 */
export async function userContext(
  store: Storage,
  xapi: XApiClient,
  oauth: OAuthConfig | null,
): Promise<{ token: string; userId: string }> {
  const token = oauth ? await getUserAccessToken(store, oauth) : null;
  if (!token) throw new XApiError("user context is not configured — visit /auth/login", 401);
  const stored = await store.getOAuthTokens(SELF_ID);
  if (stored?.userId) return { token, userId: stored.userId };
  const me = await xapi.getMe(token);
  // A rotation can land during the getMe round-trip, so this writes the three
  // profile columns and nothing else: no snapshot of the token pair goes back
  // to the database, and there is no read-modify-write window to lose. The
  // handle and name ride along so /api/auth/status can name the account
  // without ever paying for a getMe of its own.
  await store.putUserProfile(SELF_ID, {
    userId: me.id,
    username: me.username,
    displayName: me.name,
  });
  return { token, userId: me.id };
}

import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessConfig {
  /** The Access application's AUD tag. */
  policyAud?: string;
  /** e.g. https://<team>.cloudflareaccess.com */
  teamDomain?: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  let set = jwksCache.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, set);
  }
  return set;
}

function denied(reason: string): Response {
  return Response.json({ error: `Access denied: ${reason}` }, { status: 403 });
}

/**
 * Verify the JWT that Cloudflare Access attaches to authenticated requests.
 *
 * Defense in depth behind the Access gate itself: if Access were disabled or
 * misconfigured, requests would arrive with no token and this fails closed
 * rather than silently serving the API (and spending X API credits) to
 * anyone. Returns null when the request may proceed, or a 403 Response.
 *
 * Enforcement is skipped when the deployment hasn't configured Access
 * (no policyAud/teamDomain — e.g. a fork that chose to run without it) and
 * on localhost, where `wrangler dev` runs with no Access in front.
 */
export async function checkAccess(
  request: Request,
  { policyAud, teamDomain }: AccessConfig,
): Promise<Response | null> {
  if (!policyAud || !teamDomain) return null;
  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") return null;

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    // Service tokens and some clients send the JWT as a cookie instead.
    /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1];
  if (!token) return denied("missing Access token");

  try {
    await jwtVerify(token, jwks(teamDomain), { issuer: teamDomain, audience: policyAud });
    return null;
  } catch (err) {
    return denied((err as Error).message);
  }
}

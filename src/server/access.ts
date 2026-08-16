import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessConfig {
  /** The Access application's AUD tag. */
  policyAud?: string;
  /** e.g. https://<team>.cloudflareaccess.com */
  teamDomain?: string;
  /**
   * Deliberately serve a deployed Worker with no gate in front of it. Off
   * unless ALLOW_UNGATED is exactly "true", so a typo fails safe.
   */
  allowUngated?: boolean;
}

const UNGATED =
  "this deployment has no gate in front of it, and an open Worker holding a " +
  "working X token lets anyone on the internet spend your X credits. Put it " +
  "behind Cloudflare Access and set POLICY_AUD + TEAM_DOMAIN, or set " +
  "ALLOW_UNGATED=true to accept the risk. See DEPLOYING.md, step 4.";

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
 * Two escapes, in this order:
 *
 * 1. localhost is never gated — `wrangler dev` and the Bun server both run
 *    with no Access in front, and neither is reachable from the internet.
 * 2. A *deployed* Worker with no Access configured is refused rather than
 *    served. This used to be allowed, as an escape hatch for forks that
 *    didn't want a gate, but the hatch pointed the wrong way: the deployer
 *    who never reads this file is exactly the one who ends up with a public
 *    URL billing their card at $0.005 a post. Wanting no gate is now
 *    something you say out loud, with ALLOW_UNGATED.
 *
 * Only /api/* and /auth/* reach the Worker (wrangler.jsonc `run_worker_first`),
 * so a refusal here still serves the SPA — the app loads and reports why it
 * can't talk to its own API, which is the state that explains itself best.
 */
export async function checkAccess(
  request: Request,
  { policyAud, teamDomain, allowUngated }: AccessConfig,
): Promise<Response | null> {
  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") return null;

  if (!policyAud || !teamDomain) return allowUngated ? null : denied(UNGATED);

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

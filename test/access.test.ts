import { describe, expect, it } from "bun:test";
import { checkAccess } from "../src/server/access";

const DEPLOYED = "https://x-threaded.example.workers.dev/api/conversations";
const LOCAL = "http://localhost:8788/api/conversations";

/** checkAccess returns null to admit a request, or a 403 Response to refuse. */
async function reason(response: Response | null): Promise<string | null> {
  if (!response) return null;
  const body = (await response.json()) as { error: string };
  return body.error;
}

describe("checkAccess", () => {
  describe("localhost is never gated", () => {
    // Both local runtimes serve without Access in front, and neither is
    // reachable from the internet. This must hold whatever else is set.
    it.each([
      ["no config at all", {}],
      ["Access configured", { policyAud: "aud", teamDomain: "https://team.cloudflareaccess.com" }],
    ])("admits localhost with %s", async (_label, config) => {
      expect(await checkAccess(new Request(LOCAL), config)).toBeNull();
    });

    it("admits 127.0.0.1", async () => {
      expect(await checkAccess(new Request("http://127.0.0.1:8788/api/x"), {})).toBeNull();
    });
  });

  describe("a deployed Worker with no Access config", () => {
    // The regression this locks: returning null here left every fork's
    // deployment open, spending the deployer's X credits for anyone with the
    // URL. Refusing is the whole point of the branch.
    it("is refused", async () => {
      const denial = await checkAccess(new Request(DEPLOYED), {});
      expect(denial?.status).toBe(403);
      expect(await reason(denial)).toContain("spend your X credits");
    });

    it("names both ways out", async () => {
      const why = await reason(await checkAccess(new Request(DEPLOYED), {}));
      expect(why).toContain("POLICY_AUD");
      expect(why).toContain("ALLOW_UNGATED");
    });

    it("is refused when only one half of the pair is set", async () => {
      expect(await checkAccess(new Request(DEPLOYED), { policyAud: "aud" })).not.toBeNull();
      expect(
        await checkAccess(new Request(DEPLOYED), { teamDomain: "https://t.cloudflareaccess.com" }),
      ).not.toBeNull();
    });

    it("is admitted once the deployer opts out", async () => {
      expect(await checkAccess(new Request(DEPLOYED), { allowUngated: true })).toBeNull();
    });
  });

  describe("a deployed Worker behind Access", () => {
    const configured = {
      policyAud: "aud",
      teamDomain: "https://team.cloudflareaccess.com",
    };

    it("refuses a request carrying no Access token", async () => {
      const denial = await checkAccess(new Request(DEPLOYED), configured);
      expect(denial?.status).toBe(403);
      expect(await reason(denial)).toContain("missing Access token");
    });

    // Opting out of the gate must not also disable verification of a gate
    // that is configured — otherwise one flag silently turns off both.
    it("still refuses an untokened request when ALLOW_UNGATED is set", async () => {
      const denial = await checkAccess(new Request(DEPLOYED), {
        ...configured,
        allowUngated: true,
      });
      expect(await reason(denial)).toContain("missing Access token");
    });

    it("refuses a garbage token rather than throwing", async () => {
      const denial = await checkAccess(
        new Request(DEPLOYED, { headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" } }),
        configured,
      );
      expect(denial?.status).toBe(403);
    });
  });
});

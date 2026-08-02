/**
 * The entire global surface src/shared is allowed to assume.
 *
 * src/shared is compiled by tsconfig.shared.json with `lib: ["ESNext"]` and
 * `types: []` — no DOM, no Bun, no Workers. That is the point: shared code is
 * imported by the browser bundle, the Bun server and the Worker, so anything it
 * reaches for has to exist in all three. Without this file a shared module
 * cannot name a single host API; with it, it can name exactly the ones listed
 * here, and adding one is a deliberate edit rather than an accident.
 *
 * The declarations are borrowed from @cloudflare/workers-types rather than
 * hand-written, so `URL` here is the real WHATWG type, identical in shape to
 * the one lib.dom and Bun provide.
 *
 * This file is included only by tsconfig.shared.json. The other projects check
 * src/shared too (they import it), and there it resolves against their own
 * runtime's `URL` — so the declaration below can never mask a mismatch.
 */
import type { URL as WhatwgURL } from "@cloudflare/workers-types";

declare global {
  const URL: typeof WhatwgURL;
  type URL = WhatwgURL;
}

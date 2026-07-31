/**
 * The other untrusted boundary: what a client sends us.
 *
 * A body that doesn't parse, or doesn't match, is the caller's mistake and
 * has to read as one. Left to `c.req.json()` it arrives at the error handler
 * as a bare SyntaxError and comes back a 500 — a server fault the client
 * can't act on, for a request only the client can fix.
 */
import * as v from "valibot";
import { summarizeIssues } from "./x-wire";

/** A body that held up, or the message explaining the 400 it earns. */
export type ParsedBody<T> = { ok: true; body: T } | { ok: false; error: string };

export async function jsonBody<TSchema extends v.GenericSchema>(
  request: Request,
  schema: TSchema,
): Promise<ParsedBody<v.InferOutput<TSchema>>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }
  const parsed = v.safeParse(schema, raw);
  return parsed.success
    ? { ok: true, body: parsed.output }
    : { ok: false, error: `invalid body — ${summarizeIssues(parsed.issues)}` };
}

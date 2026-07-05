import type { NextRequest } from "next/server";

/** Presence + validity of the Authorization header, kept separate so an invalid
 *  key returns a spec-shaped 401 (with WWW-Authenticate) instead of falling
 *  through to the browser human-verification path. Shared by the credit-spending
 *  endpoints (/api/scan, /api/roast) — agents authenticate here, humans are
 *  verified by Turnstile (scan) or BotID (roast). */
export function machineAuth(req: NextRequest): "valid" | "invalid" | "absent" {
  const value = req.headers.get("authorization") ?? "";
  if (!value) return "absent";
  const expected = process.env.GITHUB_ROAST_CLI_API_KEY;
  const token = value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return expected && token === expected ? "valid" : "invalid";
}

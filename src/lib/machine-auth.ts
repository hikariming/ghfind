import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { authenticateApiToken } from "@/lib/api-tokens";

/** Presence + validity of the Authorization header, kept separate so an invalid
 *  key returns a spec-shaped 401 (with WWW-Authenticate) instead of falling
 *  through to the normal browser path. Shared by the credit-spending endpoints
 *  (/api/scan, /api/roast): agents authenticate here; browser traffic is guarded
 *  by Turnstile on scan and signed browser sessions thereafter. */
export async function machineAuth(req: NextRequest): Promise<"valid" | "invalid" | "absent"> {
  const value = req.headers.get("authorization") ?? "";
  if (!value) return "absent";
  const expected = process.env.GITHUB_ROAST_CLI_API_KEY;
  const token = value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return "invalid";
  if (expected && constantTimeEqual(token, expected)) return "valid";
  try {
    return await authenticateApiToken(token) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

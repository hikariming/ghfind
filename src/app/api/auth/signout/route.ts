import { NextRequest, NextResponse } from "next/server";
import { OAUTH_SESSION_COOKIE, clearOAuthCookie } from "@/lib/oauth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  const res = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  clearOAuthCookie(res, request, OAUTH_SESSION_COOKIE);
  return res;
}

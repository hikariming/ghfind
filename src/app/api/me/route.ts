import { NextRequest, NextResponse } from "next/server";
import { hasCanonicalPublicScore } from "@/lib/db";
import { sessionFromRequest } from "@/lib/oauth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deliberately always a 200 probe: browser chrome calls it without error
 * handling. (Repatriated from Go: me.)
 */
export async function GET(request: NextRequest) {
  const session = sessionFromRequest(request);
  if (!session) {
    return NextResponse.json(
      { user: null, scored: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const scored = await hasCanonicalPublicScore(session.login);
  return NextResponse.json(
    { user: { login: session.login, image: session.avatar_url ?? null }, scored },
    { headers: { "Cache-Control": "no-store" } },
  );
}

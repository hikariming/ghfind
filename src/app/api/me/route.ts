import { NextRequest, NextResponse } from "next/server";
import { hasCanonicalPublicScore } from "@/lib/db";
import { oauthConfigured } from "@/lib/oauth-config";
import { sessionFromRequest } from "@/lib/oauth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deliberately always a 200 probe: browser chrome calls it without error
 * handling. (Repatriated from Go: me.)
 *
 * Also reports `oauth` — whether this deployment can actually run the GitHub
 * OAuth flow — so client chrome (NavAuth, LoginNudge) can decide login-UI
 * visibility at runtime instead of trusting a value baked into prerendered
 * HTML at build time (local/preview builds often lack the OAuth secrets).
 */
export async function GET(request: NextRequest) {
  const oauth = oauthConfigured();
  const session = sessionFromRequest(request);
  if (!session) {
    return NextResponse.json(
      { user: null, scored: false, oauth },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const scored = await hasCanonicalPublicScore(session.login);
  return NextResponse.json(
    { user: { login: session.login, image: session.avatar_url ?? null }, scored, oauth },
    { headers: { "Cache-Control": "no-store" } },
  );
}

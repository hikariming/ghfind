import { NextRequest, NextResponse } from "next/server";
import { hasCanonicalPublicScore } from "@/lib/db";
import { OAUTH_SESSION_COOKIE, sessionFromRequest } from "@/lib/oauth-session";
import { configuredOAuthProviders, readSocialSession } from "@/lib/social-session";

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
  const providers = configuredOAuthProviders();
  const oauth = providers.github;
  const session = sessionFromRequest(request);
  if (!session) {
    const social = readSocialSession(request.cookies.get(OAUTH_SESSION_COOKIE)?.value);
    const account = social ? {
      provider: social.provider, subject: social.subject, name: social.name, image: social.image,
    } : null;
    return NextResponse.json(
      { user: null, account, scored: false, oauth, providers },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const scored = await hasCanonicalPublicScore(session.login);
  return NextResponse.json(
    {
      user: { login: session.login, image: session.avatar_url ?? null }, scored, oauth, providers,
      account: {
        provider: "github", subject: String(session.github_id),
        name: session.login, image: session.avatar_url ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

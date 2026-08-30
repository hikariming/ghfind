import { NextRequest, NextResponse } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  newOAuthState,
  oauthConfigured,
  safeOAuthCallback,
  setOAuthCookie,
} from "@/lib/oauth-session";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GITHUB_OAUTH_ORIGIN = "https://github.com";

/** Begin the GitHub OAuth flow (repatriated from Go: beginGitHubOAuth). */
export function GET(request: NextRequest) {
  if (!oauthConfigured()) {
    return NextResponse.json(
      { error: "auth_not_configured" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const callbackTo = safeOAuthCallback(
    request.nextUrl.searchParams.get("callbackUrl"),
    SITE_URL,
  );
  const state = newOAuthState(callbackTo);
  const authorize = new URL(`${GITHUB_OAUTH_ORIGIN}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", process.env.AUTH_GITHUB_ID!.trim());
  authorize.searchParams.set("redirect_uri", `${SITE_URL}/api/auth/callback/github`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  const res = NextResponse.redirect(authorize, 302);
  setOAuthCookie(res, request, OAUTH_STATE_COOKIE, state, OAUTH_STATE_TTL_SECONDS);
  return res;
}

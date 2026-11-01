import { NextRequest, NextResponse } from "next/server";
import { GOOGLE_STATE_COOKIE, googleAuthorizationUrl, newGoogleOAuthState } from "@/lib/google-oauth";
import { OAUTH_STATE_TTL_SECONDS, clearOAuthCookie, safeOAuthCallback, setOAuthCookie } from "@/lib/oauth-session";
import { googleOAuthConfigured } from "@/lib/social-session";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const callback = safeOAuthCallback(request.nextUrl.searchParams.get("callbackUrl"), SITE_URL);
  if (!googleOAuthConfigured()) {
    const target = new URL(`${SITE_URL}${callback}`);
    target.searchParams.set("auth_error", "auth_unavailable");
    const response = NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store" } });
    clearOAuthCookie(response, request, GOOGLE_STATE_COOKIE);
    return response;
  }
  const { state, cookie } = newGoogleOAuthState(callback);
  const response = NextResponse.redirect(googleAuthorizationUrl(state), {
    status: 302,
    headers: { "Cache-Control": "no-store" },
  });
  setOAuthCookie(response, request, GOOGLE_STATE_COOKIE, cookie, OAUTH_STATE_TTL_SECONDS);
  return response;
}

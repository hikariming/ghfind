import { NextRequest, NextResponse } from "next/server";
import { commentClientIp } from "@/lib/comments";
import {
  GOOGLE_STATE_COOKIE,
  exchangeGoogleCode,
  googleOAuthFailureDetails,
  googleStateMatches,
  readGoogleOAuthState,
} from "@/lib/google-oauth";
import {
  OAUTH_SESSION_COOKIE,
  OAUTH_SESSION_TTL_SECONDS,
  clearOAuthCookie,
  safeOAuthCallback,
  setOAuthCookie,
} from "@/lib/oauth-session";
import { encodeSocialSession, googleOAuthConfigured } from "@/lib/social-session";
import { checkOAuthCallbackRateLimit } from "@/lib/redis";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const state = readGoogleOAuthState(request.cookies.get(GOOGLE_STATE_COOKIE)?.value);
  const query = request.nextUrl.searchParams;
  const target = new URL(`${SITE_URL}${safeOAuthCallback(state?.callback_to ?? null, SITE_URL)}`);
  function redirect(error?: "google_failed" | "google_denied" | "invalid_state" | "auth_unavailable") {
    if (error) target.searchParams.set("auth_error", error);
    else target.searchParams.delete("auth_error");
    const response = NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store" } });
    clearOAuthCookie(response, request, GOOGLE_STATE_COOKIE);
    return response;
  }

  if (!googleOAuthConfigured()) return redirect("auth_unavailable");
  if (!state || query.getAll("state").length !== 1 || !googleStateMatches(query.get("state"), state)) {
    return redirect("invalid_state");
  }
  if (query.has("error")) return redirect(query.get("error") === "access_denied" ? "google_denied" : "google_failed");
  const code = query.get("code");
  if (!code || code.length > 4_096 || query.getAll("code").length !== 1) return redirect("google_failed");

  let stage: "rate_limit" | "exchange" | "session" = "rate_limit";
  try {
    const limit = await checkOAuthCallbackRateLimit(commentClientIp(request.headers));
    if (!limit.success) return redirect(limit.unavailable ? "auth_unavailable" : "google_failed");
    stage = "exchange";
    const identity = await exchangeGoogleCode(code, state);
    stage = "session";
    const response = redirect();
    setOAuthCookie(response, request, OAUTH_SESSION_COOKIE, encodeSocialSession({
      provider: "google",
      ...identity,
      expires_at: Date.now() + OAUTH_SESSION_TTL_SECONDS * 1_000,
    }), OAUTH_SESSION_TTL_SECONDS);
    return response;
  } catch (error) {
    // Only explicitly classified fields are logged; never serialize the error,
    // request URL, provider response, authorization code or identity.
    const details = googleOAuthFailureDetails(error);
    console.warn("oauth_google_failed", {
      ...details,
      stage: details.stage === "unknown" ? stage : details.stage,
    });
    return redirect("google_failed");
  }
}

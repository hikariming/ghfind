import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { normalizeGitHubUsername } from "@/lib/comments";
import { upsertUser } from "@/lib/db";
import {
  OAUTH_SESSION_COOKIE,
  OAUTH_SESSION_TTL_SECONDS,
  OAUTH_STATE_COOKIE,
  clearOAuthCookie,
  encodeSignedPayload,
  oauthConfigured,
  readOAuthState,
  setOAuthCookie,
  type OAuthSession,
} from "@/lib/oauth-session";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GITHUB_OAUTH_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";

function noStore(body: Record<string, string>, status: number, retryAfter?: string) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return NextResponse.json(body, { status, headers });
}

function equalConstantTime(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

type GitHubProfile = { id: number; login: string; name?: string | null; avatar_url?: string };

async function fetchGitHubOAuthProfile(code: string): Promise<GitHubProfile | null> {
  const tokenResponse = await fetch(`${GITHUB_OAUTH_ORIGIN}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ghfind",
    },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GITHUB_ID!.trim(),
      client_secret: process.env.AUTH_GITHUB_SECRET!.trim(),
      code,
      redirect_uri: `${SITE_URL}/api/auth/callback/github`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) return null;
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) return null;

  const profileResponse = await fetch(`${GITHUB_API_ORIGIN}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token.access_token}`,
      "User-Agent": "ghfind",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!profileResponse.ok) return null;
  const profile = (await profileResponse.json()) as GitHubProfile;
  if (!profile.id || profile.id <= 0) return null;
  const login = normalizeGitHubUsername(profile.login ?? "");
  if (!login) return null;
  return { ...profile, login };
}

/** Complete the GitHub OAuth flow (repatriated from Go: completeGitHubOAuth). */
export async function GET(request: NextRequest) {
  if (!oauthConfigured()) return noStore({ error: "auth_not_configured" }, 404);

  const stateCookie = request.cookies.get(OAUTH_STATE_COOKIE)?.value ?? "";
  const state = readOAuthState(stateCookie);
  const queryState = request.nextUrl.searchParams.get("state") ?? "";
  if (!state || !equalConstantTime(queryState, stateCookie)) {
    const res = noStore({ error: "invalid_oauth_state" }, 400);
    clearOAuthCookie(res, request, OAUTH_STATE_COOKIE);
    return res;
  }
  if (request.nextUrl.searchParams.get("error")) {
    const res = NextResponse.redirect(`${SITE_URL}/?auth_error=github`, 302);
    clearOAuthCookie(res, request, OAUTH_STATE_COOKIE);
    return res;
  }
  const code = request.nextUrl.searchParams.get("code")?.trim();
  if (!code) return noStore({ error: "missing_oauth_code" }, 400);

  let profile: GitHubProfile | null = null;
  try {
    profile = await fetchGitHubOAuthProfile(code);
  } catch {
    profile = null;
  }
  if (!profile) return noStore({ error: "github_oauth_failed" }, 502, "15");

  const session: OAuthSession = {
    github_id: profile.id,
    login: profile.login,
    avatar_url: profile.avatar_url || undefined,
    expires_at: Date.now() + OAUTH_SESSION_TTL_SECONDS * 1000,
  };
  // Best-effort user row (matches the TS-era behavior; the session cookie is
  // the source of identity, `users` is informational).
  await upsertUser({
    github_id: profile.id,
    login: profile.login,
    name: profile.name?.trim() || null,
    avatar_url: profile.avatar_url || null,
  });

  const res = NextResponse.redirect(`${SITE_URL}${state.callback_to}`, 302);
  setOAuthCookie(
    res,
    request,
    OAUTH_SESSION_COOKIE,
    encodeSignedPayload("session", session),
    OAUTH_SESSION_TTL_SECONDS,
  );
  clearOAuthCookie(res, request, OAUTH_STATE_COOKIE);
  return res;
}

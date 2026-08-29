import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { normalizeGitHubUsername } from "@/lib/comments";

/**
 * GitHub OAuth session/state signing, repatriated from the Go backend
 * (internal/backend/oauth.go) during 阶段2 B3. The wire format is kept
 * byte-for-byte compatible so `ghfind_session` cookies issued by Go stay
 * valid across the cutover:
 *
 *   base64url(JSON) + "." + base64url(HMAC_SHA256(AUTH_SECRET,
 *     "ghfind:oauth:" + kind + ":" + base64url(JSON)))
 *
 * kind is "state" or "session"; JSON field names are the Go struct tags
 * (snake_case). Timestamps are Unix milliseconds.
 */

export const OAUTH_STATE_COOKIE = "ghfind_oauth_state";
export const OAUTH_SESSION_COOKIE = "ghfind_session";
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
export const OAUTH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export type OAuthSession = {
  github_id: number;
  login: string;
  avatar_url?: string;
  expires_at: number;
};

export type OAuthState = {
  nonce: string;
  expires_at: number;
  callback_to: string;
};

function authSecret(): string | null {
  const value = process.env.AUTH_SECRET?.trim();
  return value || null;
}

export function oauthConfigured(): boolean {
  return Boolean(
    process.env.AUTH_GITHUB_ID?.trim() &&
      process.env.AUTH_GITHUB_SECRET?.trim() &&
      authSecret(),
  );
}

function signature(kind: "state" | "session", encodedPayload: string): string {
  const secret = authSecret();
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  return createHmac("sha256", secret)
    .update(`ghfind:oauth:${kind}:${encodedPayload}`, "utf8")
    .digest("base64url");
}

export function encodeSignedPayload(kind: "state" | "session", value: unknown): string {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encoded}.${signature(kind, encoded)}`;
}

export function decodeSignedPayload<T>(kind: "state" | "session", raw: string): T | null {
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let expected: string;
  try {
    expected = signature(kind, parts[0]);
  } catch {
    return null;
  }
  const given = Buffer.from(parts[1], "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function newOAuthState(callbackTo: string): string {
  return encodeSignedPayload("state", {
    nonce: randomBytes(24).toString("base64url"),
    expires_at: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
    callback_to: callbackTo,
  } satisfies OAuthState);
}

export function readOAuthState(raw: string | undefined): OAuthState | null {
  if (!raw) return null;
  const state = decodeSignedPayload<OAuthState>("state", raw);
  if (!state || !state.nonce || !state.callback_to) return null;
  if (state.expires_at <= Date.now()) return null;
  return state;
}

/** Session from the request cookie, or null when absent/invalid/expired. */
export function sessionFromRequest(request: NextRequest): OAuthSession | null {
  const raw = request.cookies.get(OAUTH_SESSION_COOKIE)?.value;
  if (!raw) return null;
  const session = decodeSignedPayload<OAuthSession>("session", raw);
  if (!session || session.github_id <= 0) return null;
  const login = normalizeGitHubUsername(session.login ?? "");
  if (!login) return null;
  if (session.expires_at <= Date.now()) return null;
  return { ...session, login };
}

/**
 * Only same-origin destinations survive; everything suspicious falls back to
 * "/" (mirrors Go safeOAuthCallback — absolute URLs must match the public
 * origin, relative ones must be single-slash rooted paths).
 */
export function safeOAuthCallback(raw: string | null, publicOrigin: string): string {
  if (!raw) return "/";
  let parsed: URL;
  try {
    parsed = new URL(raw, "http://relative.invalid");
  } catch {
    return "/";
  }
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (isAbsolute) {
    let origin: URL;
    try {
      origin = new URL(publicOrigin);
    } catch {
      return "/";
    }
    if (
      parsed.protocol.toLowerCase() !== origin.protocol.toLowerCase() ||
      parsed.host.toLowerCase() !== origin.host.toLowerCase()
    ) {
      return "/";
    }
    return parsed.search ? `${parsed.pathname}${parsed.search}` : parsed.pathname;
  }
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function setOAuthCookie(
  res: NextResponse,
  request: NextRequest,
  name: string,
  value: string,
  maxAgeSeconds: number,
): void {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure =
    request.nextUrl.protocol === "https:" || proto?.toLowerCase() === "https";
  res.cookies.set(name, value, {
    path: "/",
    maxAge: maxAgeSeconds,
    httpOnly: true,
    sameSite: "lax",
    secure,
  });
}

export function clearOAuthCookie(
  res: NextResponse,
  request: NextRequest,
  name: string,
): void {
  setOAuthCookie(res, request, name, "", -1);
}

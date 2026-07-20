import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

export const ANONYMOUS_SESSION_COOKIE = "ghfind_anonymous_session";

const SESSION_VERSION = "v1";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const SESSION_MAX_AGE_SECONDS = Math.ceil(SESSION_TTL_MS / 1_000);
const SESSION_CONTEXT = "ghfind:anonymous-session";

export interface AnonymousSession {
  id: string;
  issued: boolean;
  value?: string;
}

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

/**
 * A browser session is issued only after a real Turnstile verification. Reuse
 * AUTH_SECRET when available; otherwise the Turnstile server secret is still a
 * private, high-entropy signing key. No session is issued without Turnstile.
 */
function signingSecret(): string | null {
  const turnstileSecret = configured(process.env.TURNSTILE_SECRET_KEY);
  if (!turnstileSecret) return null;
  return configured(process.env.AUTH_SECRET) ?? turnstileSecret;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${SESSION_CONTEXT}:${payload}`)
    .digest("base64url");
}

function validSignature(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function parseSession(value: string | undefined, now: number): string | null {
  const secret = signingSecret();
  if (!secret || !value) return null;
  const [version, id, rawExpiresAt, suppliedSignature, ...extra] = value.split(".");
  if (
    extra.length > 0 ||
    version !== SESSION_VERSION ||
    !/^[A-Za-z0-9_-]{24,}$/.test(id ?? "") ||
    !/^\d{13}$/.test(rawExpiresAt ?? "") ||
    !/^[A-Za-z0-9_-]{40,}$/.test(suppliedSignature ?? "")
  ) {
    return null;
  }
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  const payload = `${version}.${id}.${rawExpiresAt}`;
  return validSignature(suppliedSignature!, signature(payload, secret)) ? id! : null;
}

/** Return a signed session identity, never an untrusted client identifier. */
export function anonymousSessionPrincipal(req: NextRequest, now = Date.now()): string | null {
  const id = parseSession(req.cookies.get(ANONYMOUS_SESSION_COOKIE)?.value, now);
  return id ? `anon:${id}` : null;
}

/**
 * Call only after Turnstile succeeds. Existing valid sessions keep their expiry
 * so repeated scans cannot perpetually extend a browser budget.
 */
export function establishAnonymousSession(req: NextRequest, now = Date.now()): AnonymousSession | null {
  const existing = anonymousSessionPrincipal(req, now);
  if (existing) return { id: existing.slice("anon:".length), issued: false };

  const secret = signingSecret();
  if (!secret) return null;
  const id = randomBytes(18).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  const payload = `${SESSION_VERSION}.${id}.${expiresAt}`;
  return {
    id,
    issued: true,
    value: `${payload}.${signature(payload, secret)}`,
  };
}

/** Attach a short-lived, HttpOnly cookie only when a new session was issued. */
export function attachAnonymousSession<T extends NextResponse>(
  response: T,
  session: AnonymousSession | null,
): T {
  if (!session?.issued || !session.value) return response;
  response.cookies.set({
    name: ANONYMOUS_SESSION_COOKIE,
    value: session.value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}

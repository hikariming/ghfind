import { NextRequest, NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousSessionPrincipal,
  attachAnonymousSession,
  establishAnonymousSession,
} from "../anonymous-session";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("anonymous browser session", () => {
  it("issues a signed HttpOnly session only with a Turnstile server secret", () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-test-secret");
    const request = new NextRequest("https://example.test/api/scan");
    const session = establishAnonymousSession(request, 1_700_000_000_000);
    const response = attachAnonymousSession(NextResponse.json({ ok: true }), session);

    const cookie = response.cookies.get(ANONYMOUS_SESSION_COOKIE);
    expect(session).toMatchObject({ issued: true });
    expect(cookie?.value).toBe(session?.value);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
  });

  it("accepts the issued identity and rejects a tampered cookie", () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-test-secret");
    const now = 1_700_000_000_000;
    const initial = new NextRequest("https://example.test/api/scan");
    const session = establishAnonymousSession(initial, now);
    if (!session?.value) throw new Error("expected a session");

    const valid = new NextRequest("https://example.test/api/roast", {
      headers: { cookie: `${ANONYMOUS_SESSION_COOKIE}=${session.value}` },
    });
    const tampered = new NextRequest("https://example.test/api/roast", {
      headers: { cookie: `${ANONYMOUS_SESSION_COOKIE}=${session.value}x` },
    });

    expect(anonymousSessionPrincipal(valid, now + 1)).toBe(`anon:${session.id}`);
    expect(anonymousSessionPrincipal(tampered, now + 1)).toBeNull();
  });

  it("does not issue a browser identity when Turnstile is not configured", () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(establishAnonymousSession(new NextRequest("https://example.test/api/scan"))).toBeNull();
  });
});

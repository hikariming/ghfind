import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSignedPayload, OAUTH_SESSION_COOKIE, sessionFromRequest } from "@/lib/oauth-session";
import { readSocialSession } from "@/lib/social-session";
import type { GoogleOAuthState } from "@/lib/google-oauth";
import type { RateLimitResult } from "@/lib/redis";

const limiter = vi.hoisted(() => ({ check: vi.fn<(ip: string) => Promise<RateLimitResult>>() }));
vi.mock("@/lib/redis", () => ({ checkOAuthCallbackRateLimit: limiter.check }));

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKey: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
let oauth: typeof import("@/lib/google-oauth");
let begin: typeof import("@/app/api/auth/google/route");
let callback: typeof import("@/app/api/auth/callback/google/route");

beforeAll(async () => {
  [keyPair, wrongKey] = await Promise.all([
    generateKeyPair("RS256", { extractable: true }),
    generateKeyPair("RS256", { extractable: true }),
  ]);
  publicKey = { ...await exportJWK(keyPair.publicKey), kid: "test-google-key", alg: "RS256", use: "sig" };
});

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "local-session-test-secret");
  vi.stubEnv("AUTH_GOOGLE_ID", CLIENT_ID);
  vi.stubEnv("AUTH_GOOGLE_SECRET", "local-google-test-secret");
  vi.stubEnv("GHFIND_OAUTH_ENABLED", "1");
  vi.stubEnv("PUBLIC_SITE_URL", "https://ghfind.com");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://ghfind.com");
  limiter.check.mockReset().mockResolvedValue({ success: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  [oauth, begin, callback] = await Promise.all([
    import("@/lib/google-oauth"),
    import("@/app/api/auth/google/route"),
    import("@/app/api/auth/callback/google/route"),
  ]);
  // Every test explicitly provides its provider fixture; an unexpected network
  // call fails locally instead of contacting any real provider.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected test fetch"); }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function signedToken(state: GoogleOAuthState, claims: JWTPayload = {}, wrongSignature = false) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-stable-subject-123",
    iat: now,
    exp: now + 3_600,
    nonce: state.nonce,
    name: "测试用户",
    picture: "https://lh3.googleusercontent.com/example",
    email: "same-email-as-a-github-account@example.test",
    email_verified: true,
    ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: "test-google-key" })
    .sign(wrongSignature ? wrongKey.privateKey : keyPair.privateKey);
}

function providerFixture(token: string) {
  const fetch = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      expect(options?.redirect).toBe("manual");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ id_token: token, access_token: "not-persisted", refresh_token: "not-requested-or-persisted" });
    }
    if (url === JWKS_URL) return Response.json({ keys: [publicKey] });
    throw new Error("unexpected fixture endpoint");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function callbackRequest(cookie: string | undefined, state: string, extra = "code=one-use-code") {
  return new NextRequest(`https://ghfind.com/api/auth/callback/google?state=${encodeURIComponent(state)}&${extra}`, {
    headers: cookie ? { cookie: `${oauth.GOOGLE_STATE_COOKIE}=${cookie}` } : {},
  });
}

function expectError(response: Response, error: string, path = "/") {
  expect(response.status).toBe(302);
  const destination = new URL(response.headers.get("location")!);
  expect(destination.origin).toBe("https://ghfind.com");
  expect(destination.pathname).toBe(path);
  expect(destination.searchParams.get("auth_error")).toBe(error);
  expect(destination.searchParams.has("state")).toBe(false);
  expect(destination.searchParams.has("code")).toBe(false);
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("Google authorization code flow", () => {
  it("starts with a private state cookie, separate nonce, and S256 PKCE without exposing the verifier", () => {
    const response = begin.GET(new NextRequest("https://ghfind.com/api/auth/google?callbackUrl=%2Fen%2Fintegrations%3Ftab%3Daccount"));
    const location = new URL(response.headers.get("location")!);
    const cookie = response.cookies.get(oauth.GOOGLE_STATE_COOKIE)!;
    const state = oauth.readGoogleOAuthState(cookie.value)!;
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("redirect_uri")).toBe("https://ghfind.com/api/auth/callback/google");
    expect(location.searchParams.get("state")).toBe(state.state);
    expect(location.searchParams.get("nonce")).toBe(state.nonce);
    expect(state.state).not.toBe(state.nonce);
    expect(state.verifier).not.toBe(state.nonce);
    expect(location.searchParams.get("code_challenge")).toBe(createHash("sha256").update(state.verifier).digest("base64url"));
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.href).not.toContain(state.verifier);
    expect(location.href).not.toContain(cookie.value);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, maxAge: 600, path: "/" });
    expect(state.callback_to).toBe("/en/integrations?tab=account");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("validates a real signed JWT, exchanges the exact verifier and replaces GitHub with an isolated social session", async () => {
    const { state, cookie } = oauth.newGoogleOAuthState("/en/integrations?tab=account&auth_error=old");
    const fetch = providerFixture(await signedToken(state));
    const response = await callback.GET(callbackRequest(cookie, state.state));
    expect(response.headers.get("location")).toBe("https://ghfind.com/en/integrations?tab=account");
    expect(response.cookies.get(oauth.GOOGLE_STATE_COOKIE)?.maxAge).toBe(-1);
    const sessionCookie = response.cookies.get(OAUTH_SESSION_COOKIE)!;
    expect(sessionCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });
    expect(readSocialSession(sessionCookie.value)).toMatchObject({
      provider: "google", subject: "google-stable-subject-123", name: "测试用户", image: "https://lh3.googleusercontent.com/example",
    });
    expect(sessionFromRequest(new NextRequest("https://ghfind.com/api/me", { headers: { cookie: `${OAUTH_SESSION_COOKIE}=${sessionCookie.value}` } }))).toBeNull();
    const payload = Buffer.from(sessionCookie.value.split(".")[0], "base64url").toString("utf8");
    for (const excluded of ["email", "access_token", "refresh_token", "github_id", "local-google-test-secret"]) expect(payload).not.toContain(excluded);
    const exchange = new URLSearchParams(fetch.mock.calls[0][1]?.body as URLSearchParams);
    expect(exchange.get("code_verifier")).toBe(state.verifier);
    expect(exchange.get("client_secret")).toBe("local-google-test-secret");
    expect(exchange.get("redirect_uri")).toBe("https://ghfind.com/api/auth/callback/google");
  });

  it("reuses cached certificates across successful logins", async () => {
    const { state } = oauth.newGoogleOAuthState("/");
    const fetch = providerFixture(await signedToken(state));
    await oauth.exchangeGoogleCode("first-one-use-code", state);
    await oauth.exchangeGoogleCode("different-one-use-code", state);
    expect(fetch.mock.calls.filter(([url]) => String(url) === JWKS_URL)).toHaveLength(1);
  });

  it("does not accept a replay after the browser state cookie has been cleared", async () => {
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    const fetch = providerFixture(await signedToken(state));
    await callback.GET(callbackRequest(cookie, state.state));
    fetch.mockClear();
    expectError(await callback.GET(callbackRequest(undefined, state.state)), "invalid_state");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry or persist a rejected single-use authorization code", async () => {
    const { state, cookie } = oauth.newGoogleOAuthState("/en/integrations");
    const fetch = vi.fn(async () => Response.json({ error: "invalid_grant", error_description: "do-not-reflect-this-value" }, { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const response = await callback.GET(callbackRequest(cookie, state.state));
    expectError(response, "google_failed", "/en/integrations");
    expect(response.cookies.get(OAUTH_SESSION_COOKIE)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.headers.get("location")).not.toContain("do-not-reflect");
  });

  it.each([
    [{ success: false }, "google_failed"],
    [{ success: false, unavailable: true }, "auth_unavailable"],
  ] as const)("stops provider traffic when the callback budget is unavailable: %j", async (limit, error) => {
    const { state, cookie } = oauth.newGoogleOAuthState("/en/integrations");
    limiter.check.mockResolvedValue(limit);
    const response = await callback.GET(callbackRequest(cookie, state.state));
    expectError(response, error, "/en/integrations");
    expect(response.cookies.get(OAUTH_SESSION_COOKIE)).toBeUndefined();
    expect(response.cookies.get(oauth.GOOGLE_STATE_COOKIE)?.maxAge).toBe(-1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keys the exchange budget by the trusted Cloudflare client IP, ahead of forwarded input", async () => {
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    providerFixture(await signedToken(state));
    const request = callbackRequest(cookie, state.state);
    request.headers.set("cf-connecting-ip", "198.51.100.42");
    request.headers.set("x-forwarded-for", "192.0.2.1, 192.0.2.2");
    await callback.GET(request);
    expect(limiter.check).toHaveBeenCalledExactlyOnceWith("198.51.100.42");
  });

  it.each([
    ["different state", "other"],
    ["duplicate state", "duplicate"],
    ["missing cookie", "missing"],
    ["tampered cookie", "tampered"],
  ])("rejects %s before exchanging a code", async (_label, mode) => {
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    const request = callbackRequest(mode === "missing" ? undefined : mode === "tampered" ? `${cookie}x` : cookie,
      mode === "other" ? "x".repeat(43) : state.state,
      mode === "duplicate" ? `code=x&state=${state.state}` : "code=x");
    expectError(await callback.GET(request), "invalid_state");
    expect(fetch).not.toHaveBeenCalled();
    expect(limiter.check).not.toHaveBeenCalled();
  });

  it("handles user cancellation and missing/duplicate code without provider calls", async () => {
    const { state, cookie } = oauth.newGoogleOAuthState("/en/integrations");
    expectError(await callback.GET(callbackRequest(cookie, state.state, "error=access_denied")), "google_denied", "/en/integrations");
    expectError(await callback.GET(callbackRequest(cookie, state.state, "error=server_error")), "google_failed", "/en/integrations");
    expectError(await callback.GET(callbackRequest(cookie, state.state, "")), "google_failed", "/en/integrations");
    expectError(await callback.GET(callbackRequest(cookie, state.state, "code=a&code=b")), "google_failed", "/en/integrations");
    expectError(await callback.GET(callbackRequest(cookie, state.state, `code=${"x".repeat(4_097)}`)), "google_failed", "/en/integrations");
    expect(fetch).not.toHaveBeenCalled();
    expect(limiter.check).not.toHaveBeenCalled();
  });

  it("rejects unconfigured or disabled Google login with a safe same-origin error destination", async () => {
    vi.stubEnv("AUTH_GOOGLE_SECRET", "");
    expectError(begin.GET(new NextRequest("https://ghfind.com/api/auth/google?callbackUrl=https://evil.example")), "auth_unavailable");
    expectError(await callback.GET(callbackRequest(undefined, "x".repeat(43))), "auth_unavailable");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "secret");
    vi.stubEnv("GHFIND_OAUTH_ENABLED", "0");
    expectError(begin.GET(new NextRequest("https://ghfind.com/api/auth/google")), "auth_unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps unsafe, expired, malformed and oversized state out of the callback", () => {
    const { state } = oauth.newGoogleOAuthState("https://evil.example");
    expect(state.callback_to).toBe("/");
    expect(oauth.newGoogleOAuthState("/" + "a".repeat(4_000)).state.callback_to).toBe("/");
    for (const changed of [
      { provider: "apple" }, { expires_at: Date.now() - 1 }, { expires_at: Date.now() + 900_000 },
      { expires_at: null }, { verifier: "too-short" }, { nonce: 123 }, { callback_to: "//evil.example" },
    ]) expect(oauth.readGoogleOAuthState(encodeSignedPayload("oidc-state", { ...state, ...changed }))).toBeNull();
    expect(oauth.readGoogleOAuthState(encodeSignedPayload("state", state))).toBeNull();
    expect(oauth.readGoogleOAuthState("x".repeat(8_193))).toBeNull();
  });
});

describe("Google signed identity validation", () => {
  it.each([
    ["issuer", { iss: "https://evil.example" }],
    ["audience", { aud: "other-client" }],
    ["multi-audience", { aud: [CLIENT_ID, "other-client"] }],
    ["authorized presenter", { azp: "other-client" }],
    ["nonce", { nonce: "wrong-nonce" }],
    ["missing nonce", { nonce: undefined }],
    ["expired", { exp: 1 }],
    ["future issued-at", { iat: 9_999_999_999 }],
    ["empty subject", { sub: "" }],
    ["missing subject", { sub: undefined }],
  ])("rejects a valid signature with invalid %s", async (_label, claims) => {
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    providerFixture(await signedToken(state, claims));
    const response = await callback.GET(callbackRequest(cookie, state.state));
    expectError(response, "google_failed");
    expect(response.cookies.get(OAUTH_SESSION_COOKIE)).toBeUndefined();
    expect(response.cookies.get(oauth.GOOGLE_STATE_COOKIE)?.maxAge).toBe(-1);
  });

  it("rejects a JWT signed by another private key", async () => {
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    providerFixture(await signedToken(state, {}, true));
    expectError(await callback.GET(callbackRequest(cookie, state.state)), "google_failed");
  });

  it("accepts Google's documented legacy issuer and normalizes untrusted display fields", async () => {
    const { state } = oauth.newGoogleOAuthState("/");
    providerFixture(await signedToken(state, { iss: "accounts.google.com", azp: CLIENT_ID, name: " \u202eA\nB " + "c".repeat(500), picture: "javascript:alert(1)" }));
    const identity = await oauth.exchangeGoogleCode("code", state);
    expect(identity.name).toHaveLength(128);
    expect(identity.name.startsWith("A B ")).toBe(true);
    expect(identity.image).toBeNull();
  });

  it("drops an image URL whose normalized encoding would exceed the session limit", async () => {
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    const picture = `https://example.test/${"图".repeat(400)}`;
    expect(picture.length).toBeLessThan(2_048);
    expect(new URL(picture).href.length).toBeGreaterThan(2_048);
    providerFixture(await signedToken(state, { picture }));
    const response = await callback.GET(callbackRequest(cookie, state.state));
    expect(readSocialSession(response.cookies.get(OAUTH_SESSION_COOKIE)?.value)?.image).toBeNull();
  });

  it.each(["declared", "streamed"])("bounds %s token responses", async mode => {
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(65_537), {
      headers: mode === "declared" ? { "content-length": "65537" } : {},
    })));
    expectError(await callback.GET(callbackRequest(cookie, state.state)), "google_failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds certificate responses and treats network failure as a fixed public error", async () => {
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    const token = await signedToken(state);
    vi.stubGlobal("fetch", vi.fn(async input => String(input) === TOKEN_URL
      ? Response.json({ id_token: token }) : new Response("x".repeat(65_537))));
    expectError(await callback.GET(callbackRequest(cookie, state.state)), "google_failed");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret-provider-response"); }));
    expectError(await callback.GET(callbackRequest(cookie, state.state)), "google_failed");
  });
});

describe("safe Google failure diagnostics", () => {
  it("does not serialize an unknown error or attacker-controlled classification fields", async () => {
    const malicious = Object.assign(new Error("secret-token-and-personal-data"), {
      stage: "secret-stage", reason: "secret-reason", code: "secret-code", status: 12345,
    });
    expect(oauth.googleOAuthFailureDetails(malicious)).toEqual({ stage: "unknown", reason: "unexpected_error" });
    limiter.check.mockRejectedValue(malicious);
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    expectError(await callback.GET(callbackRequest(cookie, state.state)), "google_failed");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("oauth_google_failed", { stage: "rate_limit", reason: "unexpected_error" });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("secret");
  });

  it("classifies token HTTP failures without reading or forwarding provider errors", async () => {
    const { state, cookie } = oauth.newGoogleOAuthState("/");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "secret-provider-body" }, { status: 400 })));
    expectError(await callback.GET(callbackRequest(cookie, state.state)), "google_failed");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("oauth_google_failed", {
      stage: "token_exchange", reason: "http_error", status: 400,
    });
  });

  it("distinguishes token response parsing and identity verification failures safely", async () => {
    const { state } = oauth.newGoogleOAuthState("/");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json-secret")));
    const parseError = await oauth.exchangeGoogleCode("code", state).catch(error => error);
    expect(oauth.googleOAuthFailureDetails(parseError)).toEqual({ stage: "token_response", reason: "invalid_json" });
    providerFixture(await signedToken(state, { nonce: "incorrect" }));
    const identityError = await oauth.exchangeGoogleCode("different-code", state).catch(error => error);
    expect(oauth.googleOAuthFailureDetails(identityError)).toEqual({ stage: "identity", reason: "nonce_mismatch" });
  });

  it.each(["token", "jwks"])("rejects %s redirects without following them", async endpoint => {
    const { state } = oauth.newGoogleOAuthState("/");
    const token = await signedToken(state);
    const fetch = vi.fn(async (url, options) => {
      expect(options.redirect).toBe("manual");
      if (endpoint === "jwks" && String(url) === TOKEN_URL) return Response.json({ id_token: token });
      return new Response("provider-body-must-not-appear", { status: 302, headers: { Location: "https://untrusted.example/" } });
    });
    vi.stubGlobal("fetch", fetch);
    const error = await oauth.exchangeGoogleCode("code", state).catch(error => error);
    expect(oauth.googleOAuthFailureDetails(error)).toEqual({
      stage: endpoint === "token" ? "token_exchange" : "jwks_fetch", reason: "http_error", status: 302,
    });
    expect(fetch).toHaveBeenCalledTimes(endpoint === "token" ? 1 : 2);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("untrusted"))).toBe(true);
  });
});

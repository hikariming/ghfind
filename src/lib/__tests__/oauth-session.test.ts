import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeSignedPayload,
  encodeSignedPayload,
  newOAuthState,
  readOAuthState,
  safeOAuthCallback,
  type OAuthSession,
} from "@/lib/oauth-session";

describe("oauth session signing (Go wire-format compatibility)", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "test-secret");
  });

  it("round-trips a session payload", () => {
    const session: OAuthSession = {
      github_id: 42,
      login: "octocat",
      avatar_url: "https://a.example/x.png",
      expires_at: Date.now() + 60_000,
    };
    const encoded = encodeSignedPayload("session", session);
    expect(decodeSignedPayload<OAuthSession>("session", encoded)).toEqual(session);
  });

  it("matches the Go signature scheme byte-for-byte", () => {
    // Fixed vector: base64url(JSON) + "." + base64url(HMAC_SHA256(secret,
    // "ghfind:oauth:session:" + encoded)). Computed independently of the
    // implementation so a refactor cannot silently change the wire format
    // (Go-issued ghfind_session cookies must stay valid).
    const payload = { github_id: 1, login: "a", expires_at: 2 };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", "test-secret")
      .update(`ghfind:oauth:session:${encodedPayload}`)
      .digest("base64url");
    expect(encodeSignedPayload("session", payload)).toBe(`${encodedPayload}.${sig}`);
  });

  it("rejects tampered payloads and wrong kinds", () => {
    const encoded = encodeSignedPayload("session", { github_id: 1, login: "a", expires_at: 9 });
    const [body, sig] = encoded.split(".");
    expect(decodeSignedPayload("session", `${body}x.${sig}`)).toBeNull();
    expect(decodeSignedPayload("state", encoded)).toBeNull();
    expect(decodeSignedPayload("session", body)).toBeNull();
  });

  it("expires state and requires nonce/callback", () => {
    const live = newOAuthState("/u/octocat");
    expect(readOAuthState(live)?.callback_to).toBe("/u/octocat");
    const expired = encodeSignedPayload("state", {
      nonce: "n",
      expires_at: Date.now() - 1,
      callback_to: "/",
    });
    expect(readOAuthState(expired)).toBeNull();
  });
});

describe("safeOAuthCallback", () => {
  const origin = "https://ghfind.com";

  it("keeps same-origin absolute urls as path+query", () => {
    expect(safeOAuthCallback("https://ghfind.com/u/x?a=1", origin)).toBe("/u/x?a=1");
  });

  it("rejects cross-origin, protocol-relative and non-rooted values", () => {
    expect(safeOAuthCallback("https://evil.example/u/x", origin)).toBe("/");
    expect(safeOAuthCallback("//evil.example/x", origin)).toBe("/");
    expect(safeOAuthCallback("u/x", origin)).toBe("/");
    expect(safeOAuthCallback("javascript:alert(1)", origin)).toBe("/");
    expect(safeOAuthCallback(null, origin)).toBe("/");
  });

  it("keeps rooted relative paths", () => {
    expect(safeOAuthCallback("/leaderboard?view=score", origin)).toBe("/leaderboard?view=score");
  });
});

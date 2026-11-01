import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeSignedPayload, OAUTH_SESSION_COOKIE, readGitHubSession } from "@/lib/oauth-session";
import { configuredOAuthProviders, encodeSocialSession, readSocialSession, type SocialSession } from "@/lib/social-session";

const { score, cookieGet } = vi.hoisted(() => ({ score: vi.fn(), cookieGet: vi.fn() }));
vi.mock("@/lib/db", () => ({ hasCanonicalPublicScore: score }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: cookieGet }) }));
import { auth } from "@/lib/auth";
import { GET as me } from "@/app/api/me/route";
import { POST as signout } from "@/app/api/auth/signout/route";

function request(value?: string) {
  return new NextRequest("https://ghfind.com/api/me", {
    headers: value ? { cookie: `${OAUTH_SESSION_COOKIE}=${value}` } : {},
  });
}
function session(): SocialSession {
  return { provider: "google", subject: "google-123", name: "Someone", image: null, expires_at: Date.now() + 60_000 };
}

describe("provider identity boundaries", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "test-secret");
    vi.stubEnv("AUTH_GOOGLE_ID", "google-client");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "google-secret");
    vi.stubEnv("AUTH_GITHUB_ID", "github-client");
    vi.stubEnv("AUTH_GITHUB_SECRET", "github-secret");
    vi.stubEnv("GHFIND_OAUTH_ENABLED", "1");
    score.mockReset().mockResolvedValue(true);
    cookieGet.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("advertises only configured providers at runtime", () => {
    expect(configuredOAuthProviders()).toEqual({ github: true, google: true, apple: false });
    vi.stubEnv("AUTH_GOOGLE_SECRET", "");
    expect(configuredOAuthProviders().google).toBe(false);
    vi.stubEnv("GHFIND_OAUTH_ENABLED", "0");
    expect(configuredOAuthProviders()).toEqual({ github: false, google: false, apple: false });
  });

  it("recognizes Google without granting GitHub identity, score or privileges", async () => {
    const identity = session();
    const value = encodeSocialSession(identity);
    cookieGet.mockReturnValue({ value });
    expect(readSocialSession(value)).toEqual(identity);
    expect(readGitHubSession(value)).toBeNull();
    expect(await auth()).toBeNull();
    const response = await me(request(value));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      user: null, scored: false, oauth: true,
      account: { provider: "google", subject: "google-123", name: "Someone" },
      providers: { github: true, google: true, apple: false },
    });
    expect(score).not.toHaveBeenCalled();
  });

  it("keeps legacy GitHub sessions and me.user compatible", async () => {
    const value = encodeSignedPayload("session", { github_id: 42, login: "octocat", expires_at: Date.now() + 60_000 });
    cookieGet.mockReturnValue({ value });
    expect(readSocialSession(value)).toBeNull();
    expect(await auth()).toEqual({ user: { githubId: 42, login: "octocat", image: null } });
    expect(await (await me(request(value))).json()).toMatchObject({
      user: { login: "octocat", image: null }, scored: true,
      account: { provider: "github", subject: "42", name: "octocat" },
    });
    expect(score).toHaveBeenCalledWith("octocat");
  });

  it("rejects malformed, expired and tampered social identities", async () => {
    for (const change of [
      { provider: "github" }, { subject: "" }, { subject: 1 },
      { name: "" }, { expires_at: "9999999999999" }, { expires_at: Date.now() - 1 },
      { image: "javascript:alert(1)" }, { image: "https://user:password@example.com/avatar" },
    ]) {
      const value = encodeSignedPayload("social-session", { ...session(), ...change });
      expect(readSocialSession(value)).toBeNull();
      expect(await (await me(request(value))).json()).toMatchObject({ user: null, account: null });
    }
    expect(readSocialSession(`${encodeSocialSession(session())}x`)).toBeNull();
  });

  it("signout clears the shared provider session cookie", async () => {
    const response = signout(request(encodeSocialSession(session())));
    expect(await response.json()).toEqual({ ok: true });
    const cookie = response.cookies.get(OAUTH_SESSION_COOKIE);
    expect(cookie).toMatchObject({ value: "", maxAge: -1, httpOnly: true, secure: true, sameSite: "lax" });
  });
});

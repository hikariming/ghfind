import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), createApiToken: vi.fn(), listApiTokens: vi.fn(), revokeApiToken: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/api-tokens", () => ({
  ApiTokenScopesUnavailableError: class ApiTokenScopesUnavailableError extends Error {},
  OPTIONAL_API_TOKEN_SCOPES: ["bot"],
  createApiToken: mocks.createApiToken,
  listApiTokens: mocks.listApiTokens,
  revokeApiToken: mocks.revokeApiToken,
  MAX_ACTIVE_API_TOKENS: 10,
}));

import { ApiTokenScopesUnavailableError } from "@/lib/api-tokens";
import { GET, POST } from "./route";

const session = { user: { githubId: 73, login: "octocat", image: null } };

function request(method: string, body?: unknown, origin = "https://ghfind.test") {
  return new NextRequest("https://ghfind.test/api/account/tokens", {
    method,
    headers: { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("account API tokens", () => {
  afterEach(() => vi.resetAllMocks());

  it("requires a website session before listing tokens", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.listApiTokens).not.toHaveBeenCalled();
  });

  it("requires same-origin requests and validates token names", async () => {
    mocks.auth.mockResolvedValue(session);
    expect((await POST(request("POST", { name: "automation" }, "https://attacker.test"))).status).toBe(403);
    expect((await POST(request("POST", { name: "bad\nname" }))).status).toBe(400);
    expect(mocks.createApiToken).not.toHaveBeenCalled();
  });

  it("returns a new secret only with the successful creation response", async () => {
    mocks.auth.mockResolvedValue(session);
    mocks.createApiToken.mockResolvedValue({ token: "ghf_secret", record: { id: "id", name: "agent", prefix: "ghf_secret", scopes: ["scan"], createdAt: 1, lastUsedAt: null } });
    const response = await POST(request("POST", { name: " agent " }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ token: "ghf_secret", record: { name: "agent", scopes: ["scan"] } });
    expect(mocks.createApiToken).toHaveBeenCalledWith(73, "agent", ["scan"]);
  });

  it("creates a bot-scoped token only when the bot scope is requested", async () => {
    mocks.auth.mockResolvedValue(session);
    mocks.createApiToken.mockResolvedValue({ token: "ghf_secret", record: { id: "id", name: "bot", prefix: "ghf_secret", scopes: ["scan", "bot"], createdAt: 1, lastUsedAt: null } });
    const response = await POST(request("POST", { name: "bot", scopes: ["bot"] }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ record: { scopes: ["scan", "bot"] } });
    expect(mocks.createApiToken).toHaveBeenCalledWith(73, "bot", ["scan", "bot"]);
    mocks.createApiToken.mockClear();
    expect((await POST(request("POST", { name: "none", scopes: [] }))).status).toBe(201);
    expect(mocks.createApiToken).toHaveBeenCalledWith(73, "none", ["scan"]);
  });

  it("rejects unknown, duplicated or malformed scopes", async () => {
    mocks.auth.mockResolvedValue(session);
    for (const scopes of ["bot", ["admin"], ["scan"], ["bot", "bot"], [1], { bot: true }, null]) {
      const response = await POST(request("POST", { name: "agent", scopes }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_scopes" });
    }
    expect((await POST(request("POST", null))).status).toBe(400);
    expect((await POST(request("POST", ["bot"]))).status).toBe(400);
    expect(mocks.createApiToken).not.toHaveBeenCalled();
  });

  it("reports when scoped tokens cannot be stored yet", async () => {
    mocks.auth.mockResolvedValue(session);
    mocks.createApiToken.mockRejectedValue(new ApiTokenScopesUnavailableError());
    const response = await POST(request("POST", { name: "bot", scopes: ["bot"] }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "token_scopes_unavailable" });
  });

  it("lists tokens with their scopes", async () => {
    mocks.auth.mockResolvedValue(session);
    const tokens = [{ id: "a", name: "bot", prefix: "ghf_a", scopes: ["scan", "bot"], createdAt: 2, lastUsedAt: null }];
    mocks.listApiTokens.mockResolvedValue(tokens);
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tokens });
  });
});

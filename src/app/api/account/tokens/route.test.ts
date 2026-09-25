import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), createApiToken: vi.fn(), listApiTokens: vi.fn(), revokeApiToken: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/api-tokens", () => ({
  createApiToken: mocks.createApiToken,
  listApiTokens: mocks.listApiTokens,
  revokeApiToken: mocks.revokeApiToken,
  MAX_ACTIVE_API_TOKENS: 10,
}));

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
    mocks.createApiToken.mockResolvedValue({ token: "ghf_secret", record: { id: "id", name: "agent", prefix: "ghf_secret", createdAt: 1, lastUsedAt: null } });
    const response = await POST(request("POST", { name: " agent " }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ token: "ghf_secret", record: { name: "agent" } });
    expect(mocks.createApiToken).toHaveBeenCalledWith(73, "agent");
  });
});

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticateApiTokenScopes: vi.fn() }));
vi.mock("@/lib/api-tokens", () => ({ authenticateApiTokenScopes: mocks.authenticateApiTokenScopes }));

import { GET } from "./route";

function request(authorization?: string) {
  return new NextRequest("https://ghfind.test/api/account/whoami", {
    headers: authorization ? { authorization } : {},
  });
}

describe("account whoami", () => {
  afterEach(() => vi.resetAllMocks());

  it("rejects requests without a bearer token", async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("Basic abc"))).status).toBe(401);
    expect(mocks.authenticateApiTokenScopes).not.toHaveBeenCalled();
  });

  it("returns the GitHub account and scopes behind a personal token", async () => {
    mocks.authenticateApiTokenScopes.mockResolvedValue({ githubId: 73, scopes: ["scan", "bot"] });
    const response = await GET(request("Bearer ghf_secret"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ github_id: 73, scopes: ["scan", "bot"] });
    expect(mocks.authenticateApiTokenScopes).toHaveBeenCalledWith("ghf_secret");
  });

  it("reports a scan-only token as such", async () => {
    mocks.authenticateApiTokenScopes.mockResolvedValue({ githubId: 73, scopes: ["scan"] });
    await expect((await GET(request("Bearer ghf_secret"))).json()).resolves.toEqual({ github_id: 73, scopes: ["scan"] });
  });

  it("separates revoked tokens from storage outages", async () => {
    mocks.authenticateApiTokenScopes.mockResolvedValue(null);
    expect((await GET(request("Bearer ghf_revoked"))).status).toBe(401);
    mocks.authenticateApiTokenScopes.mockRejectedValue(new Error("down"));
    expect((await GET(request("Bearer ghf_secret"))).status).toBe(503);
  });
});

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), revokeApiToken: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/api-tokens", () => ({ revokeApiToken: mocks.revokeApiToken }));

import { DELETE } from "./route";

describe("DELETE /api/account/tokens/:id", () => {
  afterEach(() => vi.resetAllMocks());

  it("requires a same-origin signed-in request and revokes only for that account", async () => {
    const request = new NextRequest("https://ghfind.test/api/account/tokens/00000000-0000-4000-8000-000000000000", {
      method: "DELETE",
      headers: { origin: "https://ghfind.test" },
    });
    mocks.auth.mockResolvedValue({ user: { githubId: 73, login: "octocat", image: null } });
    mocks.revokeApiToken.mockResolvedValue(true);
    const response = await DELETE(request, { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true });
    expect(mocks.revokeApiToken).toHaveBeenCalledWith(73, "00000000-0000-4000-8000-000000000000");
  });
});

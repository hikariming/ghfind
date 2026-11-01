import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const authenticateApiToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-tokens", () => ({ authenticateApiToken }));
import { machineAuth } from "@/lib/machine-auth";

describe("machine API authentication", () => {
  afterEach(() => {
    delete process.env.GITHUB_ROAST_CLI_API_KEY;
    vi.resetAllMocks();
  });

  it("accepts the existing deployment key and personal tokens", async () => {
    process.env.GITHUB_ROAST_CLI_API_KEY = "shared-secret";
    expect(await machineAuth(new NextRequest("https://ghfind.test", { headers: { authorization: "Bearer shared-secret" } }))).toBe("valid");
    authenticateApiToken.mockResolvedValue(73);
    expect(await machineAuth(new NextRequest("https://ghfind.test", { headers: { authorization: "Bearer ghf_personal" } }))).toBe("valid");
  });

  it("rejects malformed and unknown credentials but preserves absent auth", async () => {
    expect(await machineAuth(new NextRequest("https://ghfind.test"))).toBe("absent");
    expect(await machineAuth(new NextRequest("https://ghfind.test", { headers: { authorization: "Basic abc" } }))).toBe("invalid");
    authenticateApiToken.mockResolvedValue(null);
    expect(await machineAuth(new NextRequest("https://ghfind.test", { headers: { authorization: "Bearer ghf_personal" } }))).toBe("invalid");
  });
});

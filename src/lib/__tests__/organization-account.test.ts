import { afterEach, describe, expect, it, vi } from "vitest";
import { collect, OrganizationNotSupportedError } from "../github";
import { scanErrorResponse, logFreshScanFailure } from "../scan-core";
import { apiError } from "../api-error";

const originalToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub organization scoring", () => {
  it("rejects an organization after the profile lookup, without attempting GraphQL", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ login: "example-org", id: 123, type: "Organization" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect("example-org")).rejects.toBeInstanceOf(OrganizationNotSupportedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/users/example-org");
  });

  it("returns a client error with the same machine-readable code and an explanation", async () => {
    const err = new OrganizationNotSupportedError();
    expect(scanErrorResponse(err)).toEqual({
      error: "organization_not_supported",
      status: 422,
    });
    const response = apiError("organization_not_supported", { status: 422 });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "organization_not_supported",
      hint: expect.stringContaining("GitHub organization"),
    });
  });

  it("logs a static category without leaking upstream details", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logFreshScanFailure(new OrganizationNotSupportedError("private details"), {
      route: "scan", username: "example-org", persistenceFailure: false,
    });
    expect(log).toHaveBeenCalledWith("fresh_scan_failed", {
      route: "scan", username: "example-org", category: "organization_not_supported",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private details");
  });
});

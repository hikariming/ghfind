import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSiteUrl } from "../site";

const production = {
  VERCEL_ENV: "production",
  NEXT_PUBLIC_SITE_URL: "https://ghfind.com",
  PUBLIC_SITE_URL: "https://ghfind.com",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("public site origin", () => {
  it("normalizes the matching Vercel production origin", () => {
    expect(
      resolveSiteUrl({
        ...production,
        NEXT_PUBLIC_SITE_URL: "https://ghfind.com/",
      }),
    ).toBe("https://ghfind.com");
  });

  it("permits an explicit local origin outside production", () => {
    expect(
      resolveSiteUrl({
        VERCEL_ENV: "preview",
        NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      }),
    ).toBe("http://localhost:3000");
  });

  it.each([
    ["missing public setting", { ...production, PUBLIC_SITE_URL: undefined }],
    ["empty public setting", { ...production, PUBLIC_SITE_URL: " " }],
    ["localhost", { ...production, NEXT_PUBLIC_SITE_URL: "http://localhost:3000", PUBLIC_SITE_URL: "http://localhost:3000" }],
    ["http", { ...production, NEXT_PUBLIC_SITE_URL: "http://ghfind.com", PUBLIC_SITE_URL: "http://ghfind.com" }],
    ["malformed", { ...production, NEXT_PUBLIC_SITE_URL: "not-a-url", PUBLIC_SITE_URL: "not-a-url" }],
    ["mismatched", { ...production, PUBLIC_SITE_URL: "https://www.ghfind.com" }],
  ])("rejects %s in Vercel production", (_name, environment) => {
    expect(() => resolveSiteUrl(environment)).toThrow();
  });

  it("fails while evaluating the production site module", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    vi.stubEnv("PUBLIC_SITE_URL", "http://localhost:3000");
    vi.resetModules();

    await expect(import("../site")).rejects.toThrow("Vercel production site URL must be a non-local HTTPS origin");
  });
});

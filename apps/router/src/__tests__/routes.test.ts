import { describe, expect, it } from "vitest";
import { pickTarget } from "../routes";

describe("pickTarget", () => {
  it("serves migrated pages from web in every locale", () => {
    expect(pickTarget("/about")).toBe("web");
    expect(pickTarget("/en/about")).toBe("web");
    expect(pickTarget("/zh/about")).toBe("web");
    expect(pickTarget("/ar/about")).toBe("web");
  });

  it("serves Astro build assets from web", () => {
    expect(pickTarget("/_astro/index.abc123.js")).toBe("web");
  });

  it("serves migrated API routes from api, by whole path only", () => {
    for (const p of ["/api/leaderboard", "/api/stats", "/api/search-users", "/api/developers", "/api/talent", "/api/sponsors", "/api/facet-rank/torvalds", "/api/campaigns/advx/leaderboard"]) {
      expect(pickTarget(p)).toBe("api");
    }
    for (const p of ["/api/talent/123", "/api/campaigns/advx/leaderboard/events", "/api/leaderboard/x", "/api/facet-rank", "/api/score/torvalds", "/api/me", "/api/does-not-exist", "/en/api/stats"]) {
      expect(pickTarget(p)).toBe("legacy");
    }
  });

  it("keeps everything else on legacy", () => {
    for (const p of ["/", "/en", "/about/team", "/aboutx", "/u/torvalds", "/api/badge/x", "/_next/static/x.js", "/favicon.ico", "/mcp"]) {
      expect(pickTarget(p)).toBe("legacy");
    }
  });
});

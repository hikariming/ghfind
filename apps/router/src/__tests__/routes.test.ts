import { describe, expect, it } from "vitest";
import { pickTarget } from "../routes";

describe("pickTarget", () => {
  it("serves migrated pages from web in every locale", () => {
    expect(pickTarget("/about")).toBe("web");
    expect(pickTarget("/en/about")).toBe("web");
    expect(pickTarget("/zh/about")).toBe("web");
    expect(pickTarget("/ar/about")).toBe("web");
  });

  it("serves the P2 content pages from web in every locale", () => {
    for (const p of ["/blog", "/en/blog", "/ja/blog/who-builds-dify", "/blog/who-builds-dify", "/collections", "/ar/collections", "/en/collections/bojie-li",
      "/contact", "/en/privacy", "/ja/methodology", "/docs", "/ko/github-bot", "/sponsor"]) {
      expect(pickTarget(p)).toBe("web");
    }
  });

  it("serves the P3/P4 data and account pages from web", () => {
    for (const p of ["/talent", "/en/resume", "/following", "/ja/integrations", "/projects/analyses/abc-123", "/en/projects/analyses/x",
      "/vs", "/en/developers", "/leaderboard", "/ar/advx", "/projects", "/", "/en", "/ja",
      "/vs/a/b", "/en/vs/gaearon/torvalds", "/developers/language/Rust", "/developers/language/C%2B%2B",
      "/ja/developers/repo/langgenius/dify", "/developers/org/vercel", "/u/torvalds", "/en/u/gaearon"]) {
      expect(pickTarget(p)).toBe("web");
    }
  });

  it("serves machine-readable documents and the MCP server from api", () => {
    for (const p of ["/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/llms.md", "/openapi.json", "/auth.md", "/index.md", "/mcp",
      "/.well-known/agent-card.json", "/.well-known/agent-skills/index.json", "/.well-known/api-catalog", "/.well-known/mcp/server-card.json",
      "/.well-known/oauth-protected-resource", "/blog/who-builds-dify.md", "/en/blog/x.md", "/cli", "/en/cli", "/skill", "/ja/skill"]) {
      expect(pickTarget(p)).toBe("api");
    }
    for (const p of ["/mcp/x", "/.well-known/other", "/xx/cli", "/cli/x", "/robots.txtx"]) {
      expect(pickTarget(p)).not.toBe("api");
    }
  });

  it("serves public/ files from web", () => {
    for (const p of ["/favicon.ico", "/icon.svg", "/fonts/dm-sans-variable.ttf", "/install.sh", "/cli.md", "/skill.md", "/tier-emoji/crown.svg", "/github-bot/avatar.png"]) {
      expect(pickTarget(p)).toBe("web");
    }
    // A missing file gets web's 404 page.
    expect(pickTarget("/fonts/missing.ttf")).toBe("web");
  });

  it("serves Astro build assets from web", () => {
    expect(pickTarget("/_astro/index.abc123.js")).toBe("web");
  });

  it("serves migrated API routes from api, by whole path only", () => {
    for (const p of ["/api/leaderboard", "/api/stats", "/api/search-users", "/api/developers", "/api/talent", "/api/sponsors", "/api/facet-rank/torvalds", "/api/campaigns/advx/leaderboard"]) {
      expect(pickTarget(p)).toBe("api");
    }
    for (const p of ["/api/talent/123/x", "/api/campaigns/advx/leaderboard/events/x", "/api/leaderboard/x", "/api/facet-rank", "/api/does-not-exist"]) {
      expect(pickTarget(p)).toBe("legacy");
    }
  });

  it("serves the image endpoints from api, by whole path only", () => {
    for (const p of ["/api/badge/torvalds", "/api/card/mini/torvalds", "/api/material-card/torvalds", "/api/card/torvalds", "/api/card/vs/a/b", "/api/og/home", "/api/og/blog/x"]) {
      expect(pickTarget(p)).toBe("api");
    }
    // Like Next, a bare /api/card/mini is the card of a user named "mini".
    expect(pickTarget("/api/card/mini")).toBe("api");
    for (const p of ["/api/card/vs/a", "/api/card/vs/a/b/c", "/api/og", "/api/og/other", "/api/og/blog/x/y", "/api/badge/a/b"]) {
      expect(pickTarget(p)).toBe("legacy");
    }
  });

  it("serves the auth and account routes from api, by whole path only", () => {
    for (const p of ["/api/auth/github", "/api/auth/callback/github", "/api/auth/signout", "/api/me", "/api/account/tokens", "/api/account/tokens/0b1c2d3e-0000-4000-8000-000000000000"]) {
      expect(pickTarget(p)).toBe("api");
    }
    for (const p of ["/api/auth", "/api/auth/gitlab", "/api/auth/callback/gitlab", "/api/me/x", "/api/account", "/api/account/tokens/a/b"]) {
      expect(pickTarget(p)).toBe("legacy");
    }
  });

  it("serves the social, resume and API index routes from api, by whole path only", () => {
    for (const p of ["/api", "/api/blog-comments/who-builds-dify", "/api/collection-comments/x", "/api/profile-comments/torvalds", "/api/profile-reactions/torvalds", "/api/follows", "/api/follows/torvalds", "/api/resumes", "/api/talent/123"]) {
      expect(pickTarget(p)).toBe("api");
    }
    for (const p of ["/api/", "/api/blog-comments", "/api/follows/a/b", "/api/resumes/1", "/api/profile-reactions"]) {
      expect(pickTarget(p)).toBe("legacy");
    }
  });

  it("serves scoring, scans, LLM and job routes from api; Feed stays on legacy", () => {
    for (const p of ["/api/score/torvalds", "/api/scan", "/api/roast", "/api/vs-verdict", "/api/project-analyses", "/api/project-analyses/abc", "/api/campaigns/advx/leaderboard/events", "/api/profile/backfill", "/api/admin/backfill-facets", "/api/admin/backfill-scores", "/api/internal/project-analyses/reconcile"]) {
      expect(pickTarget(p)).toBe("api");
    }
    for (const p of ["/api/feed/projects", "/api/feed/events", "/api/internal/feed/reconcile", "/api/admin/backfill-other", "/api/scan/x", "/api/score", "/api/profile"]) {
      expect(pickTarget(p)).toBe("legacy");
    }
  });

  it("serves unknown pages from web, which renders the 404 page", () => {
    for (const p of ["/about/team", "/aboutx", "/blog/a/b", "/en/collectionsx", "/vs/a/b/c", "/developers/repo/vercel/next.js",
      "/u/a/b", "/blog-md/x", "/ja/blog/x.md", "/does-not-exist", "/en/api", "/en/api/stats"]) {
      expect(pickTarget(p)).toBe("web");
    }
  });

  it("keeps Next build assets and unmigrated API routes on legacy", () => {
    for (const p of ["/_next/static/x.js", "/_next/image", "/api/score/x/y"]) {
      expect(pickTarget(p)).toBe("legacy");
    }
  });
});

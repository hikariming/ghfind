import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GO_REWRITE_SOURCES = [
  "/api/stats",
  "/api/search-users",
  "/api/leaderboard",
  "/api/developers",
  "/api/projects",
  "/api/projects/:path*",
  "/api/feed/:path*",
  "/api/profile/:path*",
  "/api/embed/:path*",
  "/api/sitemap",
  "/api/facet-rank/:path*",
  "/api/score/:path*",
  "/api/vs/:path*",
  "/api/campaigns/:path*",
  "/api/scan/jobs/:path*",
  "/api/scan",
  "/api/roast",
  "/api/project-analyses",
  "/api/project-analyses/:path*",
  "/api/me",
  "/api/auth/:path*",
  "/api/follows",
  "/api/follows/:path*",
  "/api/profile-comments/:path*",
  "/api/profile-reactions/:path*",
  "/api/blog-comments/:path*",
  "/api/collection-comments/:path*",
  "/api/internal/:path*",
  "/api/admin/:path*",
  "/mcp",
];

const NEXT_API_GUARDS = new Set([
  "src/app/api/auth/[...nextauth]/route.ts",
  "src/app/api/blog-comments/[slug]/route.ts",
  "src/app/api/campaigns/[campaign]/leaderboard/events/route.ts",
  "src/app/api/campaigns/[campaign]/leaderboard/route.ts",
  "src/app/api/collection-comments/[slug]/route.ts",
  "src/app/api/developers/route.ts",
  "src/app/api/facet-rank/[username]/route.ts",
  "src/app/api/follows/[username]/route.ts",
  "src/app/api/follows/route.ts",
  "src/app/api/leaderboard/route.ts",
  "src/app/api/me/route.ts",
  "src/app/api/profile-comments/[username]/route.ts",
  "src/app/api/profile-reactions/[username]/route.ts",
  "src/app/api/roast/route.ts",
  "src/app/api/scan/jobs/[id]/route.ts",
  "src/app/api/scan/route.ts",
  "src/app/api/score/[username]/route.ts",
  "src/app/api/search-users/route.ts",
  "src/app/api/stats/route.ts",
]);

const REVIEWED_NEXT_API_ROUTES = new Set([
  ...NEXT_API_GUARDS,
  "src/app/api/[...notFound]/route.ts",
  "src/app/api/badge/[username]/route.ts",
  "src/app/api/card/[username]/route.tsx",
  "src/app/api/card/mini/[username]/route.ts",
  "src/app/api/card/vs/[a]/[b]/route.tsx",
  "src/app/api/internal/project-analyses/reconcile/route.ts",
  "src/app/api/material-card/[username]/route.tsx",
  "src/app/api/og/blog/[slug]/route.tsx",
  "src/app/api/og/home/route.tsx",
  "src/app/api/project-analyses/[id]/route.ts",
  "src/app/api/project-analyses/route.ts",
  "src/app/api/route.ts",
  "src/app/api/vs-verdict/route.ts",
]);

function collectRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const file = path.join(dir, entry);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      files.push(...collectRouteFiles(file));
      continue;
    }
    if (/\/route\.tsx?$/.test(file)) files.push(file);
  }
  return files.map((file) => file.split(path.sep).join("/"));
}

describe("backend route ownership", () => {
  it("rewrites every Go-owned same-origin route to the backend origin", () => {
    const config = readFileSync("next.config.ts", "utf8");

    expect(config).toContain("beforeFiles:");
    expect(config).toContain("these rewrites must win");
    for (const source of GO_REWRITE_SOURCES) {
      expect(config, `missing rewrite for ${source}`).toContain(`source: "${source}"`);
    }
  });

  it("keeps Go-owned Next fallbacks as fail-closed guards", () => {
    for (const file of NEXT_API_GUARDS) {
      const source = readFileSync(file, "utf8");

      expect(source, `${file} must fail closed`).toContain("backend_not_configured");
      expect(source, `${file} must avoid cacheable failures`).toContain('"Cache-Control": "no-store"');
      expect(source, `${file} must tell clients to retry after backend cutover fixes`).toContain('"Retry-After": "15"');
      expect(source, `${file} must not proxy or execute business work`).not.toContain("fetch(");
    }
  });

  it("requires every Next API route to be explicitly classified", () => {
    const routes = collectRouteFiles("src/app/api");
    const unreviewed = routes.filter((file) => !REVIEWED_NEXT_API_ROUTES.has(file));

    expect(unreviewed).toEqual([]);
  });
});

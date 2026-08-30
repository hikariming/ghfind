import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Post-repatriation route registry (阶段2 complete, 2026-08-29). The Go
 * backend extraction is fully reversed: every API surface is served in-app on
 * Cloudflare Workers, and next.config.ts carries no backend-origin rewrites.
 * The registry keeps the old discipline — a new route file must be reviewed
 * and listed here, so nothing ships as an unclassified public surface.
 */
const REVIEWED_NEXT_API_ROUTES = new Set([
  "src/app/api/[...notFound]/route.ts",
  "src/app/api/badge/[username]/route.ts",
  "src/app/api/auth/github/route.ts",
  "src/app/api/auth/callback/github/route.ts",
  "src/app/api/auth/signout/route.ts",
  "src/app/api/me/route.ts",
  "src/app/api/roast/route.ts",
  "src/app/api/scan/route.ts",
  "src/app/api/blog-comments/[slug]/route.ts",
  "src/app/api/campaigns/[campaign]/leaderboard/route.ts",
  "src/app/api/campaigns/[campaign]/leaderboard/events/route.ts",
  "src/app/api/collection-comments/[slug]/route.ts",
  "src/app/api/follows/route.ts",
  "src/app/api/follows/[username]/route.ts",
  "src/app/api/profile-comments/[username]/route.ts",
  "src/app/api/profile-reactions/[username]/route.ts",
  "src/app/api/developers/route.ts",
  "src/app/api/facet-rank/[username]/route.ts",
  "src/app/api/leaderboard/route.ts",
  "src/app/api/score/[username]/route.ts",
  "src/app/api/search-users/route.ts",
  "src/app/api/stats/route.ts",
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
  // 阶段2 B5c (2026-08-29): admin backfills repatriated from Go.
  "src/app/api/admin/backfill-facets/route.ts",
  "src/app/api/admin/backfill-profiles/route.ts",
  "src/app/api/admin/backfill-repos/route.ts",
  "src/app/api/admin/backfill-scores/route.ts",
  "src/app/api/profile/backfill/route.ts",
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
  it("carries no backend-origin rewrites after the repatriation", () => {
    const config = readFileSync("next.config.ts", "utf8");

    expect(config).not.toContain("beforeFiles");
    expect(config).not.toContain("GHFIND_BACKEND_ORIGIN");
  });

  it("requires every Next API route to be explicitly classified", () => {
    const routes = collectRouteFiles("src/app/api");
    const unreviewed = routes.filter((file) => !REVIEWED_NEXT_API_ROUTES.has(file));

    expect(unreviewed).toEqual([]);
  });
});

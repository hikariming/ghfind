/**
 * Route modules served by this Worker. Each is the Next app's own route module
 * under src/app/api — the same handler code runs on both stacks until the Next
 * app is retired (P5). Every exported HTTP method is mounted (index.ts).
 *
 * Batches: 1 read-only JSON, 2 README/social images, 3 auth and account,
 * 4 social (comments, reactions, follows) and resumes, 5 scoring, scans,
 * LLM roasts/verdicts, project analyses and admin/internal jobs.
 */
import * as mcp from "./mcp";
import * as sitemap from "./sitemap";
import * as agentCard from "@/app/.well-known/agent-card.json/route";
import * as agentSkills from "@/app/.well-known/agent-skills/index.json/route";
import * as apiCatalog from "@/app/.well-known/api-catalog/route";
import * as mcpServerCard from "@/app/.well-known/mcp/server-card.json/route";
import * as oauthProtectedResource from "@/app/.well-known/oauth-protected-resource/route";
import * as cliDoc from "@/app/[locale]/cli/route";
import * as skillDoc from "@/app/[locale]/skill/route";
import * as accountToken from "@/app/api/account/tokens/[id]/route";
import * as accountTokens from "@/app/api/account/tokens/route";
import * as adminBackfillFacets from "@/app/api/admin/backfill-facets/route";
import * as adminBackfillProfiles from "@/app/api/admin/backfill-profiles/route";
import * as adminBackfillRepos from "@/app/api/admin/backfill-repos/route";
import * as adminBackfillScores from "@/app/api/admin/backfill-scores/route";
import * as authCallbackGithub from "@/app/api/auth/callback/github/route";
import * as authGithub from "@/app/api/auth/github/route";
import * as authSignout from "@/app/api/auth/signout/route";
import * as badge from "@/app/api/badge/[username]/route";
import * as blogComments from "@/app/api/blog-comments/[slug]/route";
import * as campaignEvents from "@/app/api/campaigns/[campaign]/leaderboard/events/route";
import * as campaignLeaderboard from "@/app/api/campaigns/[campaign]/leaderboard/route";
import * as card from "@/app/api/card/[username]/route";
import * as miniCard from "@/app/api/card/mini/[username]/route";
import * as vsCard from "@/app/api/card/vs/[a]/[b]/route";
import * as collectionComments from "@/app/api/collection-comments/[slug]/route";
import * as developers from "@/app/api/developers/route";
import * as facetRank from "@/app/api/facet-rank/[username]/route";
import * as follow from "@/app/api/follows/[username]/route";
import * as follows from "@/app/api/follows/route";
import * as internalProjectAnalysesReconcile from "@/app/api/internal/project-analyses/reconcile/route";
import * as leaderboard from "@/app/api/leaderboard/route";
import * as materialCard from "@/app/api/material-card/[username]/route";
import * as me from "@/app/api/me/route";
import * as ogBlog from "@/app/api/og/blog/[slug]/route";
import * as ogHome from "@/app/api/og/home/route";
import * as profileComments from "@/app/api/profile-comments/[username]/route";
import * as profileReactions from "@/app/api/profile-reactions/[username]/route";
import * as profileBackfill from "@/app/api/profile/backfill/route";
import * as projectAnalysis from "@/app/api/project-analyses/[id]/route";
import * as projectAnalyses from "@/app/api/project-analyses/route";
import * as resumes from "@/app/api/resumes/route";
import * as roast from "@/app/api/roast/route";
import * as apiIndex from "@/app/api/route";
import * as scan from "@/app/api/scan/route";
import * as score from "@/app/api/score/[username]/route";
import * as searchUsers from "@/app/api/search-users/route";
import * as sponsors from "@/app/api/sponsors/route";
import * as stats from "@/app/api/stats/route";
import * as talentById from "@/app/api/talent/[id]/route";
import * as talentIntake from "@/app/api/talent/intake/route";
import * as talent from "@/app/api/talent/route";
import * as vsVerdict from "@/app/api/vs-verdict/route";
import * as authMd from "@/app/auth.md/route";
import * as blogMd from "@/app/blog-md/[slug]/route";
import * as indexMd from "@/app/index.md/route";
import * as llmsFull from "@/app/llms-full.txt/route";
import * as llmsMd from "@/app/llms.md/route";
import * as llmsTxt from "@/app/llms.txt/route";
import * as openapi from "@/app/openapi.json/route";
import * as robots from "@/app/robots.txt/route";

export interface ApiRoute {
  /** Hono path pattern. */
  path: string;
  /** The Next route module; its exported GET/POST/… become handlers. */
  module: object;
  /** Map Hono's params to the module's (when the URL shape differs from its Next route). */
  params?: (params: Record<string, string>) => Record<string, string>;
}

/** Locale prefixes of the Next app's `[locale]` segment (zh is unprefixed). */
const LOCALES = "{zh|en|ja|ko|es|pt|id|vi|ar}";

export const API_ROUTES: ApiRoute[] = [
  // Batch 1: read-only JSON.
  { path: "/api/leaderboard", module: leaderboard },
  { path: "/api/stats", module: stats },
  { path: "/api/search-users", module: searchUsers },
  { path: "/api/developers", module: developers },
  { path: "/api/talent", module: talent },
  { path: "/api/sponsors", module: sponsors },
  { path: "/api/facet-rank/:username", module: facetRank },
  { path: "/api/campaigns/:campaign/leaderboard", module: campaignLeaderboard },
  // Batch 2: README-embedded / social images.
  { path: "/api/badge/:username", module: badge },
  { path: "/api/card/mini/:username", module: miniCard },
  { path: "/api/material-card/:username", module: materialCard },
  { path: "/api/card/:username", module: card },
  { path: "/api/card/vs/:a/:b", module: vsCard },
  { path: "/api/og/home", module: ogHome },
  { path: "/api/og/blog/:slug", module: ogBlog },
  // Batch 3: GitHub OAuth session and account API tokens.
  { path: "/api/auth/github", module: authGithub },
  { path: "/api/auth/callback/github", module: authCallbackGithub },
  { path: "/api/auth/signout", module: authSignout },
  { path: "/api/me", module: me },
  { path: "/api/account/tokens", module: accountTokens },
  { path: "/api/account/tokens/:id", module: accountToken },
  // Batch 4: session-authenticated social features, resumes, talent detail.
  { path: "/api", module: apiIndex },
  { path: "/api/blog-comments/:slug", module: blogComments },
  { path: "/api/collection-comments/:slug", module: collectionComments },
  { path: "/api/profile-comments/:username", module: profileComments },
  { path: "/api/profile-reactions/:username", module: profileReactions },
  { path: "/api/follows", module: follows },
  { path: "/api/follows/:username", module: follow },
  { path: "/api/resumes", module: resumes },
  // Static segment first: Hono matches in registration order (Next ranks
  // /api/talent/intake above /api/talent/[id] by itself).
  { path: "/api/talent/intake", module: talentIntake },
  { path: "/api/talent/:id", module: talentById },
  // Batch 5: scoring, scans, LLM roasts/verdicts, project analyses, campaign
  // SSE, profile backfill, and the secret-gated admin/internal jobs.
  { path: "/api/score/:username", module: score },
  { path: "/api/scan", module: scan },
  { path: "/api/roast", module: roast },
  { path: "/api/vs-verdict", module: vsVerdict },
  { path: "/api/project-analyses", module: projectAnalyses },
  { path: "/api/project-analyses/:id", module: projectAnalysis },
  { path: "/api/campaigns/:campaign/leaderboard/events", module: campaignEvents },
  { path: "/api/profile/backfill", module: profileBackfill },
  { path: "/api/admin/backfill-facets", module: adminBackfillFacets },
  { path: "/api/admin/backfill-profiles", module: adminBackfillProfiles },
  { path: "/api/admin/backfill-repos", module: adminBackfillRepos },
  { path: "/api/admin/backfill-scores", module: adminBackfillScores },
  { path: "/api/internal/project-analyses/reconcile", module: internalProjectAnalysesReconcile },
  // P5: machine-readable documents and the MCP server (non-/api paths).
  { path: "/robots.txt", module: robots },
  { path: "/sitemap.xml", module: sitemap },
  { path: "/llms.txt", module: llmsTxt },
  { path: "/llms-full.txt", module: llmsFull },
  { path: "/llms.md", module: llmsMd },
  { path: "/openapi.json", module: openapi },
  { path: "/auth.md", module: authMd },
  { path: "/index.md", module: indexMd },
  // next.config rewrites /blog/:slug.md and /en/blog/:slug.md to /blog-md/:slug
  // (the rewrite target itself isn't public: 404 like the Next app).
  { path: "/blog/:file{[^/]+\\.md}", module: blogMd, params: ({ file }) => ({ slug: file.replace(/\.md$/, "") }) },
  { path: "/en/blog/:file{[^/]+\\.md}", module: blogMd, params: ({ file }) => ({ slug: file.replace(/\.md$/, "") }) },
  { path: "/.well-known/agent-card.json", module: agentCard },
  { path: "/.well-known/agent-skills/index.json", module: agentSkills },
  { path: "/.well-known/api-catalog", module: apiCatalog },
  { path: "/.well-known/mcp/server-card.json", module: mcpServerCard },
  { path: "/.well-known/oauth-protected-resource", module: oauthProtectedResource },
  { path: "/mcp", module: mcp },
  { path: "/cli", module: cliDoc },
  { path: `/:locale${LOCALES}/cli`, module: cliDoc },
  { path: "/skill", module: skillDoc },
  { path: `/:locale${LOCALES}/skill`, module: skillDoc },
];

export type Target = "web" | "api" | "legacy";

/**
 * Migration route table: which Worker serves each path. Unmigrated /api
 * routes (Feed) and Next build assets stay on the legacy Next Worker. To roll
 * a route back, delete its rule (or set ROUTER_FORCE_LEGACY to send
 * everything to legacy).
 */

/**
 * Paths only the legacy Next Worker can answer: its build output. Every other
 * non-API path is a page (or a 404) and is served by the Astro Worker, which
 * since P5 also renders the site's not-found page.
 */
const LEGACY_PREFIXES: readonly string[] = ["/_next/"];

/**
 * API routes served by the Hono Worker (P1 batches 1–5). Whole-path
 * patterns, never prefixes: sibling routes such as /api/talent/:id and
 * /api/campaigns/:c/leaderboard/events are not migrated yet.
 */
const API_ROUTES: readonly RegExp[] = [
  /^\/api\/leaderboard$/,
  /^\/api\/stats$/,
  /^\/api\/search-users$/,
  /^\/api\/developers$/,
  /^\/api\/talent$/,
  /^\/api\/sponsors$/,
  /^\/api\/facet-rank\/[^/]+$/,
  /^\/api\/campaigns\/[^/]+\/leaderboard$/,
  // Batch 2: README-embedded / social images (SVG badges and cards, PNG
  // cards and OG images rendered with the same @vercel/og as next/og).
  /^\/api\/badge\/[^/]+$/,
  /^\/api\/card\/mini\/[^/]+$/,
  /^\/api\/material-card\/[^/]+$/,
  /^\/api\/card\/[^/]+$/,
  /^\/api\/card\/vs\/[^/]+\/[^/]+$/,
  /^\/api\/og\/home$/,
  /^\/api\/og\/blog\/[^/]+$/,
  // Batch 3: GitHub OAuth session cookies and account API tokens.
  /^\/api\/auth\/github$/,
  /^\/api\/auth\/callback\/github$/,
  /^\/api\/auth\/signout$/,
  /^\/api\/me$/,
  /^\/api\/account\/tokens$/,
  /^\/api\/account\/tokens\/[^/]+$/,
  // Batch 4: comments, reactions, follows, resumes, talent detail, API index.
  /^\/api$/,
  /^\/api\/blog-comments\/[^/]+$/,
  /^\/api\/collection-comments\/[^/]+$/,
  /^\/api\/profile-comments\/[^/]+$/,
  /^\/api\/profile-reactions\/[^/]+$/,
  /^\/api\/follows$/,
  /^\/api\/follows\/[^/]+$/,
  /^\/api\/resumes$/,
  /^\/api\/talent\/[^/]+$/,
  // Batch 5: scoring, scans, LLM roasts/verdicts, project analyses, campaign
  // SSE, profile backfill, admin/internal jobs. (Feed stays on legacy: its
  // rollout is switched and verified on the legacy Worker by the release.)
  /^\/api\/score\/[^/]+$/,
  /^\/api\/scan$/,
  /^\/api\/roast$/,
  /^\/api\/vs-verdict$/,
  /^\/api\/project-analyses$/,
  /^\/api\/project-analyses\/[^/]+$/,
  /^\/api\/campaigns\/[^/]+\/leaderboard\/events$/,
  /^\/api\/profile\/backfill$/,
  /^\/api\/admin\/backfill-(facets|profiles|repos|scores)$/,
  /^\/api\/internal\/project-analyses\/reconcile$/,
];

/**
 * Machine-readable documents and the MCP server, served by the API Worker
 * (P5). Exact paths: the markdown twins of blog posts only exist at
 * /blog/:slug.md and /en/blog/:slug.md (the Next app's rewrites).
 */
const API_DOCUMENTS: readonly RegExp[] = [
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/llms(?:-full)?\.txt$/,
  /^\/llms\.md$/,
  /^\/openapi\.json$/,
  /^\/auth\.md$/,
  /^\/index\.md$/,
  /^\/mcp$/,
  /^\/\.well-known\/(?:agent-card\.json|agent-skills\/index\.json|api-catalog|mcp\/server-card\.json|oauth-protected-resource)$/,
  /^\/(?:en\/)?blog\/[^/]+\.md$/,
  /^\/(?:(?:zh|en|ja|ko|es|pt|id|vi|ar)\/)?(?:cli|skill)$/,
];

export function pickTarget(pathname: string): Target {
  if (API_DOCUMENTS.some((re) => re.test(pathname))) return "api";
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return API_ROUTES.some((re) => re.test(pathname)) ? "api" : "legacy";
  }
  // Pages, 404s and the files in public/ (fonts, images, install.sh, …),
  // served by ghfind-web's asset layer.
  return LEGACY_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ? "legacy" : "web";
}

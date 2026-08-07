import { SITE_URL } from "@/lib/site";
import { PRODUCT_ONELINER } from "@/lib/agent-docs";

export const dynamic = "force-static";
export const revalidate = 86400;

/**
 * MCP server card (/.well-known/mcp/server-card.json) so agents can preview the
 * server before opening a transport. Mirrors the tools served by the Go MCP
 * backend through the same-origin `/mcp` rewrite.
 */
export function GET() {
  return Response.json(
    {
      name: "ghfind",
      description: PRODUCT_ONELINER,
      version: "1.0.0",
      serverUrl: `${SITE_URL}/mcp`,
      transport: "streamable-http",
      authentication: { type: "none" },
      tools: [
        { name: "score_user", description: "Deterministic 0-100 GitHub value & trust score for a login." },
        { name: "scan_user", description: "Full scan payload: metrics, repos, PRs, red flags." },
        { name: "compare_users", description: "Head-to-head deterministic comparison of two accounts." },
        { name: "get_leaderboard", description: "Ranked developers by score/trend/heat/progress." },
        { name: "search_users", description: "Prefix search across scored accounts." },
      ],
    },
    { headers: { "Cache-Control": "public, max-age=0, s-maxage=86400" } },
  );
}

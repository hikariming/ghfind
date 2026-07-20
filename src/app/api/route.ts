import { NextResponse } from "next/server";
import { PRODUCT_ONELINER } from "@/lib/agent-docs";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";
export const revalidate = 86400;

/**
 * GET /api — a JSON index of the public API surface, for agents that probe the
 * API root instead of reading /openapi.json first. Lists only real endpoints
 * (mirrors apiSummaryMd in lib/agent-docs.ts).
 */
export async function GET() {
  return NextResponse.json(
    {
      name: "ghfind API",
      description: PRODUCT_ONELINER,
      openapi: `${SITE_URL}/openapi.json`,
      docs: {
        site: `${SITE_URL}/docs`,
        auth: `${SITE_URL}/auth.md`,
        llms: `${SITE_URL}/llms.txt`,
        mcp: `${SITE_URL}/mcp`,
        catalog: `${SITE_URL}/.well-known/api-catalog`,
      },
      endpoints: [
        `GET ${SITE_URL}/api/score/{username}`,
        `POST ${SITE_URL}/api/scan`,
        `POST ${SITE_URL}/api/roast`,
        `POST ${SITE_URL}/api/vs-verdict`,
        `GET ${SITE_URL}/api/leaderboard`,
        `GET ${SITE_URL}/api/developers`,
        `GET ${SITE_URL}/api/search-users`,
        `GET ${SITE_URL}/api/stats`,
      ],
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        Link: `<${SITE_URL}/openapi.json>; rel="service-desc"; type="application/openapi+json"`,
      },
    },
  );
}

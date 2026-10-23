import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { attachCoverUrls } from "@/lib/discover/covers";
import { cardFromAssessment } from "@/lib/discover/map";
import { DISCOVER_SCORE_VERSION, isDiscoverScoreViewer, sortByDiscoverScore } from "@/lib/discover/score";
import { listProjectBoard } from "@/lib/project-analysis-db";
import type { ProjectAssessment } from "@/lib/project-analysis-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
} as const;
const PAGE = 100;
const MAX_ASSESSMENTS = 2_000;

/**
 * Internal Discover view: every public assessment ranked by
 * discover-score-v1.1. Only allowlisted accounts see it, and only while
 * GHFIND_DISCOVER_SCORE_V1=1. Everyone else gets a 404, so the public
 * Discover payload and ranking stay on product_score.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!isDiscoverScoreViewer(session?.user.githubId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: PRIVATE_HEADERS });
  }
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get("limit") ?? "500", 10) || 500));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const locale = url.searchParams.get("locale") ?? "zh";
  try {
    const entries: ProjectAssessment[] = [];
    for (let start = 0; start < MAX_ASSESSMENTS; start += PAGE) {
      const page = await listProjectBoard("all", { limit: PAGE, offset: start });
      entries.push(...page);
      if (page.length < PAGE) break;
    }
    const ranked = sortByDiscoverScore(
      entries.map((entry) => cardFromAssessment(entry, locale, { discoverScore: true })),
    );
    const items = await attachCoverUrls(ranked.slice(offset, offset + limit));
    const nextOffset = offset + items.length < ranked.length ? offset + items.length : null;
    return NextResponse.json(
      { items, nextOffset, total: ranked.length, scoreVersion: DISCOVER_SCORE_VERSION, source: "public", degraded: [], requestId: null },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    console.error("discover.internal_failed", error);
    return NextResponse.json({ error: "discover_unavailable", items: [], nextOffset: null }, { status: 503, headers: PRIVATE_HEADERS });
  }
}

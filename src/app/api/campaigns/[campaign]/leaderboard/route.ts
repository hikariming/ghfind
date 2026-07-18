import { NextRequest, NextResponse } from "next/server";
import { campaignSlug } from "@/lib/campaigns";
import { getCampaignLeaderboard } from "@/lib/db";
import { paginate, parsePagination } from "@/lib/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, s-maxage=10, stale-while-revalidate=30";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ campaign: string }> },
) {
  const { campaign: rawCampaign } = await context.params;
  const campaign = campaignSlug(rawCampaign);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }

  const page = parsePagination(req, { defaultLimit: 100, maxLimit: 500 });
  const entries = await getCampaignLeaderboard(campaign, 500);
  return NextResponse.json(
    { ...paginate(entries, page), campaign },
    { headers: { "Cache-Control": CACHE_CONTROL } },
  );
}

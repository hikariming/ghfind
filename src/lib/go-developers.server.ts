import "server-only";

import { getGoPublicData } from "@/lib/go-backend.server";
import type { CampaignSlug } from "@/lib/campaigns";
import type { FacetType } from "@/lib/facets";
import type { PresentationLeaderboardEntry } from "@/lib/profile-presentation";

export interface GoFacetCategory {
  value: string;
  count: number;
}

/** Kept in sync with the Go directory endpoint's bounded public result set. */
export const GO_DEVELOPERS_PER_FACET_LIMIT = 250;

export async function getGoFacetCategories(type: FacetType) {
  const data = await getGoPublicData<{ categories: GoFacetCategory[] }>(
    `/api/developers?type=${encodeURIComponent(type)}`,
  );
  return data?.categories ?? [];
}

export async function getGoDevelopersByFacet(type: FacetType, value: string) {
  const query = new URLSearchParams({ type, value });
  const data = await getGoPublicData<{ entries: PresentationLeaderboardEntry[] }>(
    `/api/developers?${query.toString()}`,
  );
  return data?.entries ?? [];
}

export async function getGoCampaignLeaderboard(campaign: CampaignSlug) {
  const data = await getGoPublicData<{ entries: PresentationLeaderboardEntry[] }>(
    `/api/campaigns/${encodeURIComponent(campaign)}/leaderboard?limit=500`,
  );
  return data?.entries ?? [];
}

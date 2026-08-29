import "server-only";

import type { CampaignSlug } from "@/lib/campaigns";
import { DEVELOPERS_PER_FACET_LIMIT, getCampaignLeaderboard } from "@/lib/db";
import {
  getDevelopersByFacetCached,
  getFacetCategoriesCached,
} from "@/lib/developers";
import type { FacetType } from "@/lib/facets";
import type { PresentationLeaderboardEntry } from "@/lib/profile-presentation";

export interface GoFacetCategory {
  value: string;
  count: number;
}

/** The directory endpoint's bounded public result set. */
export const GO_DEVELOPERS_PER_FACET_LIMIT = DEVELOPERS_PER_FACET_LIMIT;

export async function getGoFacetCategories(
  type: FacetType,
): Promise<GoFacetCategory[]> {
  return getFacetCategoriesCached(type);
}

export async function getGoDevelopersByFacet(
  type: FacetType,
  value: string,
): Promise<PresentationLeaderboardEntry[]> {
  return getDevelopersByFacetCached(type, value);
}

export async function getGoCampaignLeaderboard(
  campaign: CampaignSlug,
): Promise<PresentationLeaderboardEntry[]> {
  return getCampaignLeaderboard(campaign, 500);
}

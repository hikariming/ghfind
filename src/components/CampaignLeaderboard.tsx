import type { CampaignSlug } from "@/lib/campaigns";
import { getGoCampaignLeaderboard } from "@/lib/go-developers.server";
import { CampaignLeaderboardClient } from "./CampaignLeaderboardClient";

interface CampaignLeaderboardProps {
  campaign: CampaignSlug;
  emptyLabel: string;
}

export async function CampaignLeaderboard({
  campaign,
  emptyLabel,
}: CampaignLeaderboardProps) {
  const entries = await getGoCampaignLeaderboard(campaign);
  return (
    <CampaignLeaderboardClient
      campaign={campaign}
      initialEntries={entries}
      emptyLabel={emptyLabel}
    />
  );
}

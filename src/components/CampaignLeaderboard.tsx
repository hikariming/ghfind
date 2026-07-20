import type { CampaignSlug } from "@/lib/campaigns";
import { getCampaignLeaderboard } from "@/lib/db";
import { CampaignLeaderboardClient } from "./CampaignLeaderboardClient";

interface CampaignLeaderboardProps {
  campaign: CampaignSlug;
  emptyLabel: string;
}

export async function CampaignLeaderboard({
  campaign,
  emptyLabel,
}: CampaignLeaderboardProps) {
  const entries = await getCampaignLeaderboard(campaign);
  return (
    <CampaignLeaderboardClient
      campaign={campaign}
      initialEntries={entries}
      emptyLabel={emptyLabel}
    />
  );
}

import { useTranslations } from "next-intl";
import { LeaderboardPageView } from "@/components/pages/LeaderboardPageView";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl, WithoutT } from "./types";

function LeaderboardBody(props: WithoutT<typeof LeaderboardPageView>) {
  return <LeaderboardPageView {...props} t={useTranslations("leaderboard")} />;
}

export function LeaderboardIsland({ intl, ...props }: WithIntl<WithoutT<typeof LeaderboardPageView>>) {
  return <IslandRoot intl={intl}><LeaderboardBody {...props} /></IslandRoot>;
}

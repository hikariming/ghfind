import { LeaderboardRail } from "@/components/LeaderboardRail";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function LeaderboardRailIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><LeaderboardRail /></IslandRoot>;
}

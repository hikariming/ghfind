import { TalentDirectory } from "@/components/talent/TalentDirectory";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function TalentIsland({ intl, ...props }: WithIntl<React.ComponentProps<typeof TalentDirectory>>) {
  return <IslandRoot intl={intl}><TalentDirectory {...props} /></IslandRoot>;
}

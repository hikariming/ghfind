import { TalentMatch } from "@/components/talent-match/TalentMatch";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function TalentMatchIsland({ intl, zh }: WithIntl<{ zh: boolean }>) {
  return <IslandRoot intl={intl}><TalentMatch zh={zh} /></IslandRoot>;
}

import { HomeSponsorRow } from "@/components/HomeSponsorRow";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function HomeSponsorRowIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><HomeSponsorRow /></IslandRoot>;
}

import { PoweredByLobeHub } from "@/components/Sponsor";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function FooterSponsorIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><PoweredByLobeHub /></IslandRoot>;
}

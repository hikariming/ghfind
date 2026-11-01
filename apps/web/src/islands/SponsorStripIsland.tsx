import { SponsorStrip } from "@/components/Sponsor";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function SponsorStripIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><SponsorStrip /></IslandRoot>;
}

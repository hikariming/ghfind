import { SponsorView } from "@/components/pages/SponsorView";
import { useTranslations } from "next-intl";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

/**
 * The /sponsor page body. Unlike the other content pages it hydrates: its
 * sponsor-holder lists load live records in the browser (SponsorHolders).
 */
function SponsorPageBody() {
  return <SponsorView t={useTranslations("sponsor")} />;
}

export function SponsorPageIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><SponsorPageBody /></IslandRoot>;
}

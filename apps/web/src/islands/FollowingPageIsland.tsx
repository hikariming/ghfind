import { useTranslations } from "next-intl";
import { FollowingView } from "@/components/pages/FollowingView";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

function FollowingBody() {
  return <FollowingView t={useTranslations("follow")} />;
}

export function FollowingPageIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><FollowingBody /></IslandRoot>;
}

import { useTranslations } from "next-intl";
import { DeveloperFacetView } from "@/components/pages/DeveloperFacetView";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl, WithoutT } from "./types";

type Props = Omit<WithoutT<typeof DeveloperFacetView>, "tl" | "tTier" | "tProjects">;

function DeveloperFacetBody(props: Props) {
  return (
    <DeveloperFacetView
      {...props}
      t={useTranslations("developers")}
      tl={useTranslations("leaderboard")}
      tTier={useTranslations("tiers")}
      tProjects={useTranslations("projectBoards")}
    />
  );
}

export function DeveloperFacetIsland({ intl, ...props }: WithIntl<Props>) {
  return <IslandRoot intl={intl}><DeveloperFacetBody {...props} /></IslandRoot>;
}

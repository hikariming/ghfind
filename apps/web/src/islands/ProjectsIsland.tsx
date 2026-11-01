import { useTranslations } from "next-intl";
import { ProjectsView } from "@/components/pages/ProjectsView";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl, WithoutT } from "./types";

function ProjectsBody(props: WithoutT<typeof ProjectsView>) {
  return <ProjectsView {...props} t={useTranslations("projectBoards")} />;
}

export function ProjectsIsland({ intl, ...props }: WithIntl<WithoutT<typeof ProjectsView>>) {
  return <IslandRoot intl={intl}><ProjectsBody {...props} /></IslandRoot>;
}

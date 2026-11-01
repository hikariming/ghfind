import { ProjectAnalysisStatus } from "@/components/ProjectAnalysisStatus";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function ProjectAnalysisIsland({ intl, initial }: WithIntl<React.ComponentProps<typeof ProjectAnalysisStatus>>) {
  return <IslandRoot intl={intl}><ProjectAnalysisStatus initial={initial} /></IslandRoot>;
}

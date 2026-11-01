import { ResumeBuilder } from "@/components/resume/ResumeBuilder";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function ResumeIsland({ intl, zh }: WithIntl<{ zh: boolean }>) {
  return <IslandRoot intl={intl}><ResumeBuilder zh={zh} /></IslandRoot>;
}

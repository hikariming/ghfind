import { NavAuth } from "@/components/NavAuth";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function AccountIsland({ intl, repoHref, repoLabel, repoTitle }: WithIntl<{ repoHref: string; repoLabel: string; repoTitle: string }>) {
  return <IslandRoot intl={intl}><NavAuth repoHref={repoHref} repoLabel={repoLabel} repoTitle={repoTitle} /></IslandRoot>;
}

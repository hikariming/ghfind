import { GlobalSearch } from "@/components/GlobalSearch";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function SearchIsland({ intl, mobile }: WithIntl<{ mobile?: boolean }>) {
  return <IslandRoot intl={intl}><GlobalSearch mobile={mobile} /></IslandRoot>;
}

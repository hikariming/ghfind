import type { ComponentProps } from "react";
import { DiscoverApp } from "@/components/discover/DiscoverApp";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function DiscoverIsland({ intl, ...props }: WithIntl<ComponentProps<typeof DiscoverApp>>) {
  return <IslandRoot intl={intl}><DiscoverApp {...props} /></IslandRoot>;
}

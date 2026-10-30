import type { ComponentProps } from "react";
import { FeedApp } from "@/components/feed/FeedApp";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function StreamIsland({ intl, ...props }: WithIntl<ComponentProps<typeof FeedApp>>) {
  return <IslandRoot intl={intl}><FeedApp {...props} /></IslandRoot>;
}

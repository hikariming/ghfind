import { Roaster } from "@/components/Roaster";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

// Homepage pieces: each hydrates on its own inside the static HomeView.
export function RoasterIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><Roaster /></IslandRoot>;
}

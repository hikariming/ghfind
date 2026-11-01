import { AdvxView } from "@/components/pages/AdvxView";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function AdvxIsland({ intl, ...props }: WithIntl<Parameters<typeof AdvxView>[0]>) {
  return <IslandRoot intl={intl}><AdvxView {...props} /></IslandRoot>;
}

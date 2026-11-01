import { PendingProfile } from "@/app/[locale]/u/[username]/PendingProfile";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function PendingProfileIsland({ intl, ...props }: WithIntl<React.ComponentProps<typeof PendingProfile>>) {
  return <IslandRoot intl={intl}><PendingProfile {...props} /></IslandRoot>;
}

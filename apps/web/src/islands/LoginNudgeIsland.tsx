import { LoginNudge } from "@/components/LoginNudge";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function LoginNudgeIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><LoginNudge /></IslandRoot>;
}

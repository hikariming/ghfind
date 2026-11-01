import { ThemeToggle } from "@/components/ThemeToggle";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function ThemeIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><ThemeToggle /></IslandRoot>;
}

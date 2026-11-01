import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function LanguageIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><LanguageSwitcher /></IslandRoot>;
}

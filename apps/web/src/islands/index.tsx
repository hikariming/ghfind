/**
 * Astro island entry points. Each wraps an existing React component from the
 * Next app (`src/components`) in `IslandRoot`, so the component runs unchanged
 * through the next-intl / navigation shims.
 */
import { GlobalSearch } from "@/components/GlobalSearch";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { LoginNudge } from "@/components/LoginNudge";
import { NavAuth } from "@/components/NavAuth";
import { PoweredByLobeHub, SponsorStrip } from "@/components/Sponsor";
import { ThemeToggle } from "@/components/ThemeToggle";
import { IslandRoot, type IslandIntl } from "./IslandRoot";

type WithIntl<P = object> = P & { intl: IslandIntl };

export function SearchIsland({ intl, mobile }: WithIntl<{ mobile?: boolean }>) {
  return <IslandRoot intl={intl}><GlobalSearch mobile={mobile} /></IslandRoot>;
}

export function LanguageIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><LanguageSwitcher /></IslandRoot>;
}

export function ThemeIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><ThemeToggle /></IslandRoot>;
}

export function AccountIsland({ intl, repoHref, repoLabel, repoTitle }: WithIntl<{ repoHref: string; repoLabel: string; repoTitle: string }>) {
  return <IslandRoot intl={intl}><NavAuth repoHref={repoHref} repoLabel={repoLabel} repoTitle={repoTitle} /></IslandRoot>;
}

export function SponsorStripIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><SponsorStrip /></IslandRoot>;
}

export function FooterSponsorIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><PoweredByLobeHub /></IslandRoot>;
}

export function LoginNudgeIsland({ intl }: WithIntl) {
  return <IslandRoot intl={intl}><LoginNudge /></IslandRoot>;
}

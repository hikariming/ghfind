import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { NavAuth } from "./NavAuth";
import { SponsorStrip } from "./Sponsor";
import { WorkspaceShell } from "./WorkspaceShell";

/**
 * Server-owned content keeps the shared shell static. The account slot is
 * always the NavAuth client island — it decides sign-in vs guest vs avatar
 * from its runtime /api/me probe, so this prerendered output no longer depends
 * on the build machine's env.
 */
export async function Navbar({ children }: { children: ReactNode }) {
  const tRepo = await getTranslations("repoLink");
  return <WorkspaceShell
    sponsor={<SponsorStrip />}
    account={<NavAuth repoHref="https://github.com/hikariming/ghfind" repoLabel={tRepo("label")} repoTitle={tRepo("title")} />}
  >{children}</WorkspaceShell>;
}

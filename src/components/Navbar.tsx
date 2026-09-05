import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { oauthConfigured } from "@/lib/oauth-config";
import { NavAuth } from "./NavAuth";
import { SponsorStrip } from "./Sponsor";
import { WorkspaceShell } from "./WorkspaceShell";

/** Server-owned account configuration and content keep the shared shell static. */
export async function Navbar({ children }: { children: ReactNode }) {
  const tRepo = await getTranslations("repoLink");
  const configured = oauthConfigured();
  return <WorkspaceShell
    sponsor={<SponsorStrip />}
    account={configured ? <NavAuth configured repoHref="https://github.com/hikariming/ghfind" repoLabel={tRepo("label")} repoTitle={tRepo("title")} /> : <a href="https://github.com/hikariming/ghfind" target="_blank" rel="noopener noreferrer" className="sidebar-source" aria-label={tRepo("label")}><span aria-hidden>↗</span><span className="sidebar-label">{tRepo("label")}</span></a>}
  >{children}</WorkspaceShell>;
}

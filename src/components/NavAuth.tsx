"use client";

import { useState } from "react";
import { WorkspaceUserMenu } from "@/components/workspace/WorkspaceUserMenu";
import { LoginDialog } from "@/components/LoginDialog";
import { fetchMe, loginProviders, type Me } from "@/lib/me-client";
import { useMountEffect } from "@/lib/use-mount-effect";

/** The account probe runs after mount so shared pages remain prerenderable. */
export function NavAuth({ repoHref, repoLabel, repoTitle }: { repoHref: string; repoLabel: string; repoTitle: string }) {
  const [me, setMe] = useState<Me | null>(null);

  useMountEffect(() => {
    let alive = true;
    fetchMe().then((result) => { if (alive) setMe(result); });
    return () => { alive = false; };
  });

  if (!me) return <div className="sidebar-account-skeleton" aria-hidden />;
  const refresh = async () => { setMe(await fetchMe({ refresh: true })); };

  if (me.user || me.account) {
    return <>
      <WorkspaceUserMenu
        image={me.user?.image ?? me.account?.image ?? null}
        login={me.user?.login ?? me.account!.name}
        account={me.account}
        githubAvailable={loginProviders(me).github}
        scored={me.scored}
        repoHref={repoHref}
        repoLabel={repoLabel}
        repoTitle={repoTitle}
      />
      <LoginDialog me={me} onRetry={refresh} showTrigger={false} />
    </>;
  }

  return <LoginDialog me={me} onRetry={refresh} />;
}

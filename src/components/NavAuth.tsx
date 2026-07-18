"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useTranslations } from "next-intl";
import { NavGuestMenu } from "@/components/NavGuestMenu";
import { WorkspaceUserMenu } from "@/components/workspace/WorkspaceUserMenu";
import { fetchMe, type Me } from "@/lib/me-client";

/**
 * GitHub login control for the navbar. Client island: it probes `/api/me` for the
 * session instead of calling `auth()` on the server, so the shared navbar no
 * longer reads cookies during render — that's what lets the homepage and other
 * pages prerender + serve from the CDN. Renders nothing when OAuth isn't
 * configured (`configured=false`), matching the redis/turso "degrade cleanly"
 * style, so the navbar's right cluster collapses the missing child with no gap.
 *
 * While the probe is in flight we render nothing (rather than flashing the wrong
 * state); most visitors are signed out, and the button/avatar slots in once the
 * single fetch resolves.
 */
export function NavAuth({
  configured,
  repoHref,
  repoLabel,
  repoTitle,
}: {
  configured: boolean;
  repoHref: string;
  repoLabel: string;
  repoTitle: string;
}) {
  const t = useTranslations("header");
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    fetchMe().then((d: Me) => {
      if (alive) setMe(d);
    });
    return () => {
      alive = false;
    };
  }, [configured]);

  if (!configured) {
    return <NavGuestMenu repoHref={repoHref} repoLabel={repoLabel} repoTitle={repoTitle} />;
  }
  if (!me) {
    return <NavGuestMenu repoHref={repoHref} repoLabel={repoLabel} repoTitle={repoTitle} />;
  } // keep settings reachable during the probe

  const user = me.user;

  if (user) {
    return (
      <WorkspaceUserMenu
        image={user.image}
        login={user.login}
        scored={me.scored}
        repoHref={repoHref}
        repoLabel={repoLabel}
        repoTitle={repoTitle}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => signIn("github")}
        className="inline-flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 text-sm font-medium text-zinc-300 shadow-sm transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
      >
        <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 fill-current">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
        {t("signIn")}
      </button>
      <NavGuestMenu repoHref={repoHref} repoLabel={repoLabel} repoTitle={repoTitle} />
    </>
  );
}

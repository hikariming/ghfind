"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { WorkspaceUserMenu } from "@/components/workspace/WorkspaceUserMenu";
import { fetchMe, type Me } from "@/lib/me-client";
import { signInWithGitHub } from "@/lib/oauth-client";

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className ?? "h-4 w-4 fill-current"}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Account block at the foot of the workspace sidebar. Client island: it probes
 * `/api/me` for the session instead of calling `auth()` on the server, so the
 * shared shell no longer reads cookies during render — that's what lets the
 * homepage and other pages prerender + serve from the CDN. Whether OAuth is
 * even offered also comes from that probe (`oauth` flag): the server that holds
 * the OAuth secrets answers at runtime, so prerendered HTML built without those
 * secrets (local dev deploys, PR previews) still shows login correctly.
 *
 * Rendered states: a skeleton while the probe is in flight (no wrong-state
 * flash), a full-width GitHub sign-in button for guests, and the avatar row +
 * account menu (profile, résumé, following, sign out) once signed in.
 */
export function NavAuth({
  repoHref,
  repoLabel,
  repoTitle,
}: {
  repoHref: string;
  repoLabel: string;
  repoTitle: string;
}) {
  const t = useTranslations("header");
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMe().then((d: Me) => {
      if (alive) setMe(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!me) {
    return <div className="sidebar-account-skeleton" aria-hidden />;
  }

  // This deployment cannot run OAuth: keep the repo link reachable with no
  // dead sign-in button.
  if (me.oauth === false) {
    return (
      <a href={repoHref} target="_blank" rel="noopener noreferrer" className="sidebar-source" aria-label={repoLabel} title={repoTitle}>
        <span aria-hidden>↗</span><span className="sidebar-label">{repoLabel}</span>
      </a>
    );
  }

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
    <button
      type="button"
      onClick={() => signInWithGitHub()}
      className="sidebar-login"
    >
      <GitHubMark />
      <span className="sidebar-label">{t("signIn")}</span>
    </button>
  );
}

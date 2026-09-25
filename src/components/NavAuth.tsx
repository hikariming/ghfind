"use client";

import { useState } from "react";
import { LogIn, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { WorkspaceUserMenu } from "@/components/workspace/WorkspaceUserMenu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { fetchMe, type Me } from "@/lib/me-client";
import { signInWithGitHub } from "@/lib/oauth-client";
import { useMountEffect } from "@/lib/use-mount-effect";

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-[18px] w-[18px] fill-current" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function LoginDialog({ githubAvailable }: { githubAvailable: boolean }) {
  const t = useTranslations("loginDialog");

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="sidebar-login" aria-label={t("entry")}>
          <LogIn size={16} aria-hidden />
          <span className="sidebar-label">{t("entry")}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="login-dialog">
        <div className="login-dialog-heading">
          <div>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription className="login-dialog-description">{t("description")}</DialogDescription>
          </div>
          <DialogClose className="login-dialog-close" aria-label={t("close")}>
            <X size={17} aria-hidden />
          </DialogClose>
        </div>

        <div className="login-dialog-providers">
          <button type="button" className="login-dialog-option" disabled>
            <span className="login-dialog-google" aria-hidden>G</span>
            {t("google")}
          </button>
          <button
            type="button"
            className="login-dialog-option"
            disabled={!githubAvailable}
            onClick={() => signInWithGitHub()}
          >
            <GitHubMark />
            {t("github")}
          </button>
          {!githubAvailable && <p className="login-dialog-note">{t("githubUnavailable")}</p>}
        </div>

        <div className="login-dialog-divider"><span>{t("emailDivider")}</span></div>
        <div className="login-dialog-email">
          <label htmlFor="login-dialog-email">{t("emailLabel")}</label>
          <input
            id="login-dialog-email"
            type="email"
            autoComplete="email"
            placeholder={t("emailPlaceholder")}
            disabled
          />
          <button type="button" className="login-dialog-option" disabled>{t("sendCode")}</button>
        </div>
        <p className="login-dialog-note">{t("comingSoon")}</p>
      </DialogContent>
    </Dialog>
  );
}

/** The account probe runs after mount so shared pages remain prerenderable. */
export function NavAuth({
  repoHref,
  repoLabel,
  repoTitle,
}: {
  repoHref: string;
  repoLabel: string;
  repoTitle: string;
}) {
  const [me, setMe] = useState<Me | null>(null);

  useMountEffect(() => {
    let alive = true;
    fetchMe().then((result) => {
      if (alive) setMe(result);
    });
    return () => {
      alive = false;
    };
  });

  if (!me) return <div className="sidebar-account-skeleton" aria-hidden />;

  if (me.user) {
    return (
      <WorkspaceUserMenu
        image={me.user.image}
        login={me.user.login}
        scored={me.scored}
        repoHref={repoHref}
        repoLabel={repoLabel}
        repoTitle={repoTitle}
      />
    );
  }

  return <LoginDialog githubAvailable={me.oauth !== false} />;
}

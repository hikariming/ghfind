"use client";

import { ArrowUpRight, Languages, LogOut, Palette, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { signOut } from "next-auth/react";
import { Link } from "@/i18n/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/ThemeToggle";

type WorkspaceUserMenuProps = {
  image: string | null;
  login: string;
  scored: boolean;
  repoHref: string;
  repoLabel: string;
  repoTitle: string;
};

function avatarFallback(login: string) {
  return login.trim().charAt(0).toUpperCase() || "G";
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 fill-current text-zinc-300">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function WorkspaceUserMenu({
  image,
  login,
  scored,
  repoHref,
  repoLabel,
  repoTitle,
}: WorkspaceUserMenuProps) {
  const tHeader = useTranslations("header");
  const tLang = useTranslations("langSwitch");
  const tTheme = useTranslations("themeSwitch");
  const targetHref = scored
    ? `/u/${login}`
    : `/?username=${encodeURIComponent(`https://github.com/${login}`)}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={login}
          className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.03] shadow-sm transition-colors hover:bg-white/[0.06]"
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt={login} className="h-full w-full object-cover" />
          ) : (
            <span className="text-sm font-semibold text-zinc-100">{avatarFallback(login)}</span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-[18.5rem] rounded-2xl border-white/10 bg-popover/98 p-1.5 shadow-2xl backdrop-blur-xl"
      >
        <div className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-3 py-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06]">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt={login} className="h-full w-full object-cover" />
            ) : (
              <span className="text-base font-semibold text-zinc-100">{avatarFallback(login)}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-zinc-100">@{login}</div>
            <div className="truncate text-xs text-zinc-500">github.com/{login}</div>
          </div>
        </div>

        <DropdownMenuSeparator className="mx-1 bg-white/10" />

        <DropdownMenuItem asChild>
          <Link
            href={targetHref}
            className="flex items-center justify-between rounded-xl px-3 py-2.5"
          >
            <span className="flex items-center gap-2.5">
              <UserRound className="h-4 w-4 text-zinc-300" />
              <span>{scored ? tHeader("myProfile") : tHeader("judgeSelf")}</span>
            </span>
            <ArrowUpRight className="h-4 w-4 text-zinc-500" />
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator className="mx-1 bg-white/10" />

        <DropdownMenuItem asChild>
          <a
            href={repoHref}
            target="_blank"
            rel="noopener noreferrer"
            title={repoTitle}
            className="flex items-center justify-between rounded-xl px-3 py-2.5"
          >
            <span className="flex items-center gap-2.5">
              <GitHubMark />
              <span>{repoLabel}</span>
            </span>
            <ArrowUpRight className="h-4 w-4 text-zinc-500" />
          </a>
        </DropdownMenuItem>

        <DropdownMenuSeparator className="mx-1 bg-white/10" />

        <div className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5">
          <span className="flex items-center gap-2.5 text-sm text-zinc-300">
            <Languages className="h-4 w-4 text-zinc-300" />
            {tLang("label")}
          </span>
          <LanguageSwitcher />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5">
          <span className="flex items-center gap-2.5 text-sm text-zinc-300">
            <Palette className="h-4 w-4 text-zinc-300" />
            {tTheme("label")}
          </span>
          <ThemeToggle />
        </div>

        <DropdownMenuSeparator className="mx-1 bg-white/10" />

        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void signOut();
          }}
          className="rounded-xl px-3 py-2.5"
        >
          <span className="flex items-center gap-2.5">
            <LogOut className="h-4 w-4 text-zinc-300" />
            <span>{tHeader("signOut")}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

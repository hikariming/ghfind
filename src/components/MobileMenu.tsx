"use client";

import { ArrowUpRight, Languages, LogOut, Menu, Palette, UserRound, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { signIn, signOut } from "next-auth/react";
import { NAV_ITEMS } from "@/config/nav";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { NavLinks } from "./NavLinks";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeToggle } from "./ThemeToggle";
import { GlobalSearch } from "./GlobalSearch";
import { fetchMe, type Me } from "@/lib/me-client";

/**
 * Mobile hamburger + drawer (sm:hidden). Owns the open/close state.
 *
 * The panel is `absolute top-full` and resolves against the sticky `Navbar` root
 * (a positioned ancestor), so it spans the full bar width just below it. Closes
 * on Escape and on any nav-link tap.
 */
function avatarFallback(login: string) {
  return login.trim().charAt(0).toUpperCase() || "G";
}

export function MobileMenu({
  configured,
  repoHref,
}: {
  configured: boolean;
  repoHref: string;
}) {
  const t = useTranslations("nav");
  const tHeader = useTranslations("header");
  const tFollow = useTranslations("follow");
  const tLang = useTranslations("langSwitch");
  const tTheme = useTranslations("themeSwitch");
  const tRepo = useTranslations("repoLink");
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!configured || !open) return;
    let alive = true;
    // Shared probe: reuses the navbar's already-resolved /api/me result.
    fetchMe().then((data: Me) => {
      if (alive) setMe(data);
    });
    return () => {
      alive = false;
    };
  }, [configured, open]);

  const effectiveMe = configured ? me : { user: null, scored: false };
  const user = effectiveMe?.user ?? null;
  const scored = effectiveMe?.scored ?? false;
  const targetHref = user
    ? scored
      ? `/u/${user.login}`
      : `/?username=${encodeURIComponent(`https://github.com/${user.login}`)}`
    : null;

  return (
    <div className="sm:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? t("closeMenu") : t("openMenu")}
          className={`relative z-50 -me-2 -translate-y-0.5 h-11 w-11 rounded-none border-0 p-0 text-zinc-200 shadow-none transition-none focus-visible:ring-0 focus-visible:outline-none active:bg-transparent ${
            open
              ? "bg-transparent hover:bg-transparent"
              : "bg-transparent hover:bg-transparent"
          }`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="h-6 w-6" /> : <Menu className="h-5 w-5" />}
        </Button>

        <SheetContent
          id="mobile-menu"
          side="top"
          overlayClassName="top-14"
          className="top-14 rounded-b-lg border-b border-white/10 bg-popover/98 px-4 pb-5 pt-4 backdrop-blur-xl"
        >
          <div className="space-y-4">
            <GlobalSearch mobile />
            <NavLinks items={NAV_ITEMS} orientation="vertical" onNavigate={close} />

            <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
              {user ? (
                <>
                  <div className="flex items-center gap-3 px-4 py-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06]">
                      {user.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={user.image} alt={user.login} className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-sm font-semibold text-zinc-100">
                          {avatarFallback(user.login)}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-zinc-100">
                        @{user.login}
                      </div>
                      <div className="truncate text-xs text-zinc-500">
                        github.com/{user.login}
                      </div>
                    </div>
                  </div>

                  <div className="h-px bg-white/10" />

                  {targetHref ? (
                    <Link
                      href={targetHref}
                      onClick={close}
                      className="flex min-h-12 items-center justify-between gap-3 px-4 py-3 text-sm text-zinc-300 transition-colors hover:bg-white/[0.04] hover:text-zinc-100"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <UserRound className="h-4 w-4 shrink-0 text-zinc-400" />
                        <span className="truncate">
                          {scored ? tHeader("myProfile") : tHeader("judgeSelf")}
                        </span>
                      </span>
                      <ArrowUpRight className="h-4 w-4 shrink-0 text-zinc-500" />
                    </Link>
                  ) : null}

                  <div className="h-px bg-white/10" />

                  <Link
                    href="/following"
                    onClick={close}
                    className="flex min-h-12 items-center justify-between gap-3 px-4 py-3 text-sm text-zinc-300 transition-colors hover:bg-white/[0.04] hover:text-zinc-100"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Users className="h-4 w-4 shrink-0 text-zinc-400" />
                      <span className="truncate">{tFollow("menuLink")}</span>
                    </span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-zinc-500" />
                  </Link>

                  <div className="h-px bg-white/10" />
                </>
              ) : configured ? (
                <div className="px-4 py-4">
                  <Button
                    type="button"
                    variant="outline"
                    shape="pill"
                    className="h-11 w-full justify-center border-white/10 bg-white/[0.04] text-zinc-200 hover:bg-white/[0.07] hover:text-white"
                    onClick={() => {
                      close();
                      void signIn("github");
                    }}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 fill-current">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                    </svg>
                    {tHeader("signIn")}
                  </Button>
                </div>
              ) : null}

              <div className="h-px bg-white/10" />

              <a
                href={repoHref}
                target="_blank"
                rel="noopener noreferrer"
                title={tRepo("title")}
                className="flex min-h-12 items-center justify-between gap-3 px-4 py-3 text-sm text-zinc-300 transition-colors hover:bg-white/[0.04] hover:text-zinc-100"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 shrink-0 fill-current text-zinc-400">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                  </svg>
                  <span className="truncate">{tRepo("label")}</span>
                </span>
                <ArrowUpRight className="h-4 w-4 shrink-0 text-zinc-500" />
              </a>

              <div className="h-px bg-white/10" />

              <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3 text-sm text-zinc-300">
                  <Palette className="h-4 w-4 shrink-0 text-zinc-400" />
                  <span className="truncate">{tTheme("label")}</span>
                </div>
                <div className="shrink-0">
                  <ThemeToggle />
                </div>
              </div>

              <div className="h-px bg-white/10" />

              <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3 text-sm text-zinc-300">
                  <Languages className="h-4 w-4 shrink-0 text-zinc-400" />
                  <span className="truncate">{tLang("label")}</span>
                </div>
                <div className="shrink-0">
                  <LanguageSwitcher />
                </div>
              </div>

              {user ? (
                <>
                  <div className="h-px bg-white/10" />

                  <button
                    type="button"
                    onClick={() => {
                      close();
                      void signOut();
                    }}
                    className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-start text-sm text-zinc-300 transition-colors hover:bg-white/[0.04] hover:text-zinc-100"
                  >
                    <LogOut className="h-4 w-4 shrink-0 text-zinc-400" />
                    <span>{tHeader("signOut")}</span>
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

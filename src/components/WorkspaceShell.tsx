"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpRight, BookOpen, Bot, BriefcaseBusiness, Cable, Code2, FileUser, Flame, HandHeart, Menu, Newspaper, PanelLeftClose, PanelLeftOpen, Star, Swords, Trophy, X, type LucideIcon } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { BrandMark } from "./BrandMark";
import { GlobalSearch } from "./GlobalSearch";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { NAV_GROUPS } from "@/config/nav";
import { ThemeToggle } from "./ThemeToggle";
import { Sheet, SheetContent, SheetTitle, SheetTrigger, SheetClose } from "./ui/sheet";

const NAV_ICONS: Record<string, LucideIcon> = {
  flame: Flame, swords: Swords, trophy: Trophy, code: Code2, star: Star, newspaper: Newspaper,
  resume: FileUser, briefcase: BriefcaseBusiness, bot: Bot, cable: Cable,
};

function GitHubMark() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 fill-current"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>;
}

export function WorkspaceShell({ children, account, sponsor }: { children: ReactNode; account: ReactNode; sponsor: ReactNode }) {
  const t = useTranslations("sidebar");
  const nav = useTranslations("nav");
  const tRepo = useTranslations("repoLink");
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const active = (href: string) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  const sidebar = (mobile = false) => (
    <>
      <div className="workspace-brand">
        <Link href="/" onClick={() => setOpen(false)} aria-label="ghfind" className="workspace-brand-link">
          <BrandMark className="size-7 shrink-0" /><span className="sidebar-label">ghfind</span>
        </Link>
        {mobile ? <SheetClose className="shell-icon" aria-label={nav("closeMenu")}><X size={18} /></SheetClose> :
          <button className="shell-icon sidebar-collapse" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? t("expand") : t("collapse")} title={collapsed ? t("expand") : t("collapse")} aria-expanded={!collapsed}>
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>}
      </div>
      <div className="sidebar-search"><GlobalSearch mobile /></div>
      <nav className="workspace-navigation" aria-label={t("navigation")}>
        {NAV_GROUPS.map((group, index) => <div key={group.label ?? index} className="sidebar-group">
          {group.label && <p className="sidebar-group-label">
            <span>{nav(group.label)}</span>{group.beta && <span className="sidebar-soon">{nav("beta")}</span>}
          </p>}
          {group.items.map(item => {
            const Icon = NAV_ICONS[item.icon ?? ""] ?? Code2;
            const current = active(item.href ?? "/");
            return <Link key={item.key} href={item.href ?? "/"} prefetch={false} onClick={() => setOpen(false)}
              className="sidebar-link" data-featured={item.featured || undefined} aria-current={current ? "page" : undefined}
              title={nav(`hint.${item.key}`)} aria-label={nav(item.key)}>
              <Icon size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{nav(item.key)}</span>
              {item.new && <span className="sidebar-new-badge">new!</span>}
              {item.beta && <span className="sidebar-soon sidebar-label">{nav("beta")}</span>}
              {current && <span className="sidebar-active-dot" aria-hidden />}
            </Link>;
          })}
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <Link className="sidebar-link" href="/docs" prefetch={false} onClick={() => setOpen(false)} title={t("docs")} aria-label={t("docs")}><BookOpen size={18} strokeWidth={1.7} /><span className="sidebar-label">{t("docs")}</span><ArrowUpRight size={14} className="sidebar-label ms-auto" /></Link>
        <Link className="sidebar-link" href="/sponsor" prefetch={false} onClick={() => setOpen(false)} aria-current={active("/sponsor") ? "page" : undefined} title={t("sponsor")} aria-label={t("sponsor")}><HandHeart size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{t("sponsor")}</span>{active("/sponsor") && <span className="sidebar-active-dot" aria-hidden />}</Link>
        <div className="sidebar-account">{account}</div>
        <div className="sidebar-preferences">
          <LanguageSwitcher />
          <a className="navbar-action sidebar-repository-link" href="https://github.com/hikariming/ghfind" target="_blank" rel="noopener noreferrer" aria-label={tRepo("label")} title={tRepo("title")}>
            <GitHubMark />
          </a>
          <ThemeToggle />
        </div>
      </div>
    </>
  );

  return <div className="workspace-shell" data-collapsed={collapsed}>
    <a href="#workspace-content" className="workspace-skip">{t("skip")}</a>
    <aside className="workspace-sidebar">{sidebar()}</aside>
    <div className="workspace-body">
      <header className="workspace-mobile-bar">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild><button className="shell-icon workspace-mobile-trigger" aria-label={nav("openMenu")}><Menu size={20} /></button></SheetTrigger>
          <SheetContent side="left" className="workspace-mobile-sidebar" aria-describedby={undefined}>
            <SheetTitle className="sr-only">{t("navigation")}</SheetTitle>
            {sidebar(true)}
          </SheetContent>
        </Sheet>
        <Link href="/" className="workspace-mobile-brand" aria-label="ghfind"><BrandMark className="size-5" />ghfind</Link>
      </header>
      <div id="workspace-content" className="workspace-content" tabIndex={-1}>
        <div className="workspace-sponsor">{sponsor}</div>
        {children}
      </div>
    </div>
  </div>;
}

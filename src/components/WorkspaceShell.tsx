"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpRight, BookOpen, Bot, BriefcaseBusiness, Code2, FileUser, Flame, HandHeart, Menu, Newspaper, PanelLeftClose, PanelLeftOpen, Star, Swords, Trophy, X, type LucideIcon } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { BrandMark } from "./BrandMark";
import { GlobalSearch } from "./GlobalSearch";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { NAV_GROUPS } from "@/config/nav";
import { ThemeToggle } from "./ThemeToggle";
import { Sheet, SheetContent, SheetTitle, SheetTrigger, SheetClose } from "./ui/sheet";

const NAV_ICONS: Record<string, LucideIcon> = {
  flame: Flame, swords: Swords, trophy: Trophy, code: Code2, star: Star, newspaper: Newspaper,
  resume: FileUser, briefcase: BriefcaseBusiness, bot: Bot,
};

export function WorkspaceShell({ children, account, sponsor }: { children: ReactNode; account: ReactNode; sponsor: ReactNode }) {
  const t = useTranslations("sidebar");
  const nav = useTranslations("nav");
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
              {current && <span className="sidebar-active-dot" aria-hidden />}
            </Link>;
          })}
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <Link className="sidebar-link" href="/docs" prefetch={false} onClick={() => setOpen(false)} title={t("docs")} aria-label={t("docs")}><BookOpen size={18} strokeWidth={1.7} /><span className="sidebar-label">{t("docs")}</span><ArrowUpRight size={14} className="sidebar-label ms-auto" /></Link>
        <Link className="sidebar-link" href="/sponsor" prefetch={false} onClick={() => setOpen(false)} aria-current={active("/sponsor") ? "page" : undefined} title={t("sponsor")} aria-label={t("sponsor")}><HandHeart size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{t("sponsor")}</span>{active("/sponsor") && <span className="sidebar-active-dot" aria-hidden />}</Link>
        <div className="sidebar-preferences"><LanguageSwitcher /><ThemeToggle /></div>
        <div className="sidebar-account">{account}</div>
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

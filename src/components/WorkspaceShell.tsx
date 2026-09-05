"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpRight, BookOpen, BriefcaseBusiness, ChevronRight, Code2, Compass, FileUser, FolderOpen, Globe2, Menu, PanelLeftClose, PanelLeftOpen, Sparkles, Swords, Trophy, Users, X } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { NAV_ITEMS } from "@/config/nav";
import { BrandMark } from "./BrandMark";
import { GlobalSearch } from "./GlobalSearch";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeToggle } from "./ThemeToggle";
import { Sheet, SheetContent, SheetTitle, SheetTrigger, SheetClose } from "./ui/sheet";

const groups = [
  { key: "workspace", items: [{ key: "roast", href: "/", icon: Compass }, { key: "versus", href: "/vs", icon: Swords }] },
  { key: "discover", items: [
    { key: "leaderboard", href: "/leaderboard", icon: Trophy },
    { key: "developers", href: "/developers", icon: Users },
    { key: "projectBoards", href: "/projects", icon: Code2 },
    { key: "collections", href: "/collections", icon: FolderOpen },
    { key: "blog", href: "/blog", icon: BookOpen },
  ] },
];

export function WorkspaceShell({ children, account, sponsor }: { children: ReactNode; account: ReactNode; sponsor: ReactNode }) {
  const t = useTranslations("sidebar");
  const nav = useTranslations("nav");
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const active = (href: string) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  const current = NAV_ITEMS.flatMap(item => item.children ?? [item]).find(item => item.href && active(item.href));
  const pageLabel = current ? nav(current.key) : t("workspace");

  const sidebar = (mobile = false) => (
    <>
      <div className="workspace-brand">
        <Link href="/" onClick={() => setOpen(false)} aria-label="ghfind" className="workspace-brand-link">
          <BrandMark className="size-7 shrink-0" /><span className="sidebar-label">ghfind<span className="workspace-brand-caption">{t("tagline")}</span></span>
        </Link>
        {mobile ? <SheetClose className="shell-icon" aria-label={nav("closeMenu")}><X size={18} /></SheetClose> :
          <button className="shell-icon sidebar-collapse" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? t("expand") : t("collapse")} title={collapsed ? t("expand") : t("collapse")} aria-expanded={!collapsed}>
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>}
      </div>
      <div className="sidebar-search"><GlobalSearch mobile /></div>
      <nav className="workspace-navigation" aria-label={t("navigation")}>
        {groups.map(group => <div className="sidebar-group" key={group.key}>
          <p className="sidebar-group-label">{t(group.key)}</p>
          {group.items.map(({ key, href, icon: Icon }) => <Link key={key} href={href} prefetch={false} onClick={() => setOpen(false)} className="sidebar-link" aria-current={active(href) ? "page" : undefined} title={nav(key)} aria-label={nav(key)}>
            <Icon size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{nav(key)}</span>
            {active(href) && <span className="sidebar-active-dot" aria-hidden />}
          </Link>)}
        </div>)}
        <div className="sidebar-group">
          <p className="sidebar-group-label">{t("career")}</p>
          {[{ key: "resume", icon: FileUser }, { key: "talent", icon: BriefcaseBusiness }].map(({ key, icon: Icon }) => <button key={key} className="sidebar-link sidebar-upcoming" disabled aria-label={`${t(key)} · ${t("soon")}`} title={`${t(key)} · ${t("soon")}`}>
            <Icon size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{t(key)}</span><span className="sidebar-soon sidebar-label">{t("soon")}</span>
          </button>)}
        </div>
      </nav>
      <div className="sidebar-bottom">
        <Link className="sidebar-link" href="/docs" prefetch={false} onClick={() => setOpen(false)} title={t("docs")} aria-label={t("docs")}><BookOpen size={18} strokeWidth={1.7} /><span className="sidebar-label">{t("docs")}</span><ArrowUpRight size={14} className="sidebar-label ms-auto" /></Link>
        <div className="sidebar-preferences"><LanguageSwitcher /><ThemeToggle /></div>
        <div className="sidebar-account">{account}</div>
      </div>
    </>
  );

  return <div className="workspace-shell" data-collapsed={collapsed}>
    <a href="#workspace-content" className="workspace-skip">{t("skip")}</a>
    <aside className="workspace-sidebar">{sidebar()}</aside>
    <div className="workspace-body">
      <header className="workspace-topbar">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild><button className="shell-icon workspace-mobile-trigger" aria-label={nav("openMenu")}><Menu size={20} /></button></SheetTrigger>
          <SheetContent side="left" className="workspace-mobile-sidebar" aria-describedby={undefined}>
            <SheetTitle className="sr-only">{t("navigation")}</SheetTitle>
            {sidebar(true)}
          </SheetContent>
        </Sheet>
        <div className="workspace-breadcrumb"><span>ghfind</span><ChevronRight size={13} /><span>{pageLabel}</span></div>
        <div className="workspace-topbar-end"><span className="workspace-edition"><Sparkles size={13} />{t("edition")}</span><Link href="/developers" prefetch={false} className="workspace-explore"><Globe2 size={15} /><span>{nav("developers")}</span></Link></div>
      </header>
      <div id="workspace-content" className="workspace-content" tabIndex={-1}>
        <div className="workspace-sponsor">{sponsor}</div>
        {children}
      </div>
    </div>
  </div>;
}

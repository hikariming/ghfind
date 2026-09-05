"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpRight, BookOpen, BriefcaseBusiness, ChevronRight, Code2, Compass, FileUser, FolderOpen, Menu, PanelLeftClose, PanelLeftOpen, Swords, Trophy, Users, X } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
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
  const discoverActive = groups[1].items.some(item => active(item.href));
  const [discovery, setDiscovery] = useState<{ path: string; open: boolean } | null>(null);
  // Direct visits reveal the current destination; a manual toggle wins on that page.
  const discoverOpen = discovery?.path === pathname ? discovery.open : discoverActive;


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
        <div className="sidebar-group">
          {groups[0].items.map(({ key, href, icon: Icon }) => <Link key={key} href={href} prefetch={false} onClick={() => setOpen(false)} className="sidebar-link" aria-current={active(href) ? "page" : undefined} title={nav(key)} aria-label={nav(key)}>
            <Icon size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{nav(key)}</span>
            {active(href) && <span className="sidebar-active-dot" aria-hidden />}
          </Link>)}
          <button
            type="button"
            className="sidebar-link sidebar-discover"
            data-active={discoverActive}
            aria-label={nav("discover")}
            title={nav("discover")}
            aria-expanded={discoverOpen && (mobile || !collapsed)}
            aria-controls={mobile ? "mobile-discovery-links" : "desktop-discovery-links"}
            onClick={() => {
              const expandingRail = !mobile && collapsed;
              if (expandingRail) setCollapsed(false);
              setDiscovery({ path: pathname, open: expandingRail || !discoverOpen });
            }}
          >
            <FolderOpen size={18} strokeWidth={1.7} aria-hidden />
            <span className="sidebar-label">{nav("discover")}</span>
            <ChevronRight size={14} className="sidebar-label sidebar-discover-chevron" aria-hidden />
          </button>
          <div className="sidebar-submenu" id={mobile ? "mobile-discovery-links" : "desktop-discovery-links"} hidden={!discoverOpen || (!mobile && collapsed)}>
            {groups[1].items.map(({ key, href }) => <Link key={key} href={href} prefetch={false} onClick={() => setOpen(false)} className="sidebar-link" aria-current={active(href) ? "page" : undefined}>
              <span>{nav(key)}</span>{active(href) && <span className="sidebar-active-dot" aria-hidden />}
            </Link>)}
          </div>
        </div>
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

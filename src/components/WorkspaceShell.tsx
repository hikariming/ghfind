"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpRight, BookOpen, Bot, BriefcaseBusiness, ChevronRight, Code2, FileUser, FolderOpen, HandHeart, Menu, PanelLeftClose, PanelLeftOpen, Trophy, X } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { BrandMark } from "./BrandMark";
import { GlobalSearch } from "./GlobalSearch";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { NAV_ITEMS, type NavItem } from "@/config/nav";
import { ThemeToggle } from "./ThemeToggle";
import { Sheet, SheetContent, SheetTitle, SheetTrigger, SheetClose } from "./ui/sheet";

export function WorkspaceShell({ children, account, sponsor }: { children: ReactNode; account: ReactNode; sponsor: ReactNode }) {
  const t = useTranslations("sidebar");
  const nav = useTranslations("nav");
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const active = (href: string) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  const [folders, setFolders] = useState<Record<string, { path: string; open: boolean }>>({});
  const folder = (item: NavItem, mobile: boolean) => {
    const children = item.children ?? [];
    const selected = children.some(child => child.href && active(child.href));
    const expanded = folders[item.key]?.path === pathname ? folders[item.key].open : selected;
    const id = `${mobile ? "mobile" : "desktop"}-${item.key}-links`;
    return <div key={item.key}>
      <button type="button" className="sidebar-link sidebar-discover" data-active={selected}
        aria-label={nav(item.key)} title={nav(item.key)} aria-expanded={expanded && (mobile || !collapsed)} aria-controls={id}
        onClick={() => {
          const expandingRail = !mobile && collapsed;
          if (expandingRail) setCollapsed(false);
          setFolders(previous => ({ ...previous, [item.key]: { path: pathname, open: expandingRail || !expanded } }));
        }}>
        <FolderOpen size={18} strokeWidth={1.7} aria-hidden />
        <span className="sidebar-label">{nav(item.key)}</span>
        <ChevronRight size={14} className="sidebar-label sidebar-discover-chevron" aria-hidden />
      </button>
      <div className="sidebar-submenu" id={id} hidden={!expanded || (!mobile && collapsed)}>
        {children.map(child => <Link key={child.key} href={child.href ?? "/"} prefetch={false} onClick={() => setOpen(false)} className="sidebar-link" aria-current={child.href && active(child.href) ? "page" : undefined}>
          <span>{nav(child.key)}</span>{child.href && active(child.href) && <span className="sidebar-active-dot" aria-hidden />}
        </Link>)}
      </div>
    </div>;
  };

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
        <div className="sidebar-group">
          {NAV_ITEMS.map(item => {
            if (item.children) return folder(item, mobile);
            const Icon = item.icon === "trophy" ? Trophy : Code2;
            const href = item.href ?? "/";
            return <Link key={item.key} href={href} prefetch={false} onClick={() => setOpen(false)} className="sidebar-link" aria-current={active(href) ? "page" : undefined} title={nav(item.key)} aria-label={nav(item.key)}>
              <Icon size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{nav(item.key)}</span>
              {active(href) && <span className="sidebar-active-dot" aria-hidden />}
            </Link>;
          })}
        </div>
        <div className="sidebar-group">
          <p className="sidebar-group-label">{t("career")}</p>
          <Link href="/resume" prefetch={false} onClick={() => setOpen(false)} className="sidebar-link" aria-current={active("/resume") ? "page" : undefined} aria-label={t("resume")} title={t("resume")}><FileUser size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{t("resume")}</span><span className="sidebar-soon sidebar-label">{t("preview")}</span></Link>
          <Link href="/talent" prefetch={false} onClick={() => setOpen(false)} className="sidebar-link" aria-current={active("/talent") ? "page" : undefined} aria-label={t("talent")} title={t("talent")}>
            <BriefcaseBusiness size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{t("talent")}</span><span className="sidebar-soon sidebar-label">{t("preview")}</span>
          </Link>
        </div>
        <div className="sidebar-group">
          <p className="sidebar-group-label">{t("integrations")}</p>
          <Link href="/github-bot" prefetch={false} onClick={() => setOpen(false)} className="sidebar-link" aria-current={active("/github-bot") ? "page" : undefined} aria-label={t("githubBot")} title={t("githubBot")}>
            <Bot size={18} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{t("githubBot")}</span>{active("/github-bot") && <span className="sidebar-active-dot" aria-hidden />}
          </Link>
        </div>
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

"use client";

import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import type { NavItem } from "@/config/nav";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Primary nav links with active-state highlighting + dropdown submenus. Client
 * island: active state needs the current path. Uses `usePathname` from
 * `@/i18n/navigation` (NOT `next/navigation`) — locale-stripped, so
 * `/en/leaderboard` still matches an item whose `href` is `/leaderboard`.
 *
 * Items with `children` render as a dropdown parent: a CSS hover/focus panel on
 * desktop, and an inline indented group in the mobile (vertical) drawer.
 */
export function NavLinks({
  items,
  orientation = "horizontal",
  onNavigate,
}: {
  items: NavItem[];
  orientation?: "horizontal" | "vertical";
  onNavigate?: () => void;
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const vertical = orientation === "vertical";

  const isActive = (item: NavItem) =>
    item.href
      ? item.exact
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(`${item.href}/`)
      : false;
  const groupActive = (item: NavItem) =>
    isActive(item) || (item.children ?? []).some(isActive);

  const badge = (item: NavItem) =>
    item.badge ? (
      <span className="ms-1.5 rounded bg-amber-400/20 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-200">
        {item.badge}
      </span>
    ) : null;

  const linkItem = (item: NavItem) => {
    const active = isActive(item);
    const baseClass = vertical
      ? active
        ? "w-full rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 font-semibold text-zinc-100"
        : "w-full rounded-xl px-4 py-3 text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100"
      : active
        ? "font-semibold text-zinc-100"
        : "text-zinc-400 hover:text-zinc-200";
    return (
      <Link
        key={item.key}
        href={item.href ?? "/"}
        // The navbar mounts on every page, so prefetching each destination on
        // load is pure waste for the force-dynamic boards (/leaderboard,
        // /developers each = a full function invocation per viewport prefetch).
        // Keep prefetch only for the static home target.
        prefetch={item.href === "/" ? undefined : false}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={`group relative flex items-center text-sm transition-colors ${vertical ? "" : "px-3 py-2"} ${baseClass}`}
      >
        <span>{t(item.key)}</span>
        {badge(item)}
        {!vertical && (
          <span
            aria-hidden="true"
            className={`absolute inset-x-3 bottom-0 h-px rounded-full transition-opacity ${
              active
                ? "bg-orange-500/80 opacity-100"
                : "bg-white/20 opacity-0 group-hover:opacity-100"
            }`}
          />
        )}
      </Link>
    );
  };

  const dropdown = (item: NavItem) => {
    const active = groupActive(item);
    const children = item.children ?? [];
    if (vertical) {
      return (
        <div key={item.key} className="flex flex-col gap-1">
          <span className="px-4 pt-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            {t(item.key)}
          </span>
          {children.map((c) => linkItem(c))}
        </div>
      );
    }
    return (
      <DropdownMenu key={item.key}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`h-auto px-3 py-2 text-sm ${
              active
                ? "font-semibold text-zinc-100 hover:bg-transparent hover:text-zinc-100"
                : "text-zinc-400 hover:bg-transparent hover:text-zinc-200"
            }`}
          >
            {t(item.key)}
            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-[12rem] border-white/10 bg-popover/98 p-1.5 backdrop-blur-xl"
        >
          {children.map((c) => (
            <Link
              key={c.key}
              href={c.href ?? "/"}
              prefetch={c.href === "/" ? undefined : false}
              onClick={onNavigate}
              aria-current={isActive(c) ? "page" : undefined}
              className={`flex items-center rounded-xl px-3 py-2 text-sm transition-colors ${
                isActive(c)
                  ? "bg-white/[0.06] font-medium text-zinc-100"
                  : "text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100"
              }`}
            >
              {t(c.key)}
              {badge(c)}
            </Link>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <nav className={vertical ? "flex flex-col gap-1.5" : "flex items-center gap-1"}>
      {items.map((item) => (item.children ? dropdown(item) : linkItem(item)))}
    </nav>
  );
}

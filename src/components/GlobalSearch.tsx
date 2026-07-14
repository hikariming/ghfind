"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import type { DiscoverySearchResult } from "@/lib/search";
import { tierStyle } from "@/lib/tier";
import {
  buildGlobalSearchRows,
  nextSearchIndex,
} from "@/lib/global-search";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const EMPTY_RESULTS: DiscoverySearchResult = { users: [], repos: [], facets: [] };

export function GlobalSearch({ mobile = false }: { mobile?: boolean }) {
  const t = useTranslations("globalSearch");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DiscoverySearchResult>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rows = useMemo(() => buildGlobalSearchRows(results), [results]);

  useEffect(() => {
    const q = query.trim();
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!q) {
        setResults(EMPTY_RESULTS);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const response = await fetch(`/api/search-users?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (response.ok) setResults((await response.json()) as DiscoverySearchResult);
      } catch {
        if (!controller.signal.aborted) setResults(EMPTY_RESULTS);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const navigate = (href: string) => {
    setOpen(false);
    setQuery("");
    setResults(EMPTY_RESULTS);
    router.push(href);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={
            mobile
              ? "h-11 w-full justify-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 text-zinc-300"
              : "h-9 gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
          }
          aria-label={t("open")}
        >
          <Search className="h-4 w-4" />
          <span className={mobile ? "" : "hidden lg:inline"}>{t("trigger")}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-3 border-white/10 bg-zinc-950/98 p-4 backdrop-blur-xl sm:max-w-xl">
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-3 h-4 w-4 text-zinc-500" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const direction = event.key as "ArrowDown" | "ArrowUp";
                setActiveIndex((current) => nextSearchIndex(current, direction, rows.length));
              } else if (event.key === "Enter" && activeIndex >= 0 && rows[activeIndex]) {
                event.preventDefault();
                navigate(rows[activeIndex].href);
              } else if (event.key === "Escape") {
                setActiveIndex(-1);
              }
            }}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="global-search-results"
            aria-label={t("input")}
            placeholder={t("placeholder")}
            className="h-11 border-white/10 bg-white/[0.04] ps-9"
          />
        </div>
        <div id="global-search-results" role="listbox" className="max-h-[55vh] overflow-y-auto">
          {rows.map((row, index) => {
            const previous = index > 0 ? rows[index - 1].group : null;
            const style = row.tier ? tierStyle(row.tier) : null;
            return (
              <div key={row.key}>
                {row.group !== previous && (
                  <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    {t(`group.${row.group}`)}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={activeIndex === index}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => navigate(row.href)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors ${
                    activeIndex === index
                      ? "bg-white/[0.08] text-zinc-100"
                      : "text-zinc-300 hover:bg-white/[0.05]"
                  }`}
                >
                  {row.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={row.avatarUrl} alt="" className="h-7 w-7 rounded-full" />
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-xs text-zinc-500">
                      {row.group === "repos" ? "◫" : row.group === "facets" ? "#" : "@"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.label}</span>
                  <span className={`shrink-0 text-xs ${style?.text ?? "text-zinc-500"}`}>
                    {style?.emoji} {row.meta}
                  </span>
                </button>
              </div>
            );
          })}
          {query.trim() && !loading && rows.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-zinc-500">{t("empty")}</p>
          )}
          {loading && <p className="px-3 py-6 text-center text-sm text-zinc-500">{t("loading")}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

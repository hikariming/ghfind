"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import {
  readExplorationHistory,
  visibleExplorationItems,
  type ExplorationItem,
} from "@/lib/exploration-history";
import { trackEvent } from "@/lib/track";

export function ContinueExploring() {
  const t = useTranslations("continueExploring");
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const items: ExplorationItem[] = hydrated
    ? visibleExplorationItems(readExplorationHistory(), pathname, 4)
    : [];

  if (items.length === 0) return null;

  return (
    <section className="mx-auto mt-10 w-full max-w-2xl rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <h2 className="text-base font-bold text-zinc-100">{t("title")}</h2>
      <p className="mt-1 text-xs text-zinc-500">{t("subtitle")}</p>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <Link
            key={`${item.kind}:${item.key}`}
            href={item.href}
            prefetch={false}
            onClick={() =>
              trackEvent("continue_exploring_click", {
                kind: item.kind,
                subject: item.key,
              })
            }
            className="rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2 transition hover:bg-white/[0.06]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold text-zinc-200">{item.title}</span>
              <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-orange-300/80">
                {t(item.kind)}
              </span>
            </div>
            {item.subtitle && (
              <p className="mt-1 line-clamp-1 text-xs text-zinc-500">{item.subtitle}</p>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}

function emptySubscribe() {
  return () => undefined;
}

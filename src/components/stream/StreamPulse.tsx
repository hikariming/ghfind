"use client";

import { motion } from "motion/react";
import { Flame } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { StreamPulse as Pulse } from "@/lib/stream/types";
import { compactNumber, tierIconSrc } from "./format";
import { StreamAvatar } from "./StreamCard";

/**
 * Real site activity above the stream: how many developers have been scored
 * and who people looked up in the last 24h. Low per-item engagement reads as
 * a quiet site; aggregate, real activity does not.
 */
export function StreamPulse({ pulse, onOpenUser }: { pulse: Pulse; onOpenUser: (username: string) => void }) {
  const t = useTranslations("stream");
  const locale = useLocale();
  if (pulse.totalScored == null && pulse.trending.length === 0) return null;
  return (
    <section className="border-b border-border px-3 py-2.5 sm:px-4">
      <div className="flex items-center gap-2 text-xs">
        <span className="relative inline-flex size-2 shrink-0">
          <motion.span
            className="absolute inline-flex size-full rounded-full bg-emerald-400"
            animate={{ scale: [1, 2.2], opacity: [0.6, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
        </span>
        {pulse.totalScored != null ? (
          <span className="font-semibold text-foreground">{t("pulseTotal", { count: pulse.totalScored.toLocaleString(locale) })}</span>
        ) : null}
        {pulse.trending.length > 0 ? (
          <span className="ms-auto inline-flex items-center gap-1 text-muted-foreground">
            <Flame className="size-3.5 text-orange-300" aria-hidden />
            {t("pulseTrending")}
          </span>
        ) : null}
      </div>
      {pulse.trending.length > 0 ? (
        <div className="-mx-3 mt-2 flex gap-1.5 overflow-x-auto px-3 [scrollbar-width:none] sm:-mx-4 sm:px-4">
          {pulse.trending.map((entry) => (
            <button
              key={entry.username}
              type="button"
              onClick={() => onOpenUser(entry.username)}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card py-1 pe-2.5 ps-1 text-start hover:border-foreground/20"
            >
              <StreamAvatar src={entry.avatarUrl} name={entry.name} className="size-6 text-[10px]" />
              <span className="leading-tight">
                <span className="flex items-center gap-0.5 text-xs font-semibold text-foreground">
                  <span className="max-w-24 truncate">{entry.name}</span>
                  <span className="tabular-nums text-muted-foreground">{entry.score}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element -- static tier artwork */}
                  <img src={tierIconSrc(entry.tier)} alt="" className="size-3" />
                </span>
                <span className="block text-[10px] text-muted-foreground">{t("pulseLookups", { count: compactNumber(entry.lookups, locale) })}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

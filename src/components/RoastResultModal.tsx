"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SITE_URL } from "@/lib/site";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import { trackEvent } from "@/lib/track";
import type { RoastLine, RoastMeta } from "@/lib/types";
import { CopyBadge } from "./CopyBadge";
import { ProfileShare } from "./ProfileShare";
import { TierAvatarFrame } from "./TierAvatarFrame";

/**
 * The share-first result popup for a homepage arrival on a profile page. Opens
 * IMMEDIATELY with whatever is known (stored roast, or the deterministic scan
 * score while the LLM still writes) — it is a flex card, not a report viewer:
 * identity pill + crowned avatar + big score + tier + tags + orgs (deliberately
 * NO display name / bio — the handle is the brand), the savage one-liner below,
 * then exactly the share actions: save image, share menu, GitHub badge builder.
 * The full report lives on the page underneath; closing the popup reveals it.
 */
export function RoastResultModal({
  open,
  onClose,
  username,
  name,
  avatarUrl,
  meta,
  orgs,
  pendingLine = false,
}: {
  open: boolean;
  onClose: () => void;
  username: string;
  /** Only forwarded to the share-card renderer; never shown in the popup. */
  name: string | null;
  avatarUrl: string | null;
  meta: RoastMeta;
  /** Org handles for the card footer (e.g. a university/company badge). */
  orgs?: string[];
  /** True while a roast is still streaming and no one-liner has arrived yet —
   * shows a small "warming up" row where the 辣评 will land. */
  pendingLine?: boolean;
}) {
  const t = useTranslations("detail");
  const tTier = useTranslations("tiers");
  const locale = useLocale();
  const [showBadge, setShowBadge] = useState(false);

  const style = tierStyle(meta.tier);
  const tierKey = TIER_KEY[meta.tier];
  const line = pickLine(meta.roast_line, locale);
  const tags = [...(meta.tags?.zh ?? []), ...(meta.tags?.en ?? [])];
  const beat = meta.percentile?.beat ?? null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] w-[min(calc(100vw-2rem),26rem)] overflow-y-auto">
        <DialogClose
          aria-label={t("modalClose")}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </DialogClose>
        {/* Visually hidden: Radix requires a DialogTitle for screen readers,
            but the flex card speaks for itself — no headline above it. */}
        <DialogTitle className="sr-only">{t("modalTitle")}</DialogTitle>

        {/* Flex card — mirrors the profile identity card, minus name/bio. */}
        <div
          className={`flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-center ring-1 ${style.ring}`}
          style={{ boxShadow: `0 0 60px -24px ${style.glow}` }}
        >
          <span
            className={`inline-block max-w-full break-all rounded-full bg-black/35 px-4 py-1.5 text-lg font-black leading-tight ${style.text} ring-1 ${style.ring}`}
            style={{ boxShadow: `0 0 28px -10px ${style.glow}` }}
          >
            @{username}
          </span>
          <TierAvatarFrame
            username={username}
            avatarUrl={avatarUrl}
            tier={meta.tier}
            size="lg"
            className="mt-4"
          />
          <div className={`mt-3 text-5xl font-black tabular-nums ${style.text}`}>
            {meta.final_score.toFixed(2)}
            <span className="text-xl text-zinc-600">/100</span>
          </div>
          <div className={`mt-1 text-xl font-bold ${style.text}`}>
            {style.emoji} {tTier(`${tierKey}.name`)}
          </div>
          <div className="mt-1 text-sm font-medium text-zinc-300">
            {tTier(`${tierKey}.blurb`)}
          </div>
          {meta.percentile &&
            (meta.percentile.beat === null ? (
              <div className="mt-2 text-xs text-zinc-400">{t("modalFirstJudged")}</div>
            ) : (
              <div className="mt-2 text-xs text-zinc-400">
                {t("modalBeat", {
                  beat: meta.percentile.beat.toFixed(1),
                  total: meta.percentile.total,
                })}
              </div>
            ))}
          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {tags.map((tag, i) => (
                <span
                  key={`${tag}-${i}`}
                  className="rounded-full border border-orange-400/30 bg-orange-500/10 px-2.5 py-0.5 text-xs font-medium text-orange-200"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
          {orgs && orgs.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
              {orgs.map((org) => (
                <span
                  key={org}
                  className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs text-zinc-300"
                >
                  🏛 {org}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Savage one-liner — or a warming-up row while the LLM still writes. */}
        {line ? (
          <p className="rounded-xl border border-orange-500/30 bg-orange-500/[0.08] p-4 text-[0.95rem] leading-relaxed text-zinc-100">
            🔥 {line}
          </p>
        ) : pendingLine ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-orange-500/20 bg-orange-500/[0.05] p-3 text-sm text-zinc-400">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-orange-300/40 border-t-orange-200" />
            {t("livePending")}
          </div>
        ) : null}

        {/* Share actions: save image + share menu, then the badge builder.
            min-w-0: the builder's <pre> snippets are long unbreakable lines —
            without it their min-content width blows the dialog's grid track
            past the dialog itself. Constrained, they scroll internally. */}
        <div className="flex min-w-0 flex-col gap-2">
          <ProfileShare
            username={username}
            name={name}
            avatarUrl={avatarUrl}
            score={meta.final_score}
            tier={meta.tier}
            tierLabel={tTier(`${tierKey}.blurb`)}
            beat={beat}
            tags={meta.tags ?? { zh: [], en: [] }}
          />
          <button
            type="button"
            onClick={() => {
              setShowBadge((v) => !v);
              if (!showBadge) trackEvent("modal_cta_click", { cta: "badge" });
            }}
            aria-expanded={showBadge}
            className="flex w-full items-center justify-center gap-1.5 rounded-full border border-orange-400/40 px-4 py-2 text-sm font-semibold text-orange-200 transition hover:bg-orange-500/10"
          >
            <span aria-hidden>🃏</span>
            {t("modalBadgeCta")}
          </button>
          {showBadge && (
            <div className="min-w-0 overflow-x-hidden rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <CopyBadge
                baseUrl={SITE_URL}
                username={username}
                version={meta.final_score}
                surface="modal"
              />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-full border border-white/10 px-4 py-2 text-sm text-zinc-300 hover:bg-white/10"
        >
          {t("modalViewProfile")}
        </button>
      </DialogContent>
    </Dialog>
  );
}

function pickLine(line: RoastLine | undefined, locale: string): string {
  if (!line) return "";
  return locale === "en" ? line.en : line.zh;
}

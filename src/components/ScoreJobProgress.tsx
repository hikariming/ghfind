"use client";

import { useTranslations } from "next-intl";
import type { ScanJobStatus } from "@/lib/scan-job-client";

/**
 * Shared "computing" surface for the background devscore job: headline, the
 * collector's current phase, and (when the job reports it) a progress bar with
 * the percent. Used by the Roaster scan card, the rescan/summon buttons, and
 * the profile pending shell while a first-time score is still being computed.
 *
 * `status: null` renders the generic computing label — the job exists but the
 * first status frame hasn't arrived yet.
 */
export function ScoreJobProgress({
  status,
  username,
  compact = false,
}: {
  status: ScanJobStatus | null;
  username?: string;
  compact?: boolean;
}) {
  const t = useTranslations("scoreJob");
  const phaseKey = status?.phase;
  const phaseLabel =
    phaseKey && t.has(`phase.${phaseKey}`) ? t(`phase.${phaseKey}`) : t("phase.running");
  const percent =
    typeof status?.progress === "number" && Number.isFinite(status.progress)
      ? Math.round(Math.min(1, Math.max(0, status.progress)) * 100)
      : null;

  if (compact) {
    return (
      <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border border-orange-300/40 border-t-orange-200" />
        <span className="tabular-nums">
          {t("computing")}
          {username ? ` @${username}` : ""} · {phaseLabel}
          {percent !== null ? ` ${percent}%` : "…"}
        </span>
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex w-full max-w-md flex-col items-center gap-3 text-center"
    >
      <div className="flex items-center gap-2.5">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-orange-300/40 border-t-orange-200" />
        <span className="text-lg font-bold text-zinc-100">
          {t("computing")}
          {username ? (
            <span className="ml-1.5 font-medium text-orange-300">@{username}</span>
          ) : null}
        </span>
      </div>
      <div className="text-sm text-zinc-400">{phaseLabel}</div>
      {percent !== null && (
        <div className="w-full">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
          >
            <div
              className="h-full rounded-full bg-orange-500 transition-[width] duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-1.5 text-xs tabular-nums text-zinc-500">
            {t("progress", { percent: `${percent}%` })}
          </div>
        </div>
      )}
      <p className="text-xs leading-relaxed text-zinc-500">{t("computingHint")}</p>
    </div>
  );
}

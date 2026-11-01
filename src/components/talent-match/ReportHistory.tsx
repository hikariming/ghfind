"use client";

import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, History, Loader2 } from "lucide-react";
import type { ReportSummary } from "@/lib/talent-match/client";
import { Card, fitTone } from "./parts";

/**
 * The signed-in owner's past candidate reports, newest first. Finished and
 * in-progress reports open in place; failed ones are listed for the record.
 */
export function ReportHistory({
  history,
  currentId,
  openingId,
  error,
  onOpen,
}: {
  history: ReportSummary[];
  /** The report on screen, highlighted in the list. */
  currentId: string | null;
  /** The report being loaded after a click. */
  openingId: string | null;
  error: boolean;
  onOpen: (summary: ReportSummary) => void;
}) {
  const t = useTranslations("talentMatch.history");
  const locale = useLocale();
  const zh = locale === "zh";
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <Card title={t("title")} aside={<History className="h-4 w-4 text-zinc-500" aria-hidden="true" />}>
      {error && <p role="alert" className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-rose-400">{t("openFailed")}</p>}
      {history.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {history.map((item) => {
            const current = item.id === currentId;
            const opening = item.id === openingId;
            const openable = item.status !== "failed" && !current;
            const headline = item.headline ? (zh ? item.headline.zh : item.headline.en) : t("untitled");
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-100">{headline}</span>
                  <span className="block text-xs text-zinc-500">
                    <time dateTime={item.createdAt}>{date.format(Date.parse(item.createdAt))}</time>
                    {item.status === "done" && <> · {t("matches", { count: item.matchCount })}</>}
                  </span>
                </span>
                {item.status === "done" && item.topFit !== null && (
                  <span className={`shrink-0 text-xs tabular-nums ${fitTone(item.topFit)}`}>{t("topFit", { fit: item.topFit })}</span>
                )}
                {(item.status === "queued" || item.status === "running") && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />{t("running")}
                  </span>
                )}
                {item.status === "failed" && <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-zinc-500">{t("failed")}</span>}
                {current ? (
                  <span className="shrink-0 rounded-full border border-orange-400/30 px-2 py-0.5 text-[11px] text-orange-300">{t("viewing")}</span>
                ) : opening ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-zinc-500" aria-label={t("opening")} />
                ) : openable ? (
                  <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                ) : null}
              </>
            );
            const rowClass = `flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${current ? "border-orange-400/30 bg-orange-500/10" : "border-white/10"}`;
            return (
              <li key={item.id}>
                {openable ? (
                  <button type="button" className={`${rowClass} transition-colors hover:bg-white/5`} disabled={openingId !== null} onClick={() => onOpen(item)}>
                    {body}
                  </button>
                ) : (
                  <div className={rowClass} aria-current={current ? "true" : undefined}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

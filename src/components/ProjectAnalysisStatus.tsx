"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useMountEffect } from "@/hooks/useMountEffect";
import { AnalysisReport } from "@/components/AnalysisReport";
import type { PublicProjectAnalysisView } from "@/lib/project-analysis-service";
import { ProjectProductTags } from "@/components/ProjectProductTags";
import {
  exposureBandLabel,
  riskCategoryLabel,
  riskSeverityLabel,
  verificationLevelLabel,
} from "@/lib/project-analysis-labels";

const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function activityTimeLabel(occurredAt: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(occurredAt));
}

export function ProjectAnalysisStatus({ initial }: { initial: PublicProjectAnalysisView }) {
  const t = useTranslations("projectAnalysis");
  const locale = useLocale();
  const [view, setView] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const terminalRef = useRef(TERMINAL.has(initial.status));

  useMountEffect(() => {
    if (terminalRef.current) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch(`/api/project-analyses/${initial.analysisId}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const next = (await response.json()) as PublicProjectAnalysisView & {
          message?: string;
        };
        if (!response.ok) throw new Error(next.message || t("pollFailed"));
        setView(next);
        setPollError(null);
        terminalRef.current = TERMINAL.has(next.status);
      } catch (error) {
        if (controller.signal.aborted) return;
        setPollError(error instanceof Error ? error.message : t("pollFailed"));
      }
      if (!terminalRef.current && !controller.signal.aborted) {
        timer = setTimeout(poll, 3_000);
      }
    }

    timer = setTimeout(poll, 1_000);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  });

  const assessment = view.assessment;
  const encodedRepo = view.repoKey.split("/").map(encodeURIComponent).join("/");

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-zinc-500">{view.repoKey}</p>
            {view.requestedRef && (
              <p className="mt-1 font-mono text-xs text-zinc-600">
                {t("requestedRef")} {view.requestedRef}
              </p>
            )}
            <h1 className="mt-1 text-2xl font-black text-zinc-100">
              {t(`status.${view.status}`)}
            </h1>
            <p className="mt-1 text-sm text-zinc-400">{t(`phase.${view.phase}`)}</p>
          </div>
          <div className="text-right text-3xl font-black tabular-nums text-orange-300">
            {view.progress}%
            <p className="mt-1 text-xs font-normal text-zinc-500">
              {t("duration")} {durationLabel((view.completedAt ?? view.updatedAt) - view.createdAt)}
            </p>
          </div>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/5">
          <div className="h-full bg-orange-500" style={{ width: `${view.progress}%` }} />
        </div>
        {view.activities.length > 0 && (
          <div className="mt-5 border-t border-white/10 pt-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
              {t("activityTitle")}
            </h2>
            <ol className="mt-3 space-y-2">
              {view.activities.slice(-6).map((activity, index, activities) => {
                const isLatest = index === activities.length - 1;
                return (
                  <li
                    key={activity.id}
                    className="grid grid-cols-[auto_1fr_auto] items-center gap-3 text-sm"
                  >
                    <span
                      aria-hidden
                      className={`h-2 w-2 rounded-full ${
                        isLatest ? "bg-orange-400" : "bg-zinc-600"
                      }`}
                    />
                    <span className={isLatest ? "text-zinc-200" : "text-zinc-500"}>
                      {t(`activity.${activity.kind}`)}
                    </span>
                    <time
                      dateTime={activity.occurredAt}
                      className="font-mono text-xs tabular-nums text-zinc-600"
                    >
                      {activityTimeLabel(activity.occurredAt, locale)}
                    </time>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {pollError && <p className="mt-3 text-sm text-amber-300">{pollError}</p>}
        {view.error && (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-zinc-300"
          >
            {t(
              view.error.code === "artifact_invalid"
                ? "errors.invalidArtifact"
                : "errors.generic",
            )}
            <div>
              <Link href="/projects" className="mt-2 inline-block font-semibold text-orange-200 hover:underline">
                {t("retry")} →
              </Link>
            </div>
          </div>
        )}
      </section>

      {assessment && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              [t("scores.product"), assessment.productScore, 100],
              [t("scores.pain"), assessment.painScore, 25],
              [t("scores.effectiveness"), assessment.effectivenessScore, 30],
              [t("scores.experience"), assessment.experienceScore, 30],
              [t("scores.valueDensity"), assessment.valueDensityScore, 15],
            ].map(([label, score, maximum]) => (
              <div key={String(label)} className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
                <div className="text-2xl font-black tabular-nums text-zinc-100">
                  {score}<span className="text-sm text-zinc-600">/{maximum}</span>
                </div>
                <div className="mt-1 text-xs text-zinc-500">{label}</div>
              </div>
            ))}
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <ProjectProductTags
              tags={assessment.analysis.project.product_tags}
              locale={locale}
              className="mb-3"
            />
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-zinc-300">
                {t("confidence")} {assessment.confidence}%
              </span>
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-zinc-300">
                {verificationLevelLabel(assessment.verificationLevel, locale)}
              </span>
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-zinc-300">
                {t("exposure")} {exposureBandLabel(assessment.exposureBand, locale)}
              </span>
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-zinc-300">
                {t("communityStrength")} {assessment.communityStrength}/100
              </span>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-zinc-300">
              {assessment.analysis.project.summary}
            </p>
            <p className="mt-2 font-mono text-xs text-zinc-600">
              commit {assessment.resolvedCommitSha}
            </p>
          </section>

          {(assessment.unknowns.length > 0 || assessment.risks.length > 0) && (
            <section className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
                <h2 className="font-bold text-zinc-100">{t("unknowns")}</h2>
                {assessment.unknowns.length > 0 ? (
                  <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-zinc-400">
                    {assessment.unknowns.map((unknown) => <li key={unknown}>{unknown}</li>)}
                  </ul>
                ) : <p className="mt-3 text-sm text-zinc-500">{t("none")}</p>}
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
                <h2 className="font-bold text-zinc-100">{t("risks")}</h2>
                {assessment.risks.length > 0 ? (
                  <ul className="mt-3 space-y-2 text-sm text-zinc-400">
                    {assessment.risks.map((risk) => (
                      <li key={`${risk.category}:${risk.summary}`}>
                        <strong className="text-zinc-300">
                          {riskSeverityLabel(risk.severity, locale)} · {riskCategoryLabel(risk.category, locale)}
                        </strong>{" "}
                        {risk.summary}
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-3 text-sm text-zinc-500">{t("none")}</p>}
              </div>
            </section>
          )}

          <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <AnalysisReport markdown={assessment.reportMarkdown} />
          </article>

          <Link
            href={`/developers/repo/${encodedRepo}`}
            className="inline-block text-sm font-semibold text-orange-300 hover:underline"
          >
            {t("viewProject")} →
          </Link>
        </>
      )}
    </div>
  );
}

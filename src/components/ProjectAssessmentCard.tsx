import { ArrowRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { ProjectAssessment } from "@/lib/project-analysis-db";
import { ProjectProductTags } from "@/components/ProjectProductTags";

export interface ProjectAssessmentCardLabels {
  productScore: string;
  confidence: string;
  communityStrength: string;
  viewReport: string;
  treasure: string;
  classic: string;
  unranked: string;
}

export function ProjectAssessmentCard({
  assessment,
  labels,
  locale,
  variant = "default",
}: {
  assessment: ProjectAssessment;
  labels: ProjectAssessmentCardLabels;
  locale: string;
  variant?: "default" | "compact";
}) {
  const analysis = assessment.analysis;
  if (variant === "compact") {
    const separator = assessment.repoKey.indexOf("/");
    const owner = separator < 0 ? "" : assessment.repoKey.slice(0, separator + 1);
    const name = assessment.repoKey.slice(separator + 1);
    const board = assessment.treasureEligible
      ? labels.treasure
      : assessment.classicEligible ? labels.classic : labels.unranked;

    return (
      <article
        aria-label={`${assessment.repoKey} · ${board}`}
        className="content-card assessment-card assessment-card-compact flex h-full w-full min-w-0 flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4"
      >
        <div className="flex min-w-0 items-center gap-3">
          <a
            href={analysis.repository.canonical_url}
            target="_blank"
            rel="noopener noreferrer"
            title={assessment.repoKey}
            className="min-w-0 flex-1 truncate py-2 text-base text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="text-muted-foreground">{owner}</span>
            <strong className="font-semibold">{name}</strong>
          </a>
          <div className="flex shrink-0 items-baseline gap-1.5 rounded-md bg-white/5 px-2 py-1">
            <span className="text-xl font-semibold tabular-nums text-orange-300">{assessment.productScore}</span>
            <span className="text-xs text-muted-foreground">{labels.productScore}</span>
          </div>
        </div>
        <p title={analysis.project.summary} className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
          {analysis.project.summary}
        </p>
        <ProjectProductTags tags={analysis.project.product_tags} locale={locale} compact />
        <div className="flex items-center justify-between gap-3 text-xs">
          <div className="min-w-0 text-muted-foreground">
            <span className="block">{labels.confidence} {assessment.confidence}%</span>
            <span className="block">{labels.communityStrength} {assessment.communityStrength}/100</span>
          </div>
          <Link
            href={`/projects/analyses/${assessment.latestAnalysisId}`}
            className="flex min-h-11 shrink-0 items-center gap-1 font-semibold text-orange-300 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {labels.viewReport}<ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </div>
      </article>
    );
  }
  return (
    <article className="content-card assessment-card h-full w-full rounded-2xl border border-white/10 bg-white/[0.035] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <a
            href={analysis.repository.canonical_url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-lg font-black text-zinc-100 hover:text-white hover:underline"
          >
            {assessment.repoKey}
          </a>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">
            {analysis.project.summary}
          </p>
        </div>
        <div className="text-right">
          <div className="assessment-score text-3xl font-black tabular-nums text-orange-300">
            {assessment.productScore}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">
            {labels.productScore}
          </div>
        </div>
      </div>
      <ProjectProductTags
        tags={analysis.project.product_tags}
        locale={locale}
        className="mt-4"
      />
      <div className="assessment-meta mt-4 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-white/5 px-2.5 py-1 text-zinc-300">
          {labels.confidence} {assessment.confidence}%
        </span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 text-zinc-300">
          {labels.communityStrength} {assessment.communityStrength}/100
        </span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 text-zinc-300">
          {assessment.treasureEligible
            ? labels.treasure
            : assessment.classicEligible
              ? labels.classic
              : labels.unranked}
        </span>
      </div>
      <Link
        href={`/projects/analyses/${assessment.latestAnalysisId}`}
        className="mt-4 inline-block text-sm font-semibold text-orange-300 hover:underline"
      >
        {labels.viewReport} →
      </Link>
    </article>
  );
}

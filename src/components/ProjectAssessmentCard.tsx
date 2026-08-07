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
}: {
  assessment: ProjectAssessment;
  labels: ProjectAssessmentCardLabels;
  locale: string;
}) {
  const analysis = assessment.analysis;
  return (
    <article className="h-full w-full rounded-2xl border border-white/10 bg-white/[0.035] p-5">
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
          <div className="text-3xl font-black tabular-nums text-orange-300">
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
      <div className="mt-4 flex flex-wrap gap-2 text-xs">
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

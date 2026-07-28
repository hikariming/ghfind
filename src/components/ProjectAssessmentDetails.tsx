import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProjectProductTags } from "@/components/ProjectProductTags";
import {
  exposureBandLabel,
  verificationLevelLabel,
} from "@/lib/project-analysis-labels";
import type {
  ProjectAssessment,
  TreasureHistoryEntry,
} from "@/lib/project-analysis-db";

export interface ProjectAssessmentDetailsLabels {
  productScore: string;
  pain: string;
  effectiveness: string;
  experience: string;
  valueDensity: string;
  confidence: string;
  communityStrength: string;
  exposure: string;
  stars: string;
  commit: string;
  analysisTime: string;
  productContract: string;
  targetUsers: string;
  painStatement: string;
  dimensionEvidence: string;
  unknowns: string;
  risks: string;
  none: string;
  treasureHistory: string;
  selectedAt: string;
  report: string;
  historyStatus: Record<TreasureHistoryEntry["status"], string>;
}

export function ProjectAssessmentDetails({
  assessment,
  treasureHistory,
  labels,
  locale,
}: {
  assessment: ProjectAssessment;
  treasureHistory: TreasureHistoryEntry[];
  labels: ProjectAssessmentDetailsLabels;
  locale: string;
}) {
  const analysis = assessment.analysis;
  const dimensions = [
    [labels.pain, analysis.scores.pain],
    [labels.effectiveness, analysis.scores.effectiveness],
    [labels.experience, analysis.scores.experience],
    [labels.valueDensity, analysis.scores.value_density],
  ] as const;
  const formatDate = (timestamp: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(timestamp),
    );

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <ScoreCell label={labels.productScore} score={assessment.productScore} maximum={100} accent />
        {dimensions.map(([label, dimension]) => (
          <ScoreCell
            key={label}
            label={label}
            score={dimension.score}
            maximum={dimension.max_score}
          />
        ))}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
        <ProjectProductTags
          tags={analysis.project.product_tags}
          locale={locale}
          className="mb-3"
        />
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge>{labels.confidence} {assessment.confidence}%</Badge>
          <Badge>{verificationLevelLabel(assessment.verificationLevel, locale)}</Badge>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SignalCard
            label={labels.communityStrength}
            value={`${assessment.communityStrength}/100`}
            description={analysis.community_strength.rationale}
          />
          <SignalCard
            label={labels.exposure}
            value={exposureBandLabel(assessment.exposureBand, locale)}
            description={`${analysis.exposure.rationale}${assessment.stars === null ? "" : ` · ${labels.stars} ${assessment.stars}`}`}
          />
        </div>
        <dl className="mt-4 grid gap-2 text-xs text-zinc-500 sm:grid-cols-2">
          <div><dt className="inline font-semibold text-zinc-400">{labels.commit}: </dt><dd className="inline break-all font-mono">{assessment.resolvedCommitSha}</dd></div>
          <div><dt className="inline font-semibold text-zinc-400">{labels.analysisTime}: </dt><dd className="inline">{formatDate(assessment.analyzedAt)}</dd></div>
        </dl>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
        <h2 className="font-bold text-zinc-100">{labels.productContract}</h2>
        <p className="mt-3 text-sm leading-relaxed text-zinc-300">{analysis.project.summary}</p>
        <h3 className="mt-4 text-sm font-semibold text-zinc-200">{labels.targetUsers}</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-400">
          {analysis.project.target_users.map((target) => <li key={target}>{target}</li>)}
        </ul>
        <h3 className="mt-4 text-sm font-semibold text-zinc-200">{labels.painStatement}</h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">{analysis.project.pain_statement}</p>
      </section>

      <section>
        <h2 className="mb-3 font-bold text-zinc-100">{labels.dimensionEvidence}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {dimensions.map(([label, dimension]) => (
            <article key={label} className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold text-zinc-100">{label}</h3>
                <span className="font-mono text-sm text-orange-300">{dimension.score}/{dimension.max_score}</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">{dimension.rationale}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <ListCard title={labels.unknowns} empty={labels.none} items={assessment.unknowns} />
        <ListCard
          title={labels.risks}
          empty={labels.none}
          items={assessment.risks.map((risk) => `${risk.severity} · ${risk.category}: ${risk.summary}`)}
        />
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
        <h2 className="font-bold text-zinc-100">{labels.treasureHistory}</h2>
        {treasureHistory.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">{labels.none}</p>
        ) : (
          <ol className="mt-3 space-y-3 text-sm text-zinc-400">
            {treasureHistory.map((entry) => (
              <li key={entry.id} className="rounded-xl border border-white/10 p-3">
                <strong className="text-zinc-200">{labels.historyStatus[entry.status]}</strong>
                <span className="ml-2">{labels.selectedAt} {formatDate(entry.selectedAt)}</span>
                <p className="mt-1">{entry.reason}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
        <h2 className="mb-4 font-bold text-zinc-100">{labels.report}</h2>
        <div className="prose prose-invert max-w-none break-words prose-headings:text-zinc-100 prose-p:text-zinc-300 prose-li:text-zinc-300 prose-a:text-orange-300 [&_code]:break-all [&_pre]:overflow-x-auto">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{ img: () => null }}
          >
            {assessment.reportMarkdown}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  );
}

function ScoreCell({
  label,
  score,
  maximum,
  accent = false,
}: {
  label: string;
  score: number;
  maximum: number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <div className={`text-2xl font-black tabular-nums ${accent ? "text-orange-300" : "text-zinc-100"}`}>
        {score}<span className="text-sm text-zinc-600">/{maximum}</span>
      </div>
      <div className="mt-1 text-xs text-zinc-500">{label}</div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-white/5 px-2.5 py-1 text-zinc-300">{children}</span>;
}

function SignalCard({ label, value, description }: { label: string; value: string; description: string }) {
  return (
    <article className="rounded-xl border border-white/10 p-4">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-black text-zinc-100">{value}</p>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">{description}</p>
    </article>
  );
}

function ListCard({ title, empty, items }: { title: string; empty: string; items: string[] }) {
  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
      <h2 className="font-bold text-zinc-100">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">{empty}</p>
      ) : (
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-zinc-400">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </article>
  );
}

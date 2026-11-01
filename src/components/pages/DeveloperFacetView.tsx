import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import {
  LeaderboardClient,
  type LeaderboardLabels,
} from "@/components/LeaderboardClient";
import { FacetBoardPinFromQuery } from "@/components/FacetBoardPin";
import { RepoOverviewCard, type RepoOverviewLabels } from "@/components/RepoOverviewCard";
import { RepoPageBeacon } from "@/components/RepoPageBeacon";
import { ProjectRecommendations } from "@/components/ProjectRecommendations";
import { ExplorationBeacon } from "@/components/ExplorationBeacon";
import {
  ProjectAssessmentCard,
  type ProjectAssessmentCardLabels,
} from "@/components/ProjectAssessmentCard";
import {
  ProjectAssessmentDetails,
  type ProjectAssessmentDetailsLabels,
} from "@/components/ProjectAssessmentDetails";
import type { FacetType } from "@/lib/facets";
import { TIER_KEY } from "@/lib/tier";
import type { Tier } from "@/lib/types";
import { bcp47, localePath } from "@/lib/site";
import { JsonLd, breadcrumbJsonLd } from "@/components/JsonLd";
import { bucketHeadingKey, facetEncodedPath, type loadDeveloperFacet } from "@/lib/pages/developer-facet";
import type { Translator } from "@/lib/translator";

type FacetData = NonNullable<Awaited<ReturnType<typeof loadDeveloperFacet>>>;

/** Body of the /developers/[type]/[...value] page, shared by the Next app and apps/web (see BlogViews). */
export function DeveloperFacetView({
  locale,
  type,
  value,
  t,
  tl,
  tTier,
  tProjects,
  entries,
  overview,
  repoStarStanding,
  relatedProjects,
  assessment,
  treasureHistory,
  perFacetLimit,
}: FacetData & {
  locale: string;
  type: FacetType;
  value: string;
  /** "developers" namespace. */
  t: Translator;
  /** "leaderboard" namespace. */
  tl: Translator;
  /** "tiers" namespace. */
  tTier: Translator;
  /** "projectBoards" namespace. */
  tProjects: Translator;
}) {
  const localePrefix = localePath(locale, "/").replace(/\/$/, "");
  const encodedPath = facetEncodedPath(value);
  const breadcrumb = breadcrumbJsonLd([
    { name: t("heading"), path: `${localePrefix}/developers` },
    {
      name: t(bucketHeadingKey(type), { value }),
      path: `${localePrefix}/developers/${type}/${encodedPath}`,
    },
  ]);

  // Reuse the leaderboard card renderer verbatim (score view) — same entry shape,
  // same labels namespace — so the directory bucket looks like a board.
  const labels: LeaderboardLabels = {
    empty: t("empty"),
    prev: tl("prev"),
    next: tl("next"),
    pageJumpLabel: tl("pageJumpLabel"),
    collapse: tl("collapse"),
    viewDetail: tl("viewDetail", { username: "{username}" }),
    trendLabel: tl("trendLabel"),
    trendTitle: tl("trendTitle"),
    scoreLabel: tl("scoreLabel"),
    scoreTitle: tl("scoreTitle"),
    heatLabel: tl("heatLabel"),
    heatTitle: tl("heatTitle"),
    vsButton: tl("vsButton"),
  };
  const assessmentLabels: ProjectAssessmentCardLabels = {
    productScore: tProjects("productScore"),
    confidence: tProjects("confidence"),
    communityStrength: tProjects("communityStrength"),
    viewReport: tProjects("viewReport"),
    treasure: tProjects("boards.treasure"),
    classic: tProjects("boards.classic"),
    unranked: tProjects("boards.unranked"),
  };
  const assessmentDetailLabels: ProjectAssessmentDetailsLabels = {
    productScore: tProjects("productScore"),
    pain: tProjects("details.pain"),
    effectiveness: tProjects("details.effectiveness"),
    experience: tProjects("details.experience"),
    valueDensity: tProjects("details.valueDensity"),
    confidence: tProjects("confidence"),
    communityStrength: tProjects("communityStrength"),
    exposure: tProjects("details.exposure"),
    stars: tProjects("details.stars"),
    commit: tProjects("details.commit"),
    analysisTime: tProjects("details.analysisTime"),
    productContract: tProjects("details.productContract"),
    targetUsers: tProjects("details.targetUsers"),
    painStatement: tProjects("details.painStatement"),
    dimensionEvidence: tProjects("details.dimensionEvidence"),
    unknowns: tProjects("details.unknowns"),
    risks: tProjects("details.risks"),
    none: tProjects("details.none"),
    treasureHistory: tProjects("details.treasureHistory"),
    selectedAt: tProjects("details.selectedAt"),
    report: tProjects("details.report"),
    historyStatus: {
      active: tProjects("details.historyStatus.active"),
      graduated: tProjects("details.historyStatus.graduated"),
      removed: tProjects("details.historyStatus.removed"),
    },
  };

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-14 sm:py-20">
      <JsonLd data={breadcrumb} />
      <header className="mb-8">
        <Link
          href="/developers"
          className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
        >
          {t("backToDirectory")}
        </Link>
        <h1 className="mt-4 text-3xl font-black leading-tight tracking-tight text-zinc-100 sm:text-5xl">
          {t(bucketHeadingKey(type), { value })}
        </h1>
        <p className="mt-2 text-zinc-400">
          {t("bucketSubtitle", { limit: perFacetLimit })}
        </p>
      </header>

      {overview && (
        <>
          <RepoPageBeacon repo={overview.repo.name_with_owner} />
          <ExplorationBeacon
            item={{
              kind: "project",
              key: overview.repo.repo_key,
              title: overview.repo.name_with_owner,
              subtitle: overview.repo.description ?? overview.repo.language ?? undefined,
              href: `/developers/repo/${encodedPath}`,
            }}
          />
          <RepoOverviewCard
            overview={overview}
            starStanding={repoStarStanding}
            locale={bcp47(locale)}
            labels={{
              authoredBy: t("repoAuthoredBy"),
              contributors: t("repoContributors"),
              avgScore: t("repoAvgScore"),
              globalRank: (rank, total) => t("repoGlobalRank", { rank, total }),
              globalRankApprox: (rank, total) => t("repoGlobalRankApprox", { rank, total }),
              topAmong: (pct, floor) => t("repoTopAmong", { pct, floor }),
              rankNote: (asOf) => t("repoRankNote", { asOf }),
              tierLabels: Object.fromEntries(
                (Object.keys(TIER_KEY) as Tier[]).map((tier) => [
                  tier,
                  tTier(`${TIER_KEY[tier]}.name`),
                ]),
              ) as RepoOverviewLabels["tierLabels"],
            }}
          />
        </>
      )}

      {assessment && (
        <section className="mb-8 space-y-6" aria-label={tProjects("viewReport")}>
          <ProjectAssessmentCard
            assessment={assessment}
            labels={assessmentLabels}
            locale={locale}
          />
          <ProjectAssessmentDetails
            assessment={assessment}
            treasureHistory={treasureHistory}
            labels={assessmentDetailLabels}
            locale={locale}
          />
        </section>
      )}

      <Suspense fallback={null}>
        <FacetBoardPinFromQuery
          usernames={entries.map((e) => e.username)}
          facetValue={value}
        />
      </Suspense>

      <LeaderboardClient
        initialView="score"
        labels={labels}
        pageSize={20}
        scoreEntries={entries}
        heatEntries={[]}
        trendingEntries={[]}
      />

      {type === "repo" && <ProjectRecommendations projects={relatedProjects} />}

      <p className="mt-10 text-sm text-zinc-500">
        {t("apiCta")}{" "}
        <Link
          href="/docs"
          className="text-orange-300 underline-offset-2 hover:underline"
        >
          {t("apiCtaLink")}
        </Link>
      </p>
    </main>
  );
}

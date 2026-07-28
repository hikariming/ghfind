import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
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
import { getDevelopersByFacetCached } from "@/lib/developers";
import { DEVELOPERS_PER_FACET_LIMIT, getRepoOverview } from "@/lib/db";
import {
  getProjectAssessment,
  listTreasureHistory,
  ProjectAnalysisDatabaseError,
} from "@/lib/project-analysis-db";
import { getRelatedProjectsCached } from "@/lib/project-discovery";
import type { FacetType } from "@/lib/facets";
import { TIER_KEY } from "@/lib/tier";
import type { Tier } from "@/lib/types";
import { localeAlternates, localePath } from "@/lib/site";
import { JsonLd, breadcrumbJsonLd } from "@/components/JsonLd";

// Keep this long-tail route out of ISR. The URL space is ~10k buckets × 9
// locales, and verified crawlers overwhelmingly request each URL only once.
// Those requests already execute the page on an ISR MISS, then additionally
// pay to persist several HTML/RSC artifacts that are rarely read again. The
// underlying facet data remains Redis-cached, so dynamic rendering removes the
// durable ISR writes without turning every request into a database query.
//
// `?u=` is still resolved client-side by FacetBoardPinFromQuery, so this can be
// revisited if repeat human traffic ever outweighs crawler cold misses.
export const dynamic = "force-dynamic";

const FACET_TYPES: FacetType[] = ["language", "org", "repo"];

function parseFacetType(raw: string): FacetType | null {
  return (FACET_TYPES as string[]).includes(raw) ? (raw as FacetType) : null;
}

/** Rebuild the facet value from the catch-all path segments. A `repo` value is
 *  "owner/name" and so arrives as two segments (`/developers/repo/owner/name`) —
 *  a single dynamic segment would have %2F normalized away by the host and 404.
 *  language/org are single-segment. Each segment is decoded, then rejoined with
 *  "/" so it matches the stored `facet_value` exactly. */
function facetValueFromSegments(segments: string[] | undefined): string {
  return (segments ?? []).map((s) => decodeURIComponent(s)).join("/");
}

type BucketHeadingKey =
  | "languageBucketHeading"
  | "orgBucketHeading"
  | "repoBucketHeading";

function bucketHeadingKey(type: FacetType): BucketHeadingKey {
  if (type === "org") return "orgBucketHeading";
  if (type === "repo") return "repoBucketHeading";
  return "languageBucketHeading";
}

async function optionalProjectAssessment(type: FacetType, value: string) {
  if (type !== "repo") return { assessment: null, treasureHistory: [] };
  try {
    const assessment = await getProjectAssessment(value);
    const treasureHistory = assessment ? await listTreasureHistory(value) : [];
    return { assessment, treasureHistory };
  } catch (error) {
    if (error instanceof ProjectAnalysisDatabaseError) {
      return { assessment: null, treasureHistory: [] };
    }
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; type: string; value: string[] }>;
}): Promise<Metadata> {
  const { locale, type: rawType, value: rawValue } = await params;
  const type = parseFacetType(rawType);
  const value = facetValueFromSegments(rawValue);
  const t = await getTranslations({ locale, namespace: "developers" });
  const meta = await getTranslations({ locale, namespace: "meta" });
  if (!type) return { title: t("metaTitle") };
  const heading = t(bucketHeadingKey(type), { value });
  // Encode each segment separately so a `repo` value ("owner/name") keeps its
  // slash as a path separator — mirrors the sitemap so canonical == indexed URL.
  const encodedPath = value.split("/").map(encodeURIComponent).join("/");
  return {
    title: `${heading} · ${meta("siteName")}`,
    description: t("bucketMetaDescription", { value }),
    alternates: localeAlternates(locale, `/developers/${type}/${encodedPath}`),
  };
}

export default async function FacetBucketPage({
  params,
}: {
  params: Promise<{ locale: string; type: string; value: string[] }>;
}) {
  const { locale, type: rawType, value: rawValue } = await params;
  const type = parseFacetType(rawType);
  const value = facetValueFromSegments(rawValue);
  if (!type || !value) notFound();

  setRequestLocale(locale);
  const t = await getTranslations("developers");
  const tl = await getTranslations("leaderboard");
  const tTier = await getTranslations("tiers");
  const tProjects = await getTranslations("projects");

  // Project pages lead with a repo header + contributor-quality summary. Only
  // repo buckets have a repo entity; language/org buckets skip it. Null when the
  // repo isn't in the graph yet — the page then degrades to the plain list.
  const [overview, entries, relatedProjects, projectAnalysis] = await Promise.all([
    type === "repo" ? getRepoOverview(value) : Promise.resolve(null),
    getDevelopersByFacetCached(type, value),
    type === "repo" ? getRelatedProjectsCached(value) : Promise.resolve([]),
    optionalProjectAssessment(type, value),
  ]);
  const { assessment, treasureHistory } = projectAnalysis;

  // An empty bucket (probed/garbage value, or one that lost all members) is
  // thin content: rendering it would pay an ISR write per path × locale for a
  // page nobody indexes. 404 instead; repo buckets with a real overview but no
  // listed devs still render (the header is substance).
  if (entries.length === 0 && !overview) notFound();

  const localePrefix = localePath(locale, "/").replace(/\/$/, "");
  const encodedPath = value.split("/").map(encodeURIComponent).join("/");
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
          {t("bucketSubtitle", { limit: DEVELOPERS_PER_FACET_LIMIT })}
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
            labels={{
              authoredBy: t("repoAuthoredBy"),
              contributors: t("repoContributors"),
              avgScore: t("repoAvgScore"),
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

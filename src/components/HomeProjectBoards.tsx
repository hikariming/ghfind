import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { HomeSnapStrip } from "@/components/HomeSnapStrip";
import {
  ProjectAssessmentCard,
  type ProjectAssessmentCardLabels,
} from "@/components/ProjectAssessmentCard";
import { getGoPublicData } from "@/lib/go-backend.server";
import type { ProjectAssessment } from "@/lib/project-analysis-db";

const PREVIEW_LIMIT = 8;

/**
 * Homepage "project assessment" band — previews the top of the treasure
 * board (falling back to the all-analyses list while the board is small) as a
 * horizontal strip of the same assessment cards /projects uses. Reads Go
 * through an ISR-cached fetch so it survives the force-static homepage
 * prerender.
 */
export async function HomeProjectBoards({ locale }: { locale: string }) {
  const t = await getTranslations("projectBoards");
  const tCollections = await getTranslations("collections");
  let entries: ProjectAssessment[] = [];
  for (const board of ["treasure", "all"] as const) {
    const data = await getGoPublicData<{ entries: ProjectAssessment[] }>(
      `/api/project-boards?board=${board}&limit=${PREVIEW_LIMIT}&offset=0`,
      { revalidate: 3600 },
    );
    entries = data?.entries ?? [];
    // The treasure board is the editorial surface; only fall back to the
    // unranked list while treasure has too few entries to fill a strip.
    if (entries.length >= 4 || board === "all") break;
  }
  if (entries.length === 0) return null;

  const labels: ProjectAssessmentCardLabels = {
    productScore: t("productScore"),
    confidence: t("confidence"),
    communityStrength: t("communityStrength"),
    viewReport: t("viewReport"),
    treasure: t("boards.treasure"),
    classic: t("boards.classic"),
    unranked: t("boards.unranked"),
  };

  return (
    <section className="w-full">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-black tracking-tight text-zinc-100 sm:text-2xl">
            {t("homeEyebrow")}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">{t("boardDescriptions.treasure")}</p>
        </div>
        <Link
          href="/projects"
          prefetch={false}
          className="shrink-0 text-sm text-zinc-400 underline-offset-4 transition-colors hover:text-zinc-200 hover:underline"
        >
          {tCollections("viewAll")} →
        </Link>
      </div>
      <HomeSnapStrip>
        {entries.map((assessment) => (
          <div
            key={assessment.repoKey}
            className="flex w-[20rem] shrink-0 snap-start sm:w-[22rem]"
          >
            <ProjectAssessmentCard
              assessment={assessment}
              labels={labels}
              locale={locale}
            />
          </div>
        ))}
      </HomeSnapStrip>
    </section>
  );
}

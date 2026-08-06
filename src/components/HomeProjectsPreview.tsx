import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { ProjectCard } from "@/components/ProjectCard";
import { getGoProjects } from "@/lib/go-projects.server";

const PREVIEW_LIMIT = 8;

/**
 * 项目推流分析 slot — this section is reserved for the upcoming personalized
 * project recommendation feed. Until that engine ships it previews live
 * /projects data (momentum sort, so the cards rotate as attention shifts),
 * which means the layout, the Redis cache path and the click tracking are
 * already real when the feed lands here.
 *
 * Rendered as a horizontal snap-scroll strip so the band fills the width of
 * the main column without stacking empty vertical space; falls back to the
 * quality board when momentum has no ranked repos yet.
 */
export async function HomeProjectsPreview() {
  const t = await getTranslations("projects");
  const tCollections = await getTranslations("collections");
  let projects = await getGoProjects({
    sort: "momentum",
    language: null,
    limit: PREVIEW_LIMIT,
    offset: 0,
    revalidate: 3600,
  });
  if (projects.length === 0) {
    projects = await getGoProjects({
      sort: "quality",
      language: null,
      limit: PREVIEW_LIMIT,
      offset: 0,
      revalidate: 3600,
    });
  }
  if (projects.length === 0) return null;

  return (
    <section className="w-full">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-black tracking-tight text-zinc-100 sm:text-2xl">
            {t("eyebrow")}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">{t("subtitle")}</p>
        </div>
        <Link
          href="/projects/discovery"
          prefetch={false}
          className="shrink-0 text-sm text-zinc-400 underline-offset-4 transition-colors hover:text-zinc-200 hover:underline"
        >
          {tCollections("viewAll")} →
        </Link>
      </div>
      <div className="relative -mx-5 mt-5 sm:-mx-6">
        <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-3 [scrollbar-color:var(--color-zinc-500)_transparent] [scrollbar-width:thin] sm:px-6 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-500/50 [&::-webkit-scrollbar-track]:bg-transparent">
          {projects.map((project, index) => (
            <div
              key={project.repo.repo_key}
              className="flex w-[19rem] shrink-0 snap-start sm:w-[21rem]"
            >
              <ProjectCard
                project={project}
                position={index + 1}
              />
            </div>
          ))}
        </div>
        {/* Edge fades hint that the strip scrolls; they sit on the page
            background so they track light/dark via --color-background. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-5 bg-gradient-to-r from-background to-transparent sm:w-6"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent sm:w-12"
        />
      </div>
    </section>
  );
}

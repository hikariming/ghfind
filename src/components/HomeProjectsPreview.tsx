import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { ProjectCard } from "@/components/ProjectCard";
import { getProjectsCached } from "@/lib/project-discovery";

const PREVIEW_LIMIT = 4;

/**
 * 项目推流分析 slot — this section is reserved for the upcoming personalized
 * project recommendation feed. Until that engine ships it previews live
 * /projects data (momentum sort, so the cards rotate as attention shifts),
 * which means the layout, the Redis cache path and the click tracking are
 * already real when the feed lands here.
 */
export async function HomeProjectsPreview() {
  const t = await getTranslations("projects");
  const tCollections = await getTranslations("collections");
  const projects = await getProjectsCached({
    sort: "momentum",
    language: null,
    limit: PREVIEW_LIMIT,
    offset: 0,
  });
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
          href="/projects"
          prefetch={false}
          className="shrink-0 text-sm text-zinc-400 underline-offset-4 transition-colors hover:text-zinc-200 hover:underline"
        >
          {tCollections("viewAll")} →
        </Link>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {projects.map((project, index) => (
          <ProjectCard
            key={project.repo.repo_key}
            project={project}
            position={index + 1}
          />
        ))}
      </div>
    </section>
  );
}

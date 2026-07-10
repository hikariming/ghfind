import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ProjectCard } from "@/components/ProjectCard";
import { ProjectControls } from "@/components/ProjectControls";
import { getFacetCategoriesCached } from "@/lib/developers";
import { getProjectsCached } from "@/lib/project-discovery";
import {
  normalizeProjectLanguage,
  parseProjectPage,
  parseProjectSort,
} from "@/lib/projects";
import { localeAlternates } from "@/lib/site";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 18;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "projects" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/projects"),
  };
}

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ sort?: string | string[]; language?: string | string[]; page?: string | string[] }>;
}) {
  const { locale } = await params;
  const query = (await searchParams) ?? {};
  setRequestLocale(locale);
  const t = await getTranslations("projects");
  const sort = parseProjectSort(Array.isArray(query.sort) ? query.sort[0] : query.sort);
  const language = normalizeProjectLanguage(query.language);
  const page = parseProjectPage(query.page);
  const offset = (page - 1) * PAGE_SIZE;
  const [result, languageFacets] = await Promise.all([
    getProjectsCached({ sort, language, limit: PAGE_SIZE + 1, offset }),
    getFacetCategoriesCached("language"),
  ]);
  const projects = result.slice(0, PAGE_SIZE);
  const hasNext = result.length > PAGE_SIZE;
  const languages = languageFacets.slice(0, 12).map((facet) => facet.value);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 py-14 sm:px-6 sm:py-20">
      <header className="mb-8 max-w-3xl">
        <p className="text-sm font-bold uppercase tracking-wide text-orange-400">{t("eyebrow")}</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-zinc-100 sm:text-5xl">
          {t("heading")}
        </h1>
        <p className="mt-3 text-base leading-relaxed text-zinc-400 sm:text-lg">{t("subtitle")}</p>
      </header>

      <ProjectControls
        sort={sort}
        language={language}
        page={page}
        hasNext={hasNext}
        languages={languages}
      />

      {projects.length > 0 ? (
        <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label={t("listLabel")}> 
          {projects.map((project, index) => (
            <ProjectCard key={project.repo.repo_key} project={project} position={offset + index + 1} />
          ))}
        </section>
      ) : (
        <section className="mt-6 rounded-2xl border border-dashed border-white/10 px-6 py-16 text-center">
          <h2 className="text-lg font-bold text-zinc-200">{t("emptyTitle")}</h2>
          <p className="mt-2 text-sm text-zinc-500">{t("emptyBody")}</p>
        </section>
      )}
    </main>
  );
}

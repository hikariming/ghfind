import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  DevelopersDiscovery,
  type DiscoveryCategory,
  type DiscoveryPreset,
} from "@/components/DevelopersDiscovery";
import { getFacetCategoriesCached } from "@/lib/developers";
import type { FacetType } from "@/lib/facets";
import type { FacetCategory } from "@/lib/db";
import { localeAlternates } from "@/lib/site";

// Everything the directory reads is served from Redis (cache-aside + in-process
// single-flight in lib/developers.ts), so the expensive GROUP BY runs at most
// once per 10-min TTL. force-dynamic here just means "render from that cache",
// never a live DB query per visit.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "developers" });
  const meta = await getTranslations({ locale, namespace: "meta" });
  return {
    title: `${t("metaTitle")} · ${meta("siteName")}`,
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/developers"),
  };
}

function withFacetMetadata(
  type: FacetType,
  categories: FacetCategory[],
  countLabel: (count: number) => string,
): DiscoveryCategory[] {
  return categories.map((c) => ({
    type,
    value: c.value,
    count: c.count,
    countText: countLabel(c.count),
  }));
}

export default async function DevelopersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("developers");

  const [languages, orgs, projectsAll] = await Promise.all([
    getFacetCategoriesCached("language"),
    getFacetCategoriesCached("org"),
    getFacetCategoriesCached("repo"),
  ]);
  // The repo axis has far more buckets (one per notable project) than languages
  // or orgs, and they're already ordered most-contributors-first — show only the
  // busiest head so the grid stays scannable instead of a wall of 100 pills.
  const projects = projectsAll.slice(0, 48);
  const countLabel = (count: number) => t("count", { count });
  const searchCategories = {
    language: withFacetMetadata("language", languages, countLabel),
    repo: withFacetMetadata("repo", projectsAll, countLabel),
    org: withFacetMetadata("org", orgs, countLabel),
  };
  const browseCategories = {
    language: searchCategories.language,
    repo: withFacetMetadata("repo", projects, countLabel),
    org: searchCategories.org,
  };
  const presets: DiscoveryPreset[] = [
    { id: "ai-builders", label: t("presetAiBuilders"), query: t("presetAiBuildersQuery") },
    { id: "infra", label: t("presetInfra"), query: t("presetInfraQuery") },
    { id: "frontend", label: t("presetFrontend"), query: t("presetFrontendQuery") },
    { id: "data", label: t("presetData"), query: t("presetDataQuery") },
  ];

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-14 sm:py-20">
      <header className="mb-10">
        <h1 className="text-3xl font-black leading-tight tracking-tight text-zinc-100 sm:text-5xl">
          {t("heading")}
        </h1>
        <p className="mt-3 max-w-2xl text-zinc-400">{t("subtitle")}</p>
      </header>

      <DevelopersDiscovery
        browseCategories={browseCategories}
        searchCategories={searchCategories}
        labels={{
          searchLabel: t("searchLabel"),
          searchPlaceholder: t("searchPlaceholder"),
          clearSearch: t("clearSearch"),
          searchResultsTitle: t("searchResultsTitle"),
          browseTitle: t("browseTitle"),
          emptySearchResults: t("emptySearchResults"),
          emptyBrowseResults: t("emptyCategories"),
          aiLoading: t("aiLoading"),
          aiFallback: t("aiFallback"),
          aiUnavailable: t("aiUnavailable"),
          aiSummaryTitle: t("aiSummaryTitle"),
          aiDevelopersTitle: t("aiDevelopersTitle"),
          promptTitle: t("promptTitle"),
          typeLabels: {
            language: t("languageType"),
            repo: t("repoType"),
            org: t("orgType"),
          },
          languagesTitle: t("languagesTitle"),
          projectsTitle: t("projectsTitle"),
          orgsTitle: t("orgsTitle"),
        }}
        presets={presets}
      />
    </main>
  );
}

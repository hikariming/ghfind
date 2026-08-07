import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { FacetType } from "@/lib/facets";
import { getGoFacetCategories, type GoFacetCategory } from "@/lib/go-developers.server";
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

function CategoryGrid({
  type,
  categories,
  countLabel,
}: {
  type: FacetType;
  categories: GoFacetCategory[];
  countLabel: (count: number) => string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {categories.map((c) => (
        <Link
          key={c.value}
          // Encode each path segment separately, then join with "/". For `repo`
          // the value is "owner/name" → two segments (matches the catch-all
          // bucket route); for language/org it stays a single segment (e.g. "C++"
          // → "C%2B%2B"). Never percent-encode the separating slash itself.
          href={`/developers/${type}/${c.value
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/")}`}
          className="group flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-sm transition-colors hover:border-white/20 hover:bg-white/[0.07]"
        >
          <span className="font-semibold text-zinc-100">{c.value}</span>
          <span className="tabular-nums text-xs text-zinc-500 group-hover:text-zinc-400">
            {countLabel(c.count)}
          </span>
        </Link>
      ))}
    </div>
  );
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
    getGoFacetCategories("language"),
    getGoFacetCategories("org"),
    getGoFacetCategories("repo"),
  ]);
  // The repo axis has far more buckets (one per notable project) than languages
  // or orgs, and they're already ordered most-contributors-first — show only the
  // busiest head so the grid stays scannable instead of a wall of 100 pills.
  const projects = projectsAll.slice(0, 48);
  const countLabel = (count: number) => t("count", { count });
  const isEmpty =
    languages.length === 0 && orgs.length === 0 && projects.length === 0;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-14 sm:py-20">
      <header className="mb-10">
        <h1 className="text-3xl font-black leading-tight tracking-tight text-zinc-100 sm:text-5xl">
          {t("heading")}
        </h1>
        <p className="mt-3 max-w-2xl text-zinc-400">{t("subtitle")}</p>
      </header>

      {isEmpty ? (
        <p className="text-zinc-500">{t("emptyCategories")}</p>
      ) : (
        <div className="flex flex-col gap-10">
          {languages.length > 0 && (
            <section>
              <h2 className="mb-4 text-lg font-black text-zinc-200">
                {t("languagesTitle")}
              </h2>
              <CategoryGrid type="language" categories={languages} countLabel={countLabel} />
            </section>
          )}
          {projects.length > 0 && (
            <section>
              <h2 className="mb-4 text-lg font-black text-zinc-200">
                {t("projectsTitle")}
              </h2>
              <CategoryGrid type="repo" categories={projects} countLabel={countLabel} />
            </section>
          )}
          {orgs.length > 0 && (
            <section>
              <h2 className="mb-4 text-lg font-black text-zinc-200">{t("orgsTitle")}</h2>
              <CategoryGrid type="org" categories={orgs} countLabel={countLabel} />
            </section>
          )}
        </div>
      )}
    </main>
  );
}

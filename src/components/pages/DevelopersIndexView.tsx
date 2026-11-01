import { Link } from "@/i18n/navigation";
import type { FacetType } from "@/lib/facets";
import type { GoFacetCategory } from "@/lib/go-developers.server";
import type { Translator } from "@/lib/translator";

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

/** Body of the /developers page, shared by the Next app and apps/web (see BlogViews). */
export function DevelopersIndexView({
  t,
  languages,
  orgs,
  projects,
}: {
  t: Translator;
  languages: GoFacetCategory[];
  orgs: GoFacetCategory[];
  projects: GoFacetCategory[];
}) {
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

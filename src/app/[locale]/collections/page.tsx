import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { listCollections, pickText } from "@/lib/collections";
import { bcp47, localeAlternates } from "@/lib/site";

// Fully static: pure fs reads, prerendered per locale at build time — zero
// function invocations and zero ISR writes, no matter how hard crawlers hit it.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "collections" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/collections"),
  };
}

export default async function CollectionsIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("collections");
  const collections = listCollections();
  const dateFmt = new Intl.DateTimeFormat(bcp47(locale), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-14 sm:px-6 sm:py-20">
      <header className="max-w-3xl">
        <p className="text-sm font-bold uppercase tracking-wide text-orange-400">
          {t("eyebrow")}
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-zinc-100 sm:text-5xl">
          {t("heading")}
        </h1>
        <p className="mt-3 text-zinc-400">{t("subtitle")}</p>
      </header>

      <div className="mt-10 flex flex-col gap-6">
        {collections.map((collection) => (
          <article key={collection.slug}>
            <Link
              href={`/collections/${collection.slug}`}
              prefetch={false}
              className="group block rounded-2xl border border-white/10 bg-white/[0.035] p-6 transition-colors hover:border-white/20 hover:bg-white/[0.055]"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-orange-500/10 px-2.5 py-1 font-semibold text-orange-200">
                  {t(`type.${collection.type}`)}
                </span>
                {collection.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-white/10 px-2 py-0.5 text-zinc-500"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <h2 className="mt-3 text-xl font-bold text-zinc-100 group-hover:text-white sm:text-2xl">
                {pickText(collection.title, locale)}
              </h2>
              <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-zinc-400">
                {pickText(collection.intro, locale)}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-zinc-500">
                <time dateTime={collection.publishedAt}>
                  {t("publishedOn", {
                    date: dateFmt.format(new Date(collection.publishedAt)),
                  })}
                </time>
                <span aria-hidden>·</span>
                <span>{t("itemCount", { count: collection.items.length })}</span>
              </div>
            </Link>
          </article>
        ))}
        {collections.length === 0 && <p className="text-zinc-500">{t("empty")}</p>}
      </div>
    </main>
  );
}

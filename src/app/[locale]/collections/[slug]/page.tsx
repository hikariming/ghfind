import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { JsonLd, curatedCollectionJsonLd } from "@/components/JsonLd";
import { CollectionItemCard } from "@/components/collections/CollectionItemCard";
import { getCollection, getCollectionSlugs, pickText } from "@/lib/collections";
import { bcp47, localeAlternates, localePath } from "@/lib/site";

// Fully static: pure fs reads, prerendered per slug × locale at build time —
// a collection landing on a hot feed never touches a function invocation.
export const dynamicParams = false;

export function generateStaticParams() {
  return getCollectionSlugs().flatMap((slug) =>
    routing.locales.map((locale) => ({ locale, slug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const collection = getCollection(slug);
  if (!collection) return {};
  const title = pickText(collection.title, locale);
  const description = pickText(collection.intro, locale);
  const url = localePath(locale, `/collections/${slug}`);
  return {
    title: `${title} · ghfind`,
    description,
    alternates: localeAlternates(locale, `/collections/${slug}`),
    openGraph: {
      title,
      description,
      type: "article",
      url,
      publishedTime: collection.publishedAt,
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function CollectionPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const collection = getCollection(slug);
  if (!collection) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("collections");
  const dateFmt = new Intl.DateTimeFormat(bcp47(locale), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-14 sm:px-6 sm:py-20">
      <JsonLd
        data={curatedCollectionJsonLd({
          slug,
          locale,
          name: pickText(collection.title, locale),
          description: pickText(collection.intro, locale),
          datePublished: collection.publishedAt,
          items: collection.items.map((item) => ({
            kind: item.kind,
            name: item.kind === "repo" ? item.id : `@${item.id}`,
            path:
              item.kind === "repo"
                ? localePath(locale, `/developers/repo/${item.id}`)
                : localePath(locale, `/u/${item.id}`),
          })),
        })}
      />

      <nav className="text-sm">
        <Link
          href="/collections"
          prefetch={false}
          className="text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
        >
          ← {t("backToCollections")}
        </Link>
      </nav>

      <header className="mt-6 max-w-3xl">
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
        <h1 className="mt-3 text-3xl font-black tracking-tight text-zinc-100 sm:text-4xl">
          {pickText(collection.title, locale)}
        </h1>
        <p className="mt-4 leading-relaxed text-zinc-400">
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
      </header>

      <div className="mt-10 flex flex-col gap-5">
        {collection.items.map((item, i) => (
          <CollectionItemCard
            key={`${item.kind}:${item.id}`}
            item={item}
            locale={locale}
            position={i + 1}
          />
        ))}
      </div>

      <p className="mt-10 text-xs leading-relaxed text-zinc-600">{t("dataNote")}</p>
    </main>
  );
}

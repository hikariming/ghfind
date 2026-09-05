import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCollectionArticle, listCollections, pickText } from "@/lib/collections";
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
  const tBlog = await getTranslations("blog");
  const collections = listCollections();
  const dateFmt = new Intl.DateTimeFormat(bcp47(locale), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-14 sm:px-6 sm:py-20">
      <header className="max-w-3xl">
        <p className="text-sm font-medium tracking-wide text-muted-foreground">
          {t("eyebrow")}
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-zinc-100 sm:text-5xl">
          {t("heading")}
        </h1>
        <p className="mt-3 text-zinc-400">{t("subtitle")}</p>
      </header>

      <div className="mt-10 flex flex-col gap-6">
        {collections.map((collection) => {
          const article =
            collection.bodyLocales.length > 0
              ? getCollectionArticle(collection.slug, locale)
              : null;
          const avatarOwner = collection.subject
            ? collection.subject.kind === "repo"
              ? collection.subject.id.split("/")[0]
              : collection.subject.id
            : null;
          return (
            <article key={collection.slug}>
              <Link
                href={`/collections/${collection.slug}`}
                prefetch={false}
                className="collection-index-entry group block"
              >
                <div className="flex items-start gap-4">
                  {avatarOwner && (
                    // eslint-disable-next-line @next/next/no-img-element -- GitHub avatar; the image optimizer would just add Vercel cost
                    <img
                      src={`https://github.com/${avatarOwner}.png?size=112`}
                      alt=""
                      loading="lazy"
                      className="mt-1 h-12 w-12 shrink-0 rounded-xl"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-muted-foreground">
                        {t(`type.${collection.type}`)}
                      </span>
                      {collection.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground"
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
                      {article && (
                        <>
                          <span aria-hidden>·</span>
                          <span>
                            {tBlog("readingTime", { minutes: article.readingMinutes })}
                          </span>
                        </>
                      )}
                      {collection.items.length > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <span>{t("itemCount", { count: collection.items.length })}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            </article>
          );
        })}
        {collections.length === 0 && <p className="text-zinc-500">{t("empty")}</p>}
      </div>
    </main>
  );
}

import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { CollectionPromoCard } from "@/components/CollectionPromoCard";
import { getCollectionArticle, listCollections, pickText } from "@/lib/collections";
import { bcp47 } from "@/lib/site";

/**
 * Homepage "editor's picks" band — sits between the scan form and the
 * leaderboard (the slot the continue-exploring strip used to hold). Fully
 * static: collections are fs reads inside the force-static homepage shell, so
 * the editorial surface gets homepage distribution at zero runtime cost.
 */
export async function HomeCollections({ locale }: { locale: string }) {
  const collections = listCollections().slice(0, 3);
  if (collections.length === 0) return null;
  const t = await getTranslations("collections");
  const tBlog = await getTranslations("blog");
  const dateFmt = new Intl.DateTimeFormat(bcp47(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <section className="mt-16 w-full max-w-6xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-zinc-100 sm:text-3xl">
            {t("eyebrow")}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">{t("subtitle")}</p>
        </div>
        <Link
          href="/collections"
          prefetch={false}
          className="shrink-0 text-sm text-zinc-400 underline-offset-4 transition-colors hover:text-zinc-200 hover:underline"
        >
          {t("viewAll")} →
        </Link>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {collections.map((collection, i) => {
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
            <CollectionPromoCard
              key={collection.slug}
              slug={collection.slug}
              position={i + 1}
              title={pickText(collection.title, locale)}
              intro={pickText(collection.intro, locale)}
              typeLabel={t(`type.${collection.type}`)}
              avatarUrl={
                avatarOwner ? `https://github.com/${avatarOwner}.png?size=112` : null
              }
              metaLine={[
                dateFmt.format(new Date(collection.publishedAt)),
                article
                  ? tBlog("readingTime", { minutes: article.readingMinutes })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          );
        })}
      </div>
    </section>
  );
}
